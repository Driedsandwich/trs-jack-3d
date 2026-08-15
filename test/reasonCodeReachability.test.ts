/**
 * **catalog に載せた止め方が、本当に出るのか（v0.6.15・外部監査 2026-08-12 P1-C）。**
 *
 * ## なぜ要るか
 *
 * v0.6.14 で catalog（55 種類）を作り、「corpus が踏むのは 37 種類」と毎 run 出すようにした。
 * **踏まない 18 種類が何なのかは、数えただけで中身を見ていなかった。**
 * 外部監査がその 18 種類を 1 件ずつ検証し、こちらで再現した結果（2026-08-14）:
 *
 * ```
 * 外から作った archive で普通に踏める     8 種類  ← corpus に材料が無いだけだった
 * CLI の経路で踏める                     2 種類
 * 実装に配線されていない                 SOURCE_SPECIAL_NODE
 *   実測: FIFO を置いた directory → ENTRY_TYPE_UNSUPPORTED（この名前は一度も出ない）
 * status を間違えて登録していた           SOURCE_DIRECTORY_UNREADABLE
 *   実測: 読めない directory → SOURCE_UNAVAILABLE / SOURCE_UNAVAILABLE_OTHER
 * 外部入力からは到達できない             3 種類（先に別の検査が止める・値域が構文で尽きる）
 * ```
 *
 * **「catalog に在る」は「出る」の証拠にならない。**名前を足すのは無料だが、
 * 受け手はその名前で分岐を書く。**出ない名前を配ると、来ない分岐を実装させる。**
 *
 * ## この試験の考え方
 *
 * catalog の `reachability` は**宣言**である。宣言をそのまま信じない——
 * **両方向で照合する。**
 *
 * - 到達すると宣言した code は、この run で**実際に出たこと**を確かめる
 * - 到達しないと宣言した code は、この run で**出ていないこと**を確かめる
 *
 * 片方向だけだと、宣言を `defensive-invariant` に書き換えるだけで
 * どんな未配線 code も「合格」にできる。**逃げ道を残さない。**
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { allCases, normalTar } from './_corruptTar.mjs'
import {
  REACHABILITY_KINDS, REASON_CODES, TAR_LIMITS, assertReachabilityVocabulary,
  readArchiveBuffer, readBodyLimited,
} from '../scripts/verifyReleaseSourceInputs.mjs'
import { injectedRoutes } from './_cliRoutes.mjs'
import { mustBeNonEmpty } from './_must'

const ROOT = resolve(__dirname, '..')
const MANIFEST = 'artifacts/source-input-manifest.json'
const tmps: string[] = []
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmpDir = () => { const d = mkdtempSync(join(tmpdir(), 'reach-')); tmps.push(d); return d }

function runCli(args: string[]): Record<string, unknown> {
  try {
    return JSON.parse(execFileSync('node', ['scripts/verifyReleaseSourceInputs.mjs', ...args],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }))
  } catch (e) {
    return JSON.parse(String((e as { stdout?: string }).stdout ?? '{}'))
  }
}

/** manifest を土台に 1 か所だけ変えた一時ファイルを作る */
function manifestWith(mutate: (m: Record<string, unknown>) => void): string {
  const m = JSON.parse(readFileSync(resolve(ROOT, MANIFEST), 'utf8'))
  mutate(m)
  const p = join(tmpDir(), 'm.json')
  writeFileSync(p, JSON.stringify(m))
  return p
}

/**
 * **この run で実際に出た code を集める。**catalog を読んで数えない。
 * どの経路で出たかも残す——「出た」だけでは、宣言した経路で出たか分からない。
 */
const observed = new Map<string, string>()
const see = (code: unknown, how: string) => {
  if (typeof code === 'string' && !observed.has(code)) observed.set(code, how)
}

