/**
 * **`main(args, io)` へ直接注入して踏む（v0.6.19・core / CLI 分離 段 3 のあと）。**
 *
 * ## なぜ子プロセスの注入とは別に要るか
 *
 * `test/_cliRoutes.mjs` は**子プロセスを起動して** `node:fs` や `globalThis.fetch` を
 * 差し替える。それは「配布した 1 ファイルを、受け手と同じ起動のされ方で踏む」ための表で、
 * **CLI としての振る舞い（終了コード・stdout の byte）**を確かめるのに要る。
 *
 * こちらは違う。**同じプロセスの中で `io` だけを渡して本体を呼ぶ。**
 * global を 1 つも差し替えないので、
 *
 *   - 「その差し替えが効いていただけではないか」を排除できる
 *   - `main()` が本当に `io` しか見ていないことを示せる
 *
 * **どちらか一方では足りない。**子プロセス側は「配ったものが動くか」、
 * こちら側は「本体が注入可能か」を見る。同じ code を別の入口から踏む。
 *
 * ## v0.6.18 で足した `io` の fs が、ここで初めて効く
 *
 * v0.6.18 は `SOURCE_ARCHIVE_MISSING` を `node:fs` の差し替えで踏んだ。
 * そのとき **`io` へ fs を足したことは効いていなかった**——差し替えは
 * ESM の named import にも効くので、`io` を経由してもしなくても同じだった。
 * 抽出が済んだいま、**global を差し替えずに踏める。**
 */

import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CliResult, main } from '../scripts/verifyReleaseSourceInputs.mjs'

const ROOT = resolve(__dirname, '..')
const MANIFEST = 'artifacts/source-input-manifest.json'

/** 実 filesystem をそのまま通す io（差し替えたいものだけ上書きする） */
function passthroughIo(over: Record<string, unknown> = {}) {
  const seen: string[] = []
  return {
    io: {
      cwd: () => ROOT,
      argv: () => [],
      stdout: () => {},
      stderr: () => {},
      exit: () => {},
      existsSync,
      readFileSync: (p: string, enc?: string) => (enc === undefined ? readFileSync(p) : readFileSync(p, enc as BufferEncoding)),
      statSync,
      lstatSync,
      readdirSync,
      ...over,
    },
    seen,
  }
}

/** `main()` を呼んで `CliResult` を受ける。**done() を通らずに戻ったら落とす** */
async function run(args: string[], io: unknown): Promise<{ code: number, json: any, stderr: string }> {
  try {
    await main(args, io)
  } catch (e) {
    if (!(e instanceof CliResult)) throw e
    return { code: e.code, json: e.stdout ? JSON.parse(e.stdout) : null, stderr: e.stderr }
  }
  throw new Error('**done() を通らずに戻った。**本体が結果を出していない')
}

