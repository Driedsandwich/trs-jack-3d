/**
 * **止め方の名前は catalog が唯一の正本（v0.6.14・外部監査 2026-08-12 P0 / P1-E）。**
 *
 * ## なぜ要るか
 *
 * v0.6.13 まで、`stableReasonCode` は throw / return の各所に文字列として散っていた。
 * 中央の一覧が無いので、**付け忘れた経路は黙って `*_OTHER` へ落ちる。**
 * こちらは「corpus で止まる材料 110 件・`*_OTHER` は 0 件」と書いていたが、
 * **それは corpus が踏んだ経路についてだけ**だった。監査が出した反例をこちらで再現した:
 *
 * ```
 * 壊れた gzip             ARCHIVE_INVALID / ARCHIVE_INVALID_OTHER
 * source root が symlink  ARCHIVE_INVALID / ARCHIVE_INVALID_OTHER
 * 圧縮サイズ上限           code 無し
 * ```
 *
 * **さらに、v16 notes は「gzip の失敗に `GZIP_DECODE_FAILED` を付けた」と書いていた。**
 * 実測するとその名前は source のコメント 1 件にしか存在しなかった——
 * **実装していない機能を「付けた」と公開していた。**
 *
 * ## この試験の考え方
 *
 * **ソースを読んで数えない。走らせて集める。**
 * v0.6.13 までの棚卸しでは、`stableReasonCode:` という正規表現で数えて 49 種類と出したが、
 * 別の書き方をしている `PATH_EMPTY_NAME` などを取りこぼしていた（実際は動いていた）。
 * 自作の読み手は 3 度誤読したので、**materials を実際に読ませて出た code を集める。**
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { allCases } from './_corruptTar.mjs'
import {
  ArchiveInvalid, ArchiveUnsupported, CLI_STATUSES, CLI_STATUS_META, OTHER_CODES,
  REASON_CODES, assertCatalogued, readArchiveBuffer,
} from '../scripts/verifyReleaseSourceInputs.mjs'

const ROOT = resolve(__dirname, '..')
const MANIFEST = 'artifacts/source-input-manifest.json'
const tmps: string[] = []
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmpDir = () => { const d = mkdtempSync(join(tmpdir(), 'reason-')); tmps.push(d); return d }

function runCli(args: string[]): { code: number, json: Record<string, unknown> } {
  try {
    const out = execFileSync('node', ['scripts/verifyReleaseSourceInputs.mjs', ...args],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
    return { code: 0, json: JSON.parse(out) }
  } catch (e) {
    const err = e as { status?: number, stdout?: string }
    return { code: err.status ?? -1, json: JSON.parse(String(err.stdout ?? '{}')) }
  }
}

describe('reason code catalog — 止め方の名前は 1 か所で持つ', () => {
  /** catalog の形そのもの。**status は CLI の一覧に在る値でなければならない** */
  it('**catalog の全 code が、実在する status と family を宣言している**', () => {
    const entries = Object.entries(REASON_CODES)
    expect(entries.length, 'catalog が空').toBeGreaterThanOrEqual(50)
    for (const [code, meta] of entries) {
      expect(code, `${code}: 名前の形`).toMatch(/^[A-Z][A-Z0-9_]*$/)
      expect(CLI_STATUSES, `${code}: status が CLI の一覧に無い`).toContain(meta.status)
      /**
       * **v0.6.15: `OK` 以外のすべてが対象になった（外部監査 P1-B）。**
       * v0.6.14 まで archive 系の 2 つだけを許していたが、
       * **残り 4 つの止まり方には code が無く、`${status}_OTHER` へ落ちていた。**
       */
      expect(meta.status, `${code}: OK に理由は付かない`).not.toBe('OK')
      expect(meta.family, `${code}: family が無い`).toBeTypeOf('string')
      expect(meta.summary, `${code}: summary が無い`).toBeTypeOf('string')
    }
    // 空振り防止: 存在しない code は投げる
    expect(() => assertCatalogued('NOT_A_REAL_CODE')).toThrow(/catalog/)
    expect(assertCatalogued('PATH_TRAVERSAL')).toBe('PATH_TRAVERSAL')
  })

  /**
   * **catalog に無い名前で止め方を作れない。**
   * v0.6.13 まで、付け忘れても `*_OTHER` へ落ちるだけで誰も気づかなかった。
   */
  it.each([
    ['catalog に無い名前', () => new ArchiveInvalid('x', { stableReasonCode: 'NOT_IN_CATALOG' })],
    /**
     * **型でも弾いているが、実行時にも投げる。**
     * 型は `.mjs` を JS から呼ぶ経路（配布物を受け手が直接使う場合）には効かない。
     */
    ['名前を付けない', () => new ArchiveInvalid('x', {} as { stableReasonCode: string })],
    ['status が食い違う', () => new ArchiveInvalid('x', { stableReasonCode: 'ENTRY_TYPE_UNSUPPORTED' })],
    ['UNSUPPORTED 側も同じ', () => new ArchiveUnsupported('x', { stableReasonCode: 'PATH_TRAVERSAL' })],
  ])('%s と投げる', (_label, make) => {
    expect(make).toThrow()
  })

  it('**この検査が空振りしていない**（正しい組み合わせは通る）', () => {
    expect(() => new ArchiveInvalid('x', { stableReasonCode: 'PATH_TRAVERSAL' })).not.toThrow()
    expect(() => new ArchiveUnsupported('x', { stableReasonCode: 'ENTRY_TYPE_UNSUPPORTED' })).not.toThrow()
  })

  /**
   * **corpus が実際に出す code を集める。**ソースを読まない。
   * 「corpus では `*_OTHER` 0 件」は真だが、**それは corpus が踏んだ経路についてだけ**である
   * ——この試験はそこまでしか言わない。CLI の全経路は下の it が別に踏む。
   */
  it('**corpus が出す code はすべて catalog に在り、*_OTHER は 0 件**', () => {
    const emitted = new Set<string>()
    const others: string[] = []
    let stopped = 0
    for (const [kind, list] of Object.entries(allCases() as Record<string, { id: string, tar: Buffer }[]>)) {
      for (const c of list) {
        const r = readArchiveBuffer(c.tar, { gzip: false }) as { error?: unknown, stableReasonCode?: string }
        if (!r.error) continue
        stopped++
        const code = r.stableReasonCode
        if (!code || OTHER_CODES.includes(code)) others.push(`${kind}/${c.id}: ${code ?? '(無し)'}`)
        else emitted.add(code)
      }
    }
    expect(others, 'corpus の材料が *_OTHER を返した').toEqual([])
    expect(stopped, '止まる材料が少なすぎる（母集団が空）').toBeGreaterThanOrEqual(110)
    const notInCatalog = [...emitted].filter((c) => !Object.hasOwn(REASON_CODES, c))
    expect(notInCatalog, 'corpus が出したのに catalog に無い code').toEqual([])
    // **corpus は catalog の全部を踏まない。**踏んでいない数を出して、覆えていない範囲を隠さない
    const untouched = Object.keys(REASON_CODES).filter((c) => !emitted.has(c))
    console.log(`\ncorpus が踏んだ code ${emitted.size} 種類 / catalog ${Object.keys(REASON_CODES).length} 種類`
      + `\n**corpus が踏まない ${untouched.length} 種類**: ${untouched.join(', ')}`)
    expect(emitted.size, 'corpus が踏む code が減った').toBeGreaterThanOrEqual(37)
  })

  /**
   * **CLI の経路を実際に踏む（v0.6.14・外部監査 P0）。**
   * corpus は `readArchiveBuffer` しか通らないので、
   * gzip・source root・資源上限のような**CLI でしか通らない経路**を別に踏む。
   */
  it.each([
    ['壊れた gzip', 'GZIP_DECODE_FAILED', (d: string) => {
      const p = join(d, 'bad.tar.gz')
      writeFileSync(p, Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3]), Buffer.from('not-deflate')]))
      return p
    }],
    ['source root が symlink', 'SOURCE_ROOT_SYMLINK', (d: string) => {
      const link = join(d, 'link')
      symlinkSync(ROOT, link)
      return link
    }],
  ])('%s → %s', (_label, want, make) => {
    const d = tmpDir()
    const r = runCli(['--manifest', MANIFEST, '--source', make(d)])
    expect(r.json.stableReasonCode, `${want} を期待した（実際: ${String(r.json.stableReasonCode)}）`).toBe(want)
    expect(REASON_CODES[want as keyof typeof REASON_CODES].status,
      'catalog の status と実際の status が違う').toBe(r.json.status)
  })

  /**
   * **status に紐づくものが 1 つの map に集まっている（P1-C）。**
   * v0.6.13 まで `KNOWN_LOAD_KINDS` と `NOTE` が別に手書きされており、
   * status を足すと**黙って `SOURCE_UNAVAILABLE` へ丸められる**経路が残った。
   */
  it('**status の metadata が 1 つの map に集まっている**', () => {
    expect(Object.keys(CLI_STATUS_META).sort()).toEqual([...CLI_STATUSES].sort())
    for (const [s, m] of Object.entries(CLI_STATUS_META)) {
      expect(m.exit, `${s}: exit が無い`).toBeTypeOf('number')
      expect(m.fromLoad, `${s}: fromLoad が無い`).toBeTypeOf('boolean')
    }
    // loader が返してよいのは archive 系と SOURCE_UNAVAILABLE の 3 つ
    const fromLoad = Object.entries(CLI_STATUS_META).filter(([, m]) => m.fromLoad).map(([s]) => s).sort()
    expect(fromLoad).toEqual(['ARCHIVE_INVALID', 'ARCHIVE_UNSUPPORTED', 'SOURCE_UNAVAILABLE'])
    // 注記を持つのは、その 3 つだけ（受け手が「不一致ではない」と読み分ける必要がある status）
    const withNote = Object.entries(CLI_STATUS_META).filter(([, m]) => m.note).map(([s]) => s).sort()
    expect(withNote).toEqual(fromLoad)
  })

  /**
   * **`OK` 以外は必ず理由の名前が入る（v0.6.15・外部監査 P1-B）。**
   * schema の if/then/else では書いていない（版数判定器が扱えない構文のため）ので、
   * **実際に走らせて確かめる。**
   */
  it('**OK 以外の status は、必ず理由の名前を持つ**', () => {
    const routes: [string, string[]][] = [
      ['MANIFEST_UNAVAILABLE', ['--manifest', '/nonexistent/m.json', '--source', '.']],
      ['SOURCE_UNAVAILABLE', ['--manifest', MANIFEST, '--source', '/nonexistent/dir']],
      ['VERIFICATION_INCOMPLETE', ['--manifest', MANIFEST, '--source', '.', '--scope', '/nonexistent/s.json']],
    ]
    for (const [want, args] of routes) {
      const r = runCli(args)
      expect(r.json.status).toBe(want)
      expect(r.json.stableReasonCode, `${want} に理由の名前が無い`).toBeTypeOf('string')
      assertCatalogued(r.json.stableReasonCode as string)
    }
    // 空振り防止: OK のときは null であること
    const ok = runCli(['--manifest', MANIFEST, '--source', '.'])
    expect(ok.json.status).toBe('OK')
    expect(ok.json.stableReasonCode, 'OK なのに理由が付いている').toBeNull()
  })

  /**
   * **`archivePolicy` が覆っていない範囲を自分で言っている（P1-D）。**
   * 名前は「受け入れる範囲の全部」と読めるが、機械で読める形にしてあるのは一部だけ。
   * **改名は schema を狭めて下流を止めるので、欄を足して明示した。**
   */
  it('**archivePolicy が覆っていない範囲を明示している**', () => {
    const r = runCli(['--manifest', MANIFEST, '--source', '.'])
    const p = r.json.archivePolicy as Record<string, unknown>
    expect(p.notMachineReadableHere, '覆っていない範囲の一覧が無い').toBeInstanceOf(Array)
    expect((p.notMachineReadableHere as string[]).length).toBeGreaterThanOrEqual(5)
    const families = p.reasonCodeFamilies as string[]
    expect(families.sort()).toEqual([...new Set(Object.values(REASON_CODES).map((x) => x.family))].sort())
  })

})