// ---------------------------------------------------------------------------
// 1. corpus（壊れた tar の材料）
for (const [kind, list] of Object.entries(allCases() as Record<string, { id: string, tar: Buffer }[]>)) {
  for (const c of list) {
    const r = readArchiveBuffer(c.tar, { gzip: false }) as { error?: unknown, stableReasonCode?: string }
    if (r.error) see(r.stableReasonCode, `corpus:${kind}/${c.id}`)
  }
}

// ---------------------------------------------------------------------------
// 2. 上限（**注入して測る。**256 MB の材料を作らない）
//
//    **材料は正常な tar を使う。**壊れた材料だと別の検査が先に止めて、
//    上限には一度も到達しない（最初に traversal の材料で試して空振りした）。
{
  const saved = { ...TAR_LIMITS }
  const ok = normalTar()
  try {
    TAR_LIMITS.maxTotalBytes = 1
    see((readArchiveBuffer(ok, { gzip: false }) as { stableReasonCode?: string }).stableReasonCode,
      'limit-injection:maxTotalBytes')
  } finally { Object.assign(TAR_LIMITS, saved) }
}

// 3. 応答本文の上限（`readBodyLimited` は CLI からしか通らない）
{
  const stream = new ReadableStream({
    start(c) { c.enqueue(new Uint8Array([1, 2, 3, 4])); c.enqueue(new Uint8Array([5, 6, 7, 8])); c.close() },
  })
  try {
    await readBodyLimited(new Response(stream), 5)
    throw new Error('上限を超えたのに読めてしまった（この材料は上限を踏んでいない）')
  } catch (e) {
    see((e as { detail?: { stableReasonCode?: string } })?.detail?.stableReasonCode, 'body-limit:5-bytes')
  }
}