describe('main(args, io) へ直接注入する', () => {
  it('**io だけで OK まで通る**（global を 1 つも差し替えない）', async () => {
    const { io } = passthroughIo()
    const r = await run(['--manifest', 'test/fixtures/ok-source/source-input-manifest.json',
      '--source', 'test/fixtures/ok-source'], io)
    expect(r.code, `exit が 0 でない: ${JSON.stringify(r.json?.reason)}`).toBe(0)
    expect(r.json.status).toBe('OK')
    expect(r.json.stableReasonCode).toBe(null)
  })

  /**
   * **v0.6.18 で足した `io` の fs が、ここで初めて効く。**
   *
   * `loadFromDir` の `existsSync` は通し、そこから呼ばれる `loadFromArchive` の
   * `existsSync` で false を返す——**同じ path に対する 2 回目**である。
   */
  it('**`SOURCE_ARCHIVE_MISSING` を io の注入だけで踏む**', async () => {
    const dir = resolve(ROOT, 'node_modules/.cache/trs-vanish')
    mkdirSync(dir, { recursive: true })
    const target = 'node_modules/.cache/trs-vanish/vanishing.tar.gz'
    writeFileSync(resolve(ROOT, target), 'このファイルは 2 回目の existsSync で消えたことになる\n')

    let seen = 0
    const { io } = passthroughIo({
      existsSync: (p: string) => {
        if (String(p).endsWith('trs-vanish/vanishing.tar.gz')) { seen += 1; return seen === 1 }
        return existsSync(p)
      },
    })
    const r = await run(['--manifest', MANIFEST, '--source', target], io)
    expect(r.json.stableReasonCode).toBe('SOURCE_ARCHIVE_MISSING')
    expect(r.json.status).toBe('SOURCE_UNAVAILABLE')
    expect(r.code).toBe(2)
    /** **2 回呼ばれたことを確かめる。**1 回で終わっていたら別の経路を踏んでいる */
    expect(seen, '対象 path の existsSync が 2 回呼ばれていない').toBe(2)
  })

  /** 対照: 差し替えなければ、同じ引数で別の code になる（注入が効いている証拠） */
  it('対照: 注入しなければ SOURCE_ARCHIVE_MISSING にならない', async () => {
    const dir = resolve(ROOT, 'node_modules/.cache/trs-vanish')
    mkdirSync(dir, { recursive: true })
    const target = 'node_modules/.cache/trs-vanish/vanishing.tar.gz'
    writeFileSync(resolve(ROOT, target), 'このファイルは 2 回目の existsSync で消えたことになる\n')

    const { io } = passthroughIo()
    const r = await run(['--manifest', MANIFEST, '--source', target], io)
    expect(r.json.stableReasonCode, '注入なしで踏めてしまっている').not.toBe('SOURCE_ARCHIVE_MISSING')
  })

  it('**`main()` は `io` しか見ていない**（cwd を差し替えると manifest を見失う）', async () => {
    const { io } = passthroughIo({ cwd: () => resolve(ROOT, 'test/fixtures') })
    const r = await run(['--manifest', MANIFEST], io)
    /** `test/fixtures/artifacts/…` は無いので manifest が見つからない */
    expect(r.json.stableReasonCode).toBe('MANIFEST_MISSING')
  })

  /**
   * **network も `io` から取る（v0.6.20）。**
   *
   * v0.6.19 まで `SOURCE_FETCH_*` は `globalThis.fetch` を差し替えて踏んでいた。
   * **その差し替えは、同じプロセスの全部に効く。**試験どうしが干渉しうるし、
   * 「差し替えが効いていただけで、本体は別の経路を通ったのでは」を排除できない。
   *
   * `io.fetch` なら**この呼び出しだけ**に効く。判定側は 1 行も変えていない
   * ——`AbortSignal.timeout` が `TimeoutError` を投げる約束をそのまま使う。
   */
  const FETCH_CASES: readonly (readonly [string, () => Promise<Response>])[] = [
    ['SOURCE_FETCH_FAILED', async () => { throw new TypeError('fetch failed') }],
    ['SOURCE_FETCH_TIMEOUT', async () => {
      const e = new Error('timed out'); e.name = 'TimeoutError'; throw e
    }],
    ['SOURCE_HTTP_ERROR', async () => new Response('', { status: 503, statusText: 'Service Unavailable' })],
    ['SOURCE_BODY_UNREADABLE', async () => new Response(
      new ReadableStream({ start(c) { c.error(new Error('body broke')) } }),
      { status: 200, headers: { 'content-length': '10' } })],
  ]

  it.each(FETCH_CASES.map((c) => [c[0], c] as const))(
    '**%s を io.fetch の注入だけで踏む**',
    async (_n, [want, f]) => {
      let called = 0
      const { io } = passthroughIo({
        fetch: (...a: unknown[]) => { called += 1; return f(...(a as [])) },
      })
      const r = await run(['--manifest', MANIFEST, '--tag', 'v0.6.15', '--fetch', 'github'], io)
      expect(r.json.stableReasonCode).toBe(want)
      expect(r.json.status).toBe('SOURCE_UNAVAILABLE')
      expect(r.code).toBe(2)
      /** **本当に注入した fetch を通ったこと。**通っていなければ別の経路で止まっている */
      expect(called, 'io.fetch が呼ばれていない').toBe(1)
    },
  )

  /**
   * **対照: `globalThis.fetch` は触っていない。**
   * 触っていたら、この試験は「global の差し替えが効いた」ことしか示さない。
   */
  it('対照: globalThis.fetch を差し替えていない', async () => {
    const before = globalThis.fetch
    const { io } = passthroughIo({ fetch: async () => { throw new TypeError('fetch failed') } })
    await run(['--manifest', MANIFEST, '--tag', 'v0.6.15', '--fetch', 'github'], io)
    expect(globalThis.fetch, 'global を書き換えている').toBe(before)
  })

  it('引数は `args` から取る（`process.argv` を見ていない）', async () => {
    const { io } = passthroughIo()
    const r = await run([], io)
    /** `--source` も `--tag` も無いので、引数不足で止まる */
    expect(r.json.stableReasonCode).toBe('CLI_ARGUMENTS_MISSING')
  })
})

/**
 * **`done()` を通らずに戻る経路が無いこと。**
 * 戻ってしまうと CLI 側が「結果を出さずに本体が戻った」として exit 3 にする。
 * それは**この道具の欠陥**なので、通常経路では起きてはいけない。
 */
describe('本体は必ず結果を投げて終わる', () => {
  it('CLI 側に、結果を出さずに戻ったときの受け皿がある', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/verifyReleaseSourceInputs.mjs'), 'utf8')
    expect(src, '戻ってきたときの扱いが無い').toContain('結果を出さずに本体が戻りました')
    expect(src, 'CliResult 以外を握りつぶしている').toContain('if (!(e instanceof CliResult)) throw e')
  })

  it('CLI 側は判定をしない（done も status も書かない）', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/verifyReleaseSourceInputs.mjs'), 'utf8')
    /**
     * **コメントを除いてから見る。**
     * 最初は素の文字列で `done(` を探して落ちたが、当たったのは
     * 「`done()` を通らずに戻ってきたら」という**説明文**だった。
     * 語の有無ではなく**呼び出しの有無**を見る。
     */
    const cli = src.slice(src.lastIndexOf('if (RUN_AS_CLI) {'))
      .split('\n').filter((l) => !l.trimStart().startsWith('/**') && !l.trimStart().startsWith('*')
        && !l.trimStart().startsWith('//')).join('\n')
    expect(cli, 'CLI 側で done を呼んでいる').not.toMatch(/\bdone\(/)
    expect(cli, 'CLI 側で status を組み立てている').not.toMatch(/status:/)
    /** 触ってよいのは io と CliResult だけ */
    expect(cli).toContain('io.exit(r.code)')
    /** **コメントを外した結果が空でないこと**（全部消して通したのでは意味がない） */
    expect(cli.trim().length, 'コメントを外したら中身が消えた').toBeGreaterThan(200)
  })
})
