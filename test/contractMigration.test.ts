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

/** この release より新しい記録は working tree から読む（tag がまだ無い） */
const UNRELEASED = 'v0.5.0'

const tagExists = (t: string) => {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${t}^{tag}`], { cwd: ROOT, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

let readFromGit = 0
let readFromTree = 0

/** release 時点の schema を読む。**取れなければ落とす**（skip すると検査ごと消える） */
function loadSchema(release: string, path: string): any {
  if (tagExists(release)) {
    readFromGit++
    const raw = execFileSync('git', ['show', `${release}:${path}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
    if (!raw.trim()) throw new Error(`${release}:${path} が空`)
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
    expect(readFromTree, '作業ツリーから読んだ回数（v0.5.0 のぶん）').toBeGreaterThan(0)
  })
})

describe('contractMigration 正本と schema の対応', () => {
  const PAIRS: readonly (readonly [string, string])[] = [
    ['half-plug-topology-profile.v3', 'schemas/half-plug-topology-profile.v3.schema.json'],
    ['event-sensitivity.v2', 'schemas/event-sensitivity.v2.schema.json'],
    ['topology-robustness.v3', 'schemas/topology-robustness.v3.schema.json'],
    ['source-input-manifest.v2', 'schemas/source-input-manifest.v2.schema.json'],
    ['validation-results.v2', 'schemas/validation-results.v2.schema.json'],
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
      ['validation-results.v2', 'artifacts/validation-results.json'],
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
    const bad = ALL_ENTRIES.filter(({ entry }) => entry.shippedIn >= UNRELEASED && entry.versionWasHeld)
    expect(bad.map((b) => `${b.id} ${b.entry.shippedIn}`), '条文を破った回が新たに増えている').toEqual([])
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

  it('据え置いたまま契約を変えた回が、すべて history に載っている', () => {
    const g = (a: string[]) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
    const exists = (t: string, p: string) => {
      try {
        g(['cat-file', '-e', `${t}:${p}`])
        return true
      } catch {
        return false
      }
    }
    const files = new Set<string>()
    for (const t of TAGS) {
      for (const f of g(['ls-tree', '-r', '--name-only', t, '--', 'schemas/']).trim().split('\n')) {
        if (f) files.add(f)
      }
    }
    expect(files.size, '走査対象の schema ファイル').toBeGreaterThan(10)

    const recorded = new Set(
      ALL_ENTRIES.map(({ entry }) => `${entry.previousRelease}|${entry.shippedIn}|${entry.currentSchemaPath}`),
    )
    const missing: string[] = []
    let scanned = 0
    for (const p of [...files].sort()) {
      for (let i = 1; i < TAGS.length; i++) {
        const [a, b] = [TAGS[i - 1], TAGS[i]]
        if (!exists(a, p) || !exists(b, p)) continue
        scanned++
        const A = JSON.parse(g(['show', `${a}:${p}`]))
        const B = JSON.parse(g(['show', `${b}:${p}`]))
        if (diffSchemaObjects(A, B).verdict === 'HOLD') continue
        const held = A.properties?.schemaVersion?.const === B.properties?.schemaVersion?.const
        if (!held) continue
        if (!recorded.has(`${a}|${b}|${p}`)) missing.push(`${a}→${b} ${p}`)
      }
    }
    expect(scanned, '実際に比較した組み合わせ（0 なら走査が動いていない）').toBeGreaterThan(20)
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
