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

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  ]
}
