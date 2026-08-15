/**
 * **外部の失敗を注入して踏む CLI 経路の表（v0.6.16・外部監査 2026-08-14 P0-2 / P1）。**
 *
 * ## なぜ 1 か所にまとめたか
 *
 * v0.6.15 では、到達性の照合（`reasonCodeReachability.test.ts`）が
 * **自分だけの route 一覧**を持っていた。そこに書かなかった経路は当然「出なかった」ので、
 * `SOURCE_HTTP_ERROR` などを `defensive-invariant`（外部入力から到達しない）と宣言し、
 * **その宣言のまま公開した。**外部監査が 4 件とも実経路だと示した。
 *
 * **「この run で出なかった」は「出ない」の証拠にならない。**
 * 契約の検査と到達性の照合が別々の route 表を持つと、また同じことが起きる
 * ——**同じ境界を 2 つの一覧が持つ形**そのものである。ここを唯一の表にする。
 *
 * ## 注入のしかた
 *
 * `node --import <preload>` で `globalThis.fetch` を差し替える。
 * **道具は 1 バイトも変えない。**network も PATH も要らない
 * （`git archive` だけは PATH の先頭へ偽 git を置く——外部プロセスなので注入点がそこしかない）。
 */

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const FETCH_THROWS = "globalThis.fetch = async () => { throw new TypeError('fetch failed') }\n"
const FETCH_TIMES_OUT = "globalThis.fetch = async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e }\n"
const HTTP_503 = "globalThis.fetch = async () => new Response('', { status: 503, statusText: 'Service Unavailable' })\n"
const BODY_BREAKS = "globalThis.fetch = async () => new Response("
  + "new ReadableStream({ start(c) { c.error(new Error('body broke')) } }),"
  + " { status: 200, headers: { 'content-length': '10' } })\n"

/** 使い捨ての preload を書いて file:// URL を返す */
function preload(body, keep) {
  const d = mkdtempSync(join(tmpdir(), 'route-'))
  keep?.push(d)
  const p = join(d, 'inject.mjs')
  writeFileSync(p, body)
  return `file://${p}`
}

/** `git rev-parse` は通し、`git archive` だけ失敗させる偽 git を置いた directory */
function fakeGitDir(keep) {
  const d = mkdtempSync(join(tmpdir(), 'fakegit-'))
  keep?.push(d)
  const p = join(d, 'git')
  writeFileSync(p, '#!/bin/sh\n'
    + 'for a in "$@"; do\n'
    + '  if [ "$a" = "archive" ]; then echo "fatal: injected git archive failure" >&2; exit 128; fi\n'
    + 'done\n'
    + 'exec /usr/bin/git "$@"\n')
  chmodSync(p, 0o755)
  return d
}

/**
 * **確認と使用の間で消される（v0.6.18・外部監査 §8）。**
 *
 * `SOURCE_ARCHIVE_MISSING` は v0.6.17 まで `race-defensive` と宣言していた
 * ——「到達しうるが決定的には踏めない」という分類で、**実際には踏んでいなかった。**
 *
 * 道具の並びはこうなっている。
 *
 * ```
 * loadFromDir(path)      existsSync(abs)  … 通る
 *                        lstatSync(abs)   … ディレクトリでない → loadFromArchive へ
 * loadFromArchive(path)  existsSync(abs)  … **ここで消えていれば SOURCE_ARCHIVE_MISSING**
 * ```
 *
 * つまり**同じ path に対する 2 回目の `existsSync`** で消えていればよい。
 * `node:fs` を差し替えて 1 回目だけ通す。**道具は 1 バイトも変えない**
 * ——`globalThis.fetch` の差し替えと同じ形である。
 */