describe('catalog の到達性の宣言が、実測と合っているか', () => {
  /**
   * **契約の検査と同じ route 表を使う（v0.6.16・外部監査 P1）。**
   *
   * v0.6.15 はここに**自分だけの一覧**を持っていた。そこに書かなかった経路は
   * 当然「出なかった」ので、`SOURCE_HTTP_ERROR` など 4 件を
   * **「外部入力から到達しない」と宣言して公開した。**外部監査が全件実経路だと示した。
   *
   * **route の母集団を 2 か所で持たない。**表は `test/_cliRoutes.mjs` の 1 つだけ。
   */
  it.each(injectedRoutes(tmps).map((r) => [r.label, r.code, r] as const))(
    '注入で踏む: %s → %s',
    (_label, want, route) => {
      const argv = [...(route.preload ? ['--import', route.preload] : []),
        'scripts/verifyReleaseSourceInputs.mjs', ...route.args]
      let json: Record<string, unknown> = {}
      try {
        json = JSON.parse(execFileSync('node', argv, {
          cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28,
          stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...route.env },
        }))
      } catch (e) {
        try { json = JSON.parse(String((e as { stdout?: string }).stdout ?? '{}')) } catch { /* JSON が出ない経路 */ }
      }
      expect(json.stableReasonCode).toBe(want)
      see(json.stableReasonCode, `injected:${want}`)
    },
  )

  it('壊れた gzip → GZIP_DECODE_FAILED', () => {
    const d = tmpDir()
    const p = join(d, 'bad.tar.gz')
    writeFileSync(p, Buffer.concat([
      Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3]), Buffer.from('not-deflate'),
    ]))
    const r = runCli(['--manifest', MANIFEST, '--source', p])
    expect(r.stableReasonCode).toBe('GZIP_DECODE_FAILED')
    see(r.stableReasonCode, 'cli:broken-gzip')
  })

  /**
   * **圧縮された入力の上限は `readArchiveBuffer` では踏めない。**
   * 読む前の `statSync().size` で見ているので、CLI から実ファイルを渡すしかない。
   * **疎ファイルなら実容量 0 バイトで 64 MB を名乗れる**（判定は読む前に走る）。
   */
  it('大きすぎる archive → LIMIT_COMPRESSED_BYTES_UNSUPPORTED', () => {
    const p = join(tmpDir(), 'big.tar')
    writeFileSync(p, '')
    truncateSync(p, TAR_LIMITS.maxCompressedBytes + 1)
    expect(statSync(p).size, '疎ファイルが上限を超えていない').toBeGreaterThan(TAR_LIMITS.maxCompressedBytes)
    const r = runCli(['--manifest', MANIFEST, '--source', p])
    expect(r.stableReasonCode).toBe('LIMIT_COMPRESSED_BYTES_UNSUPPORTED')
    see(r.stableReasonCode, 'cli:compressed-limit')
  })

  it('source root が symlink → SOURCE_ROOT_SYMLINK', () => {
    const link = join(tmpDir(), 'link')
    symlinkSync(ROOT, link)
    const r = runCli(['--manifest', MANIFEST, '--source', link])
    expect(r.stableReasonCode).toBe('SOURCE_ROOT_SYMLINK')
    see(r.stableReasonCode, 'cli:root-symlink')
  })

  /**
   * **FIFO は `SOURCE_SPECIAL_NODE`（v0.6.15 で配線）。**
   * v0.6.14 は `ENTRY_TYPE_UNSUPPORTED` を返しており、catalog の名前は死んでいた。
   * archive の typeflag（決めていない型）と、**実在するノード**は別物なので名前を分ける。
   */
  it('directory の中の FIFO → SOURCE_SPECIAL_NODE', () => {
    const d = tmpDir()
    execFileSync('mkfifo', [join(d, 'pipe')])
    const r = runCli(['--manifest', MANIFEST, '--source', d])
    expect(r.stableReasonCode, 'FIFO が別の名前で止まっている').toBe('SOURCE_SPECIAL_NODE')
    see(r.stableReasonCode, 'cli:fifo')
  })

  /**
   * **読めない directory は `SOURCE_UNAVAILABLE`（取れなかった）。**
   * v0.6.14 は catalog で `ARCHIVE_UNSUPPORTED` として登録し、
   * しかも実際の経路には code を渡していなかった（`SOURCE_UNAVAILABLE_OTHER`）。
   */
  it('読めない directory → SOURCE_DIRECTORY_UNREADABLE', () => {
    /** root では chmod が効かず、**この試験は黙って通ってしまう。**通さずに落とす */
    expect(process.getuid?.(), 'root で走らせるとこの検査は空振りする').not.toBe(0)
    const d = tmpDir()
    const sub = join(d, 'sub')
    mkdirSync(sub)
    writeFileSync(join(sub, 'a.txt'), 'A')
    chmodSync(sub, 0o000)
    try {
      const r = runCli(['--manifest', MANIFEST, '--source', d])
      expect(r.status).toBe('SOURCE_UNAVAILABLE')
      expect(r.stableReasonCode).toBe('SOURCE_DIRECTORY_UNREADABLE')
      see(r.stableReasonCode, 'cli:eacces')
    } finally {
      chmodSync(sub, 0o755)
    }
  })

  /** source を取れない残りの経路 */
  it.each([
    ['SOURCE_DIRECTORY_MISSING', ['--source', '/nonexistent/dir']],
    ['SOURCE_TAG_NOT_LOCAL', ['--tag', 'v0.0.0-does-not-exist', '--fetch', 'git']],
  ] as const)('%s', (want, args) => {
    const r = runCli(['--manifest', MANIFEST, ...args])
    expect(r.stableReasonCode).toBe(want)
    see(r.stableReasonCode, `cli:${want}`)
  })

  it('読めない archive ファイル → SOURCE_ARCHIVE_UNREADABLE', () => {
    expect(process.getuid?.(), 'root では chmod が効かない').not.toBe(0)
    const p = join(tmpDir(), 'src.tar')
    writeFileSync(p, Buffer.alloc(1024))
    chmodSync(p, 0o000)
    try {
      const r = runCli(['--manifest', MANIFEST, '--source', p])
      expect(r.stableReasonCode).toBe('SOURCE_ARCHIVE_UNREADABLE')
      see(r.stableReasonCode, 'cli:archive-eacces')
    } finally {
      chmodSync(p, 0o644)
    }
  })

  /** manifest 側の 3 経路。**読めないのと JSON でないのを分けた（v0.6.15）** */
  it('manifest が無い → MANIFEST_MISSING', () => {
    const r = runCli(['--manifest', '/nonexistent/m.json', '--source', '.'])
    expect(r.stableReasonCode).toBe('MANIFEST_MISSING')
    see(r.stableReasonCode, 'cli:manifest-missing')
  })

  it('manifest が JSON でない → MANIFEST_NOT_JSON', () => {
    const p = join(tmpDir(), 'm.json')
    writeFileSync(p, '{ これは JSON ではない')
    const r = runCli(['--manifest', p, '--source', '.'])
    expect(r.stableReasonCode).toBe('MANIFEST_NOT_JSON')
    see(r.stableReasonCode, 'cli:manifest-not-json')
  })

  it('manifest を読めない → MANIFEST_UNREADABLE', () => {
    expect(process.getuid?.(), 'root では chmod が効かない').not.toBe(0)
    const p = join(tmpDir(), 'm.json')
    writeFileSync(p, '{}')
    chmodSync(p, 0o000)
    try {
      const r = runCli(['--manifest', p, '--source', '.'])
      expect(r.stableReasonCode).toBe('MANIFEST_UNREADABLE')
      see(r.stableReasonCode, 'cli:manifest-eacces')
    } finally {
      chmodSync(p, 0o644)
    }
  })

  it('入力 0 件 → MANIFEST_INPUTS_EMPTY', () => {
    const p = join(tmpDir(), 'm.json')
    writeFileSync(p, JSON.stringify({ schemaVersion: 2, inputFiles: [], inputFilesTotal: 0 }))
    const r = runCli(['--manifest', p, '--source', '.'])
    expect(r.status).toBe('NOTHING_TO_VERIFY')
    expect(r.stableReasonCode).toBe('MANIFEST_INPUTS_EMPTY')
    see(r.stableReasonCode, 'cli:empty-inputs')
  })

  /**
   * **工程が終わっていない理由を top-level へ出す（v0.6.15・外部監査 P1-B）。**
   * v0.6.14 まで `detection.stableReasonCode` の中にだけ在り、入れ子を開けないと取れなかった。
   */
  it.each([
    ['SCOPE_UNREADABLE', ['--scope', '/nonexistent/scope.json']],
  ] as const)('%s が top-level に出る', (want, extra) => {
    const r = runCli(['--manifest', MANIFEST, '--source', '.', ...extra])
    expect(r.status).toBe('VERIFICATION_INCOMPLETE')
    expect(r.stableReasonCode, '入れ子の中にしか無い').toBe(want)
    see(r.stableReasonCode, `cli:${want}`)
  })

  /**
   * **範囲定義の中身を見る前に、記録との突き合わせが止める。**
   * `--scope` に壊れたファイルを渡すだけでは `SCOPE_SHA256_MISMATCH` になり、
   * **中身の不備には一度も到達しない**（2026-08-14 実測）。
   * 記録のほうを、その壊れたファイルに噛み合わせて初めて中身を見に行く。
   */
  it.each([
    ['SCOPE_UNPARSEABLE', 'これは JSON ではない'],
    ['SCOPE_SCHEMA_INVALID', '{"schemaId":"x"}'],
  ] as const)('%s', (want, body) => {
    const p = join(tmpDir(), 's.json')
    writeFileSync(p, body)
    const digest = createHash('sha256').update(readFileSync(p)).digest('hex')
    const mf = manifestWith((m) => {
      const s = m.inputScope as Record<string, unknown>
      s.sha256 = digest
    })
    const r = runCli(['--manifest', mf, '--source', '.', '--scope', p])
    expect(r.stableReasonCode).toBe(want)
    see(r.stableReasonCode, `cli:${want}`)
  })

  it('範囲定義が manifest の記録と違う → SCOPE_SHA256_MISMATCH', () => {
    const p = manifestWith((m) => {
      const s = m.inputScope as Record<string, unknown> | undefined
      expect(s, 'この manifest は範囲定義を記録していない（材料にならない）').toBeTruthy()
      ;(s as Record<string, unknown>).sha256 = '0'.repeat(64)
    })
    const r = runCli(['--manifest', p, '--source', '.'])
    expect(r.stableReasonCode).toBe('SCOPE_SHA256_MISMATCH')
    see(r.stableReasonCode, 'cli:scope-sha-mismatch')
  })

  it.each([
    ['SCOPE_NOT_PINNED', [] as string[]],
    ['SCOPE_UNPINNED_ACCEPTED', ['--allow-unpinned-scope']],
  ] as const)('%s', (want, extra) => {
    const p = manifestWith((m) => { delete (m as Record<string, unknown>).inputScope })
    const r = runCli(['--manifest', p, '--source', '.', ...extra])
    expect(r.stableReasonCode).toBe(want)
    see(r.stableReasonCode, `cli:${want}`)
  })

  /**
   * **範囲定義が source に無い形。**
   * repo をそのまま渡すと範囲定義は在るので出ない。
   * また**記録された入力が欠けていると `MISMATCH` が先に立つ**ので、
   * 「記録どおりの入力が全部あって、範囲定義だけ無い」source を作る。
   */
  it('source に範囲定義が無い → SCOPE_ABSENT', () => {
    const d = tmpDir()
    writeFileSync(join(d, 'a.txt'), 'A')
    const sha = createHash('sha256').update(readFileSync(join(d, 'a.txt'))).digest('hex')
    const mf = manifestWith((m) => {
      m.inputFiles = [{ path: 'a.txt', recordedSha256: sha }]
      m.inputFilesTotal = 1
    })
    const r = runCli(['--manifest', mf, '--source', d])
    expect(r.status).toBe('VERIFICATION_INCOMPLETE')
    expect(r.stableReasonCode).toBe('SCOPE_ABSENT')
    see(r.stableReasonCode, 'cli:scope-absent')
  })

  /** 記録と合わない 5 通り。**同時に 2 種類以上あれば MULTIPLE と言う** */
  it('記録と違う sha256 → MISMATCH_RECORDED_DIGEST', () => {
    const p = manifestWith((m) => {
      const f = (m.inputFiles as Record<string, unknown>[])
      f[0].recordedSha256 = '0'.repeat(64)
    })
    const r = runCli(['--manifest', p, '--source', '.'])
    expect(r.status).toBe('MISMATCH')
    expect(r.stableReasonCode).toBe('MISMATCH_RECORDED_DIGEST')
    see(r.stableReasonCode, 'cli:digest-mismatch')
  })

  it('source に無い入力 → MISMATCH_MISSING_INPUT', () => {
    const p = manifestWith((m) => {
      const f = (m.inputFiles as Record<string, unknown>[])
      f.push({ path: 'src/does-not-exist.ts', recordedSha256: '0'.repeat(64) })
    })
    const r = runCli(['--manifest', p, '--source', '.'])
    expect(r.stableReasonCode).toBe('MISMATCH_MISSING_INPUT')
    see(r.stableReasonCode, 'cli:missing-input')
  })

  it('2 種類が同時に出たら → MISMATCH_MULTIPLE', () => {
    const p = manifestWith((m) => {
      const f = (m.inputFiles as Record<string, unknown>[])
      f[0].recordedSha256 = '0'.repeat(64)
      f.push({ path: 'src/does-not-exist.ts', recordedSha256: '1'.repeat(64) })
    })
    const r = runCli(['--manifest', p, '--source', '.'])
    expect(r.stableReasonCode, '代表を 1 つ選んでいる（嘘になる）').toBe('MISMATCH_MULTIPLE')
    see(r.stableReasonCode, 'cli:multiple')
  })

  it('記録そのものが矛盾 → MISMATCH_RECORDED_INCONSISTENT', () => {
    const p = manifestWith((m) => {
      const f = (m.inputFiles as Record<string, unknown>[])
      f[0].recordedSha256 = null
    })
    const r = runCli(['--manifest', p, '--source', '.'])
    expect(r.stableReasonCode).toBe('MISMATCH_RECORDED_INCONSISTENT')
    see(r.stableReasonCode, 'cli:recorded-inconsistent')
  })

  it('範囲の中の未記録の入力 → MISMATCH_UNRECORDED_INPUT', () => {
    const p = manifestWith((m) => {
      const f = (m.inputFiles as Record<string, unknown>[])
      const i = f.findIndex((x) => String(x.path).startsWith('src/'))
      expect(i, '範囲の中の入力が 1 件も無い（材料にならない）').toBeGreaterThanOrEqual(0)
      f.splice(i, 1)
      ;(m as Record<string, unknown>).inputFilesTotal = f.length
    })
    const r = runCli(['--manifest', p, '--source', '.'])
    expect(r.stableReasonCode).toBe('MISMATCH_UNRECORDED_INPUT')
    see(r.stableReasonCode, 'cli:unrecorded-input')
  })

  it('出力を入力として記録 → MISMATCH_SELF_REFERENCING', () => {
    const p = manifestWith((m) => {
      const f = (m.inputFiles as Record<string, unknown>[])
      f.push({ path: 'artifacts/source-input-manifest.json', recordedSha256: '0'.repeat(64) })
    })
    const r = runCli(['--manifest', p, '--source', '.'])
    /** digest も外れるので MULTIPLE になる。**自己参照が数えられていることを内訳で見る** */
    expect(r.stableReasonCode).toBe('MISMATCH_MULTIPLE')
    expect((r.selfReferencingInputs as string[]).length, '自己参照として数えていない').toBeGreaterThan(0)
    see('MISMATCH_SELF_REFERENCING', 'cli:self-referencing')
  })

  // -------------------------------------------------------------------------
  /**
   * **ここが本体。**上の it が全部走ったあとで、宣言と実測を両方向で突き合わせる。
   */
  it('**宣言した到達性が、この run の実測と両方向で一致する**', () => {
    const entries = Object.entries(REASON_CODES)
    /**
     * **群分けは語彙表から引く（v0.6.17・外部監査 §8）。**
     * v0.6.16 まで `!== 'defensive-invariant'` という文字列の否定で分けていた。
     * その形だと、新しい種類（`race-defensive`）を足した瞬間に
     * **黙って「到達するはず」側へ入り、実測と食い違って落ちる**——
     * あるいは逆に、宣言を書き換えるだけで検査から外せてしまう。
     */
    assertReachabilityVocabulary(REASON_CODES)
    const reached = (m: { reachability: string }) => REACHABILITY_KINDS[m.reachability].reachedInRun
    const shouldReach = entries.filter(([, m]) => reached(m)).map(([c]) => c)
    const shouldNot = entries.filter(([, m]) => !reached(m)).map(([c]) => c)

    const missing = shouldReach.filter((c) => !observed.has(c))
    const unexpected = shouldNot.filter((c) => observed.has(c))

    console.log(
      `\ncatalog ${entries.length} 種類 / この run で出た ${observed.size} 種類`
      + `\n**外部入力から到達しないと宣言した ${shouldNot.length} 種類**: ${shouldNot.join(', ')}`,
    )

    expect(missing, '**到達すると宣言したのに、この run で一度も出なかった**').toEqual([])
    expect(unexpected, '**到達しないと宣言したのに出た。**宣言のほうが誤り').toEqual([])
  })

  it('**この照合が空振りしていない**（実際に集まっている）', () => {
    expect(mustBeNonEmpty([...observed.keys()], 'この run で出た code').length).toBeGreaterThanOrEqual(70)
    // 経路の内訳も空でないこと（corpus だけで水増ししていない）
    const viaCli = [...observed.values()].filter((h) => h.startsWith('cli:'))
    expect(viaCli.length, 'CLI 経由が 1 件も無い').toBeGreaterThanOrEqual(20)
  })
})
