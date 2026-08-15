/**
 * contractMigration の記録が、schema の実物とずれていないことを機械で確かめる。
 *
 * ## なぜ要るか
 *
 * v0.4.0 までの contractMigration は**手で書いた散文だった**。そして腐っていた。
 *
 *   "field": "provenance.inputFiles[].role に \"input-scope\" を追加"   ← 項目名の欄に日本語の文
 *   "introducedIn": "v0.1.2 (追加のみ)"                                 ← 存在しない tag
 *
 * さらに、**「版を据え置いたまま変えた」という事実そのものが記録されていなかった。**
 * addedFields に並ぶだけで、v2 と同時に入ったのか、v2 のあと据え置いたまま入れたのかが
 * 区別できない。まさに今回問題になっている情報が落ちていた。
 *
 * so 記録を「そう書いた」ではなく「**schema 実物とこう一致した**」にする。
 *
 * ## 4 つの検査
 *
 *   ① pointer 実在   changes[].schemaPointer が新旧いずれかの schema に実在する
 *   ② 判定の一致     その 2 つの schema へ条文の判定器を当て、policyVerdict と effect が一致する
 *   ③ 網羅           判定器が出した差分のうち、記録に無いものがあれば落ちる
 *                    （+ 全 tag 対を走査して、据え置き違反が history に載っていること）
 *   ④ 据置きゼロ     v0.5.0 以降に versionWasHeld:true が現れたら落ちる
 *
 * ## 変異は検査の外側から入れる
 *
 * 記録側だけを叩く変異では「記録が実物に追随しているか」を確かめられない。
 * **schema を書き換えて記録が追随しないこと**も見る（下の「変異」）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
import { diffSchemaObjects, resolvePointer } from '../scripts/schemaLanguageDiff.mjs'
import { mustBeNonEmpty } from './_must'

const ROOT = resolve(__dirname, '..')
const VALUES = JSON.parse(readFileSync(resolve(ROOT, 'contract-migration.v1.json'), 'utf8'))
const MIGRATIONS: Record<string, any> = VALUES.migrations

/**
 * この release より新しい記録は working tree から読む（tag がまだ無い）。
 *
 * **手で書かない（v0.6.17・外部監査 P0）。**v0.6.16 までここは `'v0.5.0'` の直書きで、
 * **11 版のあいだ動かないまま**だった。④「据え置きゼロ」は `shippedIn >= UNRELEASED` で
 * 絞るので、床が古いほど広く見えて安全側に見えるが、**準備中の版を tag から読もうとして
 * 落ちる**ため、新しい記録を足せない。準備中の版は `package.json` が知っている。
 */
const UNRELEASED = `v${(JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { version: string }).version}`

/**
 * **版数は数で比べる（v0.6.17）。**
 * ④ は `shippedIn >= UNRELEASED` で「新しく増えた違反」を絞る。
 * 文字列比較のままだと **`'v0.6.9' >= 'v0.6.17'` が `true`** になり、
 * 版が 2 桁へ入った時点で過去の記録を「新しい違反」と誤検出する。
 * v0.6.16 までは `UNRELEASED` が固定値だったので誰も踏まなかったが、
 * `package.json` から引くようにした以上、この比較も効くようになる。
 */