function vanishingFile() {
  /**
   * **置き場は repo の中の固定した相対パスにする（v0.6.18）。**
   *
   * `mkdtempSync` だと名前が毎回変わり、その名前が `reason` に出るので
   * **出力が実行ごとに変わる**——CLI 出力の基準（`scripts/cliOutputBaseline.mjs`）が
   * 毎回不一致になる。基準は動く状態に依存させない。
   *
   * **`keep` へ積まない（＝呼び側に消させない）。**
   * この表は複数の試験ファイルが**同時に**呼ぶ。固定パスを各ファイルの `afterAll` が
   * 消すと、**まだ使っている隣のファイルの足元から消える**
   * ——実測で 2 件落ちた（単独では通り、3 ファイル同時で落ちる）。
   * 置き場は `node_modules/.cache` の下なので、残っても追跡されないし邪魔にならない。
   * 中身は毎回同じなので、同時に書いても問題にならない。
   */
  const d = resolve(ROOT, 'node_modules/.cache/trs-vanish')
  mkdirSync(d, { recursive: true })
  const target = 'node_modules/.cache/trs-vanish/vanishing.tar.gz'
  writeFileSync(resolve(ROOT, target), 'このファイルは 2 回目の existsSync で消えたことになる\n')
  const p = join(d, 'inject.mjs')
  writeFileSync(p, [
    "import { createRequire } from 'node:module'",
    "const fs = createRequire(import.meta.url)('fs')",
    'const orig = fs.existsSync',
    'let seen = 0',
    '/** **同じ path の 2 回目だけ false。**1 回目は通さないと directory 判定で先に止まる */',
    `fs.existsSync = (p) => {`,
    `  if (String(p).endsWith('trs-vanish/vanishing.tar.gz')) { seen += 1; return seen === 1 }`,
    '  return orig(p)',
    '}',
    '',
  ].join('\n'))
  return { preload: `file://${p}`, target }
}

const MANIFEST = 'artifacts/source-input-manifest.json'
const GH = ['--tag', 'v0.6.15', '--fetch', 'github']

/**
 * **注入で踏める経路。**`keep` に一時 directory を積む（呼び側が片付ける）。
 * 期待する code も一緒に持つ——**表と期待値を別に置くと、また 2 つ目の一覧になる。**
 */
export function injectedRoutes(keep) {
  return [
    { label: '引数不足（--source も --tag も無い）', code: 'CLI_ARGUMENTS_MISSING', args: ['--manifest', MANIFEST] },
    { label: 'GitHub へ繋がらない', code: 'SOURCE_FETCH_FAILED', args: ['--manifest', MANIFEST, ...GH], preload: preload(FETCH_THROWS, keep) },
    { label: 'GitHub からの応答が来ない', code: 'SOURCE_FETCH_TIMEOUT', args: ['--manifest', MANIFEST, ...GH], preload: preload(FETCH_TIMES_OUT, keep) },
    { label: 'GitHub が 503 を返す', code: 'SOURCE_HTTP_ERROR', args: ['--manifest', MANIFEST, ...GH], preload: preload(HTTP_503, keep) },
    { label: '応答本文を読めない', code: 'SOURCE_BODY_UNREADABLE', args: ['--manifest', MANIFEST, ...GH], preload: preload(BODY_BREAKS, keep) },
    {
      label: 'git archive が失敗する',
      code: 'SOURCE_GIT_ARCHIVE_FAILED',
      args: ['--manifest', MANIFEST, '--tag', 'v0.6.15', '--fetch', 'git'],
      env: { PATH: `${fakeGitDir(keep)}:${process.env.PATH}` },
    },
    { label: 'manifest が無い', code: 'MANIFEST_MISSING', args: ['--manifest', '/nonexistent/m.json', '--source', '.'] },
    (() => {
      const { preload: pre, target } = vanishingFile()
      return {
        label: '確認したあとに source が消える',
        code: 'SOURCE_ARCHIVE_MISSING',
        args: ['--manifest', MANIFEST, '--source', target],
        preload: pre,
      }
    })(),
  ]
}