const vnum = (v: string) => v.replace(/^v/, '').split('.').map(Number)
const atOrAfter = (a: string, b: string) => {
  const [x, y] = [vnum(a), vnum(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return true
}

/**
 * **同じ問い合わせで git を何度も起動しない（2026-08-11）。**
 *
 * `tagExists` は 1 回 10.5ms かかり、`loadSchema` の呼び出しごとに走っていた。
 * 実測: この file の `it.each` だけで **loadSchema 34 回 → git 起動 68 回**、
 * うち一意な `(release, path)` は 28 通り・一意な tag は 7 個しかない。
 * 変異の試験も同じ組を読み直すので、実際にはさらに重なる。
 *
 * **数えている値（`readFromGit` / `readFromTree`）は呼び出し回数のまま**にする
 * ——「この検査は tag の実物を読んだか」を見るのが目的なので、
 * 覚えたぶんを引くと、その検査のほうが空振りになる。
 */
const tagExistsCache = new Map<string, boolean>()
const tagExists = (t: string) => {
  const hit = tagExistsCache.get(t)
  if (hit !== undefined) return hit
  let ok: boolean
  try {
    execFileSync('git', ['rev-parse', '--verify', `${t}^{tag}`], { cwd: ROOT, stdio: 'ignore' })
    ok = true
  } catch {
    ok = false
  }
  tagExistsCache.set(t, ok)
  return ok
}

let readFromGit = 0
let readFromTree = 0
/**
 * `${release}:${path}` → 読んだ**生テキスト**。同じ blob を 2 度取らない。
 *
 * **parse 済みのオブジェクトを覚えてはいけない。**下の `mutatedLoad` は
 * `loadSchema` が返したオブジェクトを**その場で書き換える**ので、
 * 共有すると 1 つの変異が後続の試験へ漏れる（＝試験どうしが干渉する）。
 * 文字列で覚えて毎回 parse すれば、**節約できるのは git の起動だけ**になる。
 */
const blobCache = new Map<string, string>()

/** release 時点の schema を読む。**取れなければ落とす**（skip すると検査ごと消える） */
function loadSchema(release: string, path: string): any {
  if (tagExists(release)) {
    readFromGit++
    const key = `${release}:${path}`
    let raw = blobCache.get(key)
    if (raw === undefined) {
      raw = execFileSync('git', ['show', key], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
      if (!raw.trim()) throw new Error(`${key} が空`)
      blobCache.set(key, raw)
    }
    return JSON.parse(raw)
  }
  if (release !== UNRELEASED) throw new Error(`tag ${release} が無い。git fetch --tags すること`)
  const p = resolve(ROOT, path)
  if (!existsSync(p)) throw new Error(`${path} が作業ツリーに無い`)
  readFromTree++
  return JSON.parse(readFileSync(p, 'utf8'))
}

const EFFECT_OF: Record<string, string> = { WIDEN: 'WIDEN', NARROW: 'NARROW', UNDEC: 'UNDECIDABLE' }
const covers = (recorded: string, fact: string) => fact === recorded || fact.startsWith(`${recorded}/`)

interface Entry {
  shippedIn: string
  previousRelease: string
  previousSchemaPath: string
  currentSchemaPath: string
  versionWasHeld: boolean
  policyVerdict: string
  changes: { kind: string, effect: string, schemaPointer: string }[]
}

/** 1 つの history 項目を検査する。**問題を配列で返す**（空なら合格） */
function checkEntry(entry: Entry, load: typeof loadSchema): string[] {
  const problems: string[] = []
  const oldS = load(entry.previousRelease, entry.previousSchemaPath)
  const newS = load(entry.shippedIn, entry.currentSchemaPath)
  const r = diffSchemaObjects(oldS, newS)

  // ① pointer 実在
  for (const c of entry.changes) {
    const inOld = resolvePointer(oldS, c.schemaPointer) !== undefined
    const inNew = resolvePointer(newS, c.schemaPointer) !== undefined
    if (!inOld && !inNew) problems.push(`① pointer が新旧どちらにも実在しない: ${c.schemaPointer}`)
  }

  // ② 判定の一致
  if (r.verdict !== entry.policyVerdict) {
    problems.push(`② policyVerdict が実物と違う: 記録 ${entry.policyVerdict} / 実物 ${r.verdict}`)
  }
  for (const c of entry.changes) {
    const covered = r.facts.filter((f: any) => covers(c.schemaPointer, f.pointer))
    if (covered.length === 0) {
      problems.push(`② 記録した変更に対応する差分が実物に無い: ${c.schemaPointer}`)
      continue
    }
    const effects = new Set(covered.map((f: any) => EFFECT_OF[f.kind]))
    if (!effects.has(c.effect)) {
      problems.push(`② effect が実物と違う: ${c.schemaPointer} 記録 ${c.effect} / 実物 ${[...effects].join(',')}`)
    }
  }

  // ③ 網羅
  for (const f of r.facts as any[]) {
    if (!entry.changes.some((c) => covers(c.schemaPointer, f.pointer))) {
      problems.push(`③ 実物の差分が記録に無い: ${f.kind} ${f.pointer} (${f.detail})`)
    }
  }
  return problems
}

const ALL_ENTRIES: { id: string, entry: Entry }[] = Object.entries(MIGRATIONS).flatMap(
  ([id, m]: [string, any]) => m.history.map((entry: Entry) => ({ id, entry })),
)

describe('contractMigration ①②③ 記録と schema 実物の突き合わせ', () => {
  it('history が空でない', () => {
    mustBeNonEmpty(ALL_ENTRIES, 'contractMigration の history 項目')
    expect(ALL_ENTRIES.length, '6 本ぶんの履歴').toBeGreaterThanOrEqual(15)
  })

  it.each(ALL_ENTRIES.map((e) => [`${e.id} ${e.entry.previousRelease}→${e.entry.shippedIn}`, e] as const))(
    '%s',
    (_n, { entry }) => {
      const problems = checkEntry(entry, loadSchema)
      expect(problems, problems.join('\n')).toEqual([])
    },
  )

  it('検査は tag の実物を読んでいる（作業ツリーだけを読んでいない）', () => {
    // readFromGit が 0 なら、上の検査はすべて作業ツリー同士を比べていたことになる
    expect(readFromGit, 'tag から読んだ回数').toBeGreaterThan(10)

    /**
     * **release する前と後で、読み元が変わる。**
     *   release 前: tag が無いので、その版の記録は作業ツリーから読む
     *   release 後: tag があるので tag から読む（こちらのほうが強い）
     * どちらでも空振りしないよう、**その時点で正しいほうを名指しで検査する。**
     *
     * ## **契約を変えない版もある（v0.6.18）**
     *
     * v0.6.17 まで、この検査は「その版には必ず記録がある」と決め打っていた。
     * だが**schema を 1 本も変えない版**は正常にありうる——v0.6.18 がそれで、
     * core / CLI 分離は判定にも契約にも触っていない。記録は 0 件になる。
     *
     * ⚠️ **一度、片方の枝だけ直した。**tag を打つ前は「作業ツリーから読むはず」の枝を
     * 通るので手元では通り、**tag を打った直後の CI で「記録が 1 件も無い」で落ちた**
     * ——同じ決め打ちが `tagExists` 側にも書いてあった。
     * **同じ問いの答えを 2 か所に書いていた。**記録の有無で先に分け、
     * そのあとで読み元を見る形にする。
     */
    const unreleasedEntries = ALL_ENTRIES.filter(({ entry }) => entry.shippedIn === UNRELEASED)
    if (unreleasedEntries.length === 0) {
      /**
       * **記録が 0 件であることを、黙って通さず名指しで確かめる。**
       * 読む対象が無いのだから、作業ツリーからも読んでいないはず。
       */
      expect(readFromTree, `${UNRELEASED} の記録が無いのに作業ツリーを読んでいる`).toBe(0)
    } else if (tagExists(UNRELEASED)) {
      expect(readFromTree, `${UNRELEASED} の tag があるのに作業ツリーを読んでいる`).toBe(0)
    } else {
      expect(readFromTree, `${UNRELEASED} の tag が無いので作業ツリーから読むはず`).toBeGreaterThan(0)
    }
  })
})

describe('contractMigration 正本と schema の対応', () => {
  const PAIRS: readonly (readonly [string, string])[] = [
    ['half-plug-topology-profile.v3', 'schemas/half-plug-topology-profile.v3.schema.json'],
    ['event-sensitivity.v2', 'schemas/event-sensitivity.v2.schema.json'],
    ['topology-robustness.v3', 'schemas/topology-robustness.v3.schema.json'],
    ['source-input-manifest.v2', 'schemas/source-input-manifest.v2.schema.json'],
    ['validation-results.v3', 'schemas/validation-results.v3.schema.json'],
    ['test-counts.v2', 'schemas/test-counts.v2.schema.json'],
  ]

  it('正本の値が、6 本すべての contractMigration 部分に適合する', () => {
    expect(PAIRS.length).toBe(6)
    for (const [id, schemaPath] of PAIRS) {
      const sub = JSON.parse(readFileSync(resolve(ROOT, schemaPath), 'utf8')).properties.contractMigration
      const validate = new Ajv({ allErrors: true, strict: false }).compile(sub)
      const ok = validate(MIGRATIONS[id])
      expect(ok, `${id}: ${JSON.stringify(validate.errors?.slice(0, 3))}`).toBe(true)
    }
  })

  it('6 本の contractMigration は const 4 つ以外まったく同じ形である', () => {
    // 形が枝分かれすると、下流は artifact ごとに別の読み方を書くことになる
    const strip = (s: any) => {
      const c = JSON.parse(JSON.stringify(s))
      for (const k of ['schemaId', 'previousSchemaId', 'fromSchemaVersion', 'toSchemaVersion']) delete c.properties[k]
      return JSON.stringify(c)
    }
    const shapes = new Set(
      PAIRS.map(([, p]) => strip(JSON.parse(readFileSync(resolve(ROOT, p), 'utf8')).properties.contractMigration)),
    )
    expect(shapes.size, `形が ${shapes.size} 種類に分かれている`).toBe(1)
  })

  it('artifact が正本と同じ値を持っている（生成器が独自に書いていない）', () => {
    const ART: readonly (readonly [string, string])[] = [
      ['half-plug-topology-profile.v3', 'artifacts/half_plug_topology_profile.v3.trs_jack_trs.json'],
      ['half-plug-topology-profile.v3', 'artifacts/half_plug_topology_profile.v3.trs_jack_trrs.json'],
      ['event-sensitivity.v2', 'artifacts/sensitivity.trs_jack_trs.json'],
      ['event-sensitivity.v2', 'artifacts/sensitivity.trs_jack_trrs.json'],
      ['topology-robustness.v3', 'artifacts/topology-robustness.trs_jack_trrs.json'],
      ['source-input-manifest.v2', 'artifacts/source-input-manifest.json'],
      ['validation-results.v3', 'artifacts/validation-results.json'],
      ['test-counts.v2', 'artifacts/test_counts.json'],
    ]
    let checked = 0
    for (const [id, p] of ART) {
      const full = resolve(ROOT, p)
      if (!existsSync(full)) throw new Error(`${p} が無い。生成し直すこと`)
      const a = JSON.parse(readFileSync(full, 'utf8'))
      expect(JSON.stringify(a.contractMigration), `${p} の contractMigration が正本と違う`).toBe(JSON.stringify(MIGRATIONS[id]))
      checked++
    }
    expect(checked, '突き合わせた artifact 数').toBe(8)
  })
})

describe('contractMigration ④ 据え置きゼロ', () => {
  it('v0.5.0 以降に versionWasHeld:true が無い', () => {
    const bad = ALL_ENTRIES.filter(({ entry }) => atOrAfter(entry.shippedIn, UNRELEASED) && entry.versionWasHeld)
    expect(bad.map((b) => `${b.id} ${b.entry.shippedIn}`), '条文を破った回が新たに増えている').toEqual([])
  })

  /** **比較そのものの対照。**文字列比較なら 2 件目が通ってしまう */
  it('版数を数で比べている（2 桁になっても壊れない）', () => {
    expect(atOrAfter('v0.6.17', 'v0.6.17'), '同じ版').toBe(true)
    expect(atOrAfter('v0.6.16', 'v0.6.17'), '1 つ前').toBe(false)
    expect(atOrAfter('v0.6.9', 'v0.6.17'), '**文字列比較ならここが true になる**').toBe(false)
    expect(atOrAfter('v0.10.0', 'v0.9.0'), '**文字列比較ならここが false になる**').toBe(true)
    expect(atOrAfter('v1.0.0', 'v0.9.9'), 'major が上').toBe(true)
  })

  it('遡って記録した違反が実在する（④ が空振りでないこと）', () => {
    const held = ALL_ENTRIES.filter(({ entry }) => entry.versionWasHeld)
    // 過去の違反が 0 件なら、④ は「何も無いので通った」だけになる
    expect(held.length, '版を据え置いたまま契約を変えた回').toBeGreaterThanOrEqual(9)
    for (const { entry } of held) {
      expect((entry as any).schemaVersionShouldHaveBeen, `${entry.shippedIn}: 本来あるべきだった版が無い`).toBeTypeOf('number')
      expect((entry as any).recordedRetroactivelyIn, `${entry.shippedIn}: 遡って書いたことが記録されていない`).toBeTypeOf('string')
    }
  })
})

describe('contractMigration ③ 網羅（全 tag 対の走査）', () => {
  const TAGS = ['v0.1.0', 'v0.1.1', 'v0.2.0', 'v0.3.0', 'v0.4.0', 'v0.4.1']

  /**
   * **git の起動回数を 188 → 7 回に減らした（2026-08-11）。**
   *
   * この試験は 30 秒の上限に対して、**単独で 4.5 秒・全体と並列に回すと超える**ことがあった。
   * 遅いのは走査の量ではなく、**1 件ごとに git を起動していたこと**である。実測（待機中の機械）:
   *
   * ```
   * ls-tree        6 回    64ms
   * cat-file -e  104 回    ← 存在確認。ls-tree の結果に既に入っている
   * git show      78 回    ← blob の取得。一意な blob は 78 通り
   * 合計         188 回  2,037ms（1 起動あたり 10.8ms）
   * ```
   *
   * 同じ時間に tar / python を起動する試験も並列で走るので、
   * **起動あたりの待ち時間が伸びると、ここが最初に上限へ当たる。**
   * 上限を伸ばすと、遅い原因を残したまま次の release で同じことが起きる。
   *
   *   存在確認 → `ls-tree` の出力を tag ごとに持つ（**起動 0 回**）
   *   blob 取得 → `cat-file --batch` へまとめて流す（**起動 1 回**）
   *
   * **走査する組み合わせの数は変えていない**（変更の前後どちらも 39 組。下の `scanned` で固定）。
   */
  it('据え置いたまま契約を変えた回が、すべて history に載っている', () => {
    const g = (a: string[]) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
    /** tag ごとの「その時点で在ったファイル」。**存在確認はここを引く**（git を起動しない） */
    const perTag = new Map<string, Set<string>>()
    const files = new Set<string>()
    for (const t of TAGS) {
      const s = new Set<string>()
      for (const f of g(['ls-tree', '-r', '--name-only', t, '--', 'schemas/']).trim().split('\n')) {
        if (f) { s.add(f); files.add(f) }
      }
      perTag.set(t, s)
    }
    expect(files.size, '走査対象の schema ファイル').toBeGreaterThan(10)

    /**
     * **要る blob をまとめて 1 回で取る。**
     * `cat-file --batch` は `<sha> blob <size>\n<中身>\n` を続けて吐くので、
     * **`size` を数えて切り出す**（改行で切ると中身の改行と区別できない）。
     */
    const want: string[] = []
    for (const t of TAGS) for (const p of perTag.get(t)!) want.push(`${t}:${p}`)
    const raw = execFileSync('git', ['cat-file', '--batch'], {
      cwd: ROOT, input: `${want.join('\n')}\n`, maxBuffer: 256 << 20,
    }) as unknown as Buffer
    const blobs = new Map<string, any>()
    let off = 0
    for (const key of want) {
      const nl = raw.indexOf(0x0a, off)
      const head = raw.subarray(off, nl).toString('utf8')
      const m = /^[0-9a-f]{40,64} blob (\d+)$/.exec(head)
      expect(m, `cat-file --batch が blob を返さない: ${key} → ${head.slice(0, 60)}`).toBeTruthy()
      const size = Number(m![1])
      blobs.set(key, JSON.parse(raw.subarray(nl + 1, nl + 1 + size).toString('utf8')))
      off = nl + 1 + size + 1
    }
    expect(blobs.size, '取り出した blob（0 なら batch が動いていない）').toBe(want.length)

    const recorded = new Set(
      ALL_ENTRIES.map(({ entry }) => `${entry.previousRelease}|${entry.shippedIn}|${entry.currentSchemaPath}`),
    )
    const missing: string[] = []
    let scanned = 0
    for (const p of [...files].sort()) {
      for (let i = 1; i < TAGS.length; i++) {
        const [a, b] = [TAGS[i - 1], TAGS[i]]
        if (!perTag.get(a)!.has(p) || !perTag.get(b)!.has(p)) continue
        scanned++
        const A = blobs.get(`${a}:${p}`)
        const B = blobs.get(`${b}:${p}`)
        if (diffSchemaObjects(A, B).verdict === 'HOLD') continue
        const held = A.properties?.schemaVersion?.const === B.properties?.schemaVersion?.const
        if (!held) continue
        if (!recorded.has(`${a}|${b}|${p}`)) missing.push(`${a}→${b} ${p}`)
      }
    }
    expect(scanned, '実際に比較した組み合わせ（0 なら走査が動いていない）').toBe(39)
    expect(missing, '版を据え置いたまま変えたのに history に無い').toEqual([])
  })
})

// ---------------------------------------------------------------- 変異

describe('contractMigration 変異（検査が本当に鳴るか）', () => {
  const sample = ALL_ENTRIES.find(({ id }) => id === 'source-input-manifest.v2')!
  const target = MIGRATIONS['source-input-manifest.v2'].history.find((h: Entry) => h.shippedIn === 'v0.4.0') as Entry
  const clone = () => JSON.parse(JSON.stringify(target)) as Entry

  it('前提: 変異前は問題ゼロ', () => {
    expect(sample.id).toBe('source-input-manifest.v2')
    expect(checkEntry(target, loadSchema)).toEqual([])
  })

  // --- 記録側を叩く変異 ---

  it('① 実在しない pointer を足すと落ちる', () => {
    const e = clone()
    e.changes.push({ kind: 'field-added', effect: 'WIDEN', schemaPointer: '/properties/存在しない項目' } as any)
    expect(checkEntry(e, loadSchema).join('\n')).toContain('① pointer が新旧どちらにも実在しない')
  })

  it('② effect を書き換えると落ちる', () => {
    const e = clone()
    e.changes[0].effect = 'NARROW'
    expect(checkEntry(e, loadSchema).join('\n')).toContain('② effect が実物と違う')
  })

  it('② policyVerdict を書き換えると落ちる', () => {
    const e = clone()
    e.policyVerdict = 'HOLD'
    expect(checkEntry(e, loadSchema).join('\n')).toContain('② policyVerdict が実物と違う')
  })

  it('③ 変更を 1 件消すと落ちる', () => {
    const e = clone()
    e.changes = [e.changes[0]]
    expect(checkEntry(e, loadSchema).join('\n')).toContain('③ 実物の差分が記録に無い')
  })

  // --- **検査の外側**を叩く変異: schema を書き換えて記録が追随しないことを見る ---

  const mutatedLoad = (mutate: (s: any, release: string, path: string) => void): typeof loadSchema =>
    (release, path) => {
      const s = loadSchema(release, path)
      mutate(s, release, path)
      return s
    }

  it('schema 側に項目を足すと、記録が追随していないので落ちる（③）', () => {
    const load = mutatedLoad((s, release) => {
      if (release === 'v0.4.0') s.properties.あとから足した項目 = { type: 'string' }
    })
    const problems = checkEntry(clone(), load).join('\n')
    expect(problems).toContain('③ 実物の差分が記録に無い')
    expect(problems).toContain('あとから足した項目')
  })

  it('schema 側から記録済みの項目を消すと、pointer が実在しなくなって落ちる（①）', () => {
    const load = mutatedLoad((s, release) => {
      if (release === 'v0.4.0') delete s.properties.inputScope
    })
    expect(checkEntry(clone(), load).join('\n')).toContain('① pointer が新旧どちらにも実在しない')
  })

  it('schema 側で enum の制約を付けると、記録に無い差分として落ちる（③）', () => {
    const load = mutatedLoad((s, release) => {
      if (release === 'v0.4.0') s.properties.inputFiles.items.properties.role.enum = ['schema', 'generator']
    })
    const problems = checkEntry(clone(), load).join('\n')
    expect(problems).toContain('③ 実物の差分が記録に無い')
    expect(problems).toContain('enum')
  })

  it('schema 側で差分を消すと、記録した変更に対応する実物が無くなって落ちる（②）', () => {
    // 旧 schema にも inputScope を足すと、v0.4.0 の「追加」という記録が実物と合わなくなる
    const load = mutatedLoad((s, release) => {
      if (release === 'v0.3.0') {
        s.properties.inputScope = JSON.parse(JSON.stringify(loadSchema('v0.4.0', 'schemas/source-input-manifest.v1.schema.json').properties.inputScope))
        s.required = [...s.required, 'inputScope']
      }
    })
    const problems = checkEntry(clone(), load).join('\n')
    expect(problems).toMatch(/② (記録した変更に対応する差分が実物に無い|policyVerdict が実物と違う)/)
  })
})
