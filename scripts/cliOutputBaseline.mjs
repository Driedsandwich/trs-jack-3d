/**
 * **CLI の出力を、経路ごとに sha256 で固定する（v0.6.18・core/CLI 分離の段 0）。**
 *
 *   node scripts/cliOutputBaseline.mjs           # 基準を書き出す
 *   node scripts/cliOutputBaseline.mjs --check   # 基準と食い違ったら落ちる
 *
 * ## なぜ要るか
 *
 * core / CLI 分離は「**何も変えない**」変更である。だが「変えていない」は
 * それ自体では確かめられない——**分離する前に基準を取っておかないと、
 * 分離したあとで何と比べればよいか分からなくなる。**
 *
 * ## byte で比べる（JSON として比べない）
 *
 * `JSON.parse` して深く比べると、**キーの順序が変わっても通ってしまう。**
 * 受け手は文字列として受け取り、`diff` を取り、digest を計算する。
 * 順序が変われば受け手の差分も変わるので、**こちらも byte で比べる。**
 *
 * ## 非決定な要素が無いことは実測してある
 *
 * 出力に日付も絶対パスも入らない（2026-08-15 実測）。
 * もし将来入るようになったら、この基準は毎回ずれるので**すぐ気づく。**
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { injectedRoutes } from '../test/_cliRoutes.mjs'

const ROOT = process.cwd()
export const BASELINE_PATH = 'test/fixtures/cli-output-baseline.v1.json'
const TOOL = 'scripts/verifyReleaseSourceInputs.mjs'
const sha256 = (s) => createHash('sha256').update(s).digest('hex')

/** `OK` を出すための**固定 fixture**（`artifacts/` を読まない） */
const OK_FIXTURE = 'test/fixtures/ok-source'

/**
 * 注入で踏む 7 経路に、**注入なしの 2 経路**を足す。
 *
 * 引数なしと `OK` は `_cliRoutes.mjs` に無い——あの表は
 * 「外部の失敗を注入して踏む経路」の表だからである。
 * 分離で壊れやすいのは**むしろ普通の経路**なので、ここでは一緒に測る。
 *
 * ## `OK` は固定 fixture に対して測る（v0.6.18・基準を取り直して分かったこと）
 *
 * 最初は `--source .` で作業ツリーを検算していた。だが**その出力は
 * `artifacts/source-input-manifest.json` の中身に依る**ので、
 * artifact を再生成しただけで基準が古くなり、**CI が誤検出する。**
 * 実際、分離のあと evidence を作り直した時点で `OK` 経路だけが不一致になった
 * （分離前の道具でも同じ新しい digest が出たので、**原因は分離ではない**と実測できた）。
 *
 * 測りたいのは「分離が出力を変えていないか」なので、**入力のほうを固定する。**
 */
export function allBaselineRoutes(keep) {
  return [
    { label: '引数なし', args: [] },
    {
      label: 'OK（固定 fixture を検算）',
      args: ['--manifest', `${OK_FIXTURE}/source-input-manifest.json`, '--source', OK_FIXTURE],
    },
    ...injectedRoutes(keep),
  ]
}

/**
 * 1 経路を走らせて、stdout / stderr / 終了コードを返す。
 * **非 0 で投げない**——測りたいのは「どう止まったか」なので、
 * `execFileSync` ではなく `spawnSync` を使う。
 */
export function runRoute(route, root = ROOT) {
  const argv = [...(route.preload ? ['--import', route.preload] : []), TOOL, ...route.args]
  const p = spawnSync('node', argv, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: { ...process.env, ...(route.env ?? {}) },
  })
  return { stdout: String(p.stdout ?? ''), stderr: String(p.stderr ?? ''), code: p.status ?? -1 }
}

/** 全経路を測る。**digest だけでなく byte 数も持つ**（digest だけだと差が見えない） */
export function measureAll(root = ROOT) {
  const keep = []
  try {
    return allBaselineRoutes(keep).map((route) => {
      const { stdout, stderr, code } = runRoute(route, root)
      return {
        label: route.label,
        args: route.args,
        injected: route.preload ? 'fetch' : (route.env ? 'PATH' : null),
        exitCode: code,
        stdoutBytes: Buffer.byteLength(stdout),
        stdoutSha256: sha256(stdout),
        stderrBytes: Buffer.byteLength(stderr),
        stderrSha256: sha256(stderr),
      }
    })
  } finally {
    for (const d of keep) rmSync(d, { recursive: true, force: true })
  }
}

/** 基準と実測を突き合わせる。**空配列なら一致** */
export function diffBaseline(live, recorded) {
  const problems = []
  const byLabel = new Map((recorded.routes ?? []).map((r) => [r.label, r]))
  if (live.length !== (recorded.routes ?? []).length) {
    problems.push(`経路の数が違う: 実測 ${live.length} / 基準 ${recorded.routes?.length ?? 0}`)
  }
  for (const a of live) {
    const b = byLabel.get(a.label)
    if (!b) {
      problems.push(`${a.label}: 基準に無い経路`)
      continue
    }
    for (const k of ['exitCode', 'stdoutBytes', 'stdoutSha256', 'stderrBytes', 'stderrSha256']) {
      if (a[k] !== b[k]) problems.push(`${a.label} の ${k}: 実測 ${a[k]} / 基準 ${b[k]}`)
    }
  }
  for (const label of byLabel.keys()) {
    if (!live.some((a) => a.label === label)) problems.push(`${label}: 実測に無い（経路が消えた）`)
  }
  return problems
}

if (resolve(process.argv[1] ?? '') === resolve(import.meta.filename)) {
  const live = measureAll()
  const p = resolve(ROOT, BASELINE_PATH)

  if (process.argv.includes('--check')) {
    const recorded = JSON.parse(readFileSync(p, 'utf8'))
    const problems = diffBaseline(live, recorded)
    console.log(`\n  ${live.length} 経路を実測し、基準（${recorded.takenAt} / ${recorded.takenFromCommit.slice(0, 12)}）と突き合わせました。`)
    if (!problems.length) {
      console.log('  **全経路で stdout / stderr / 終了コードが byte 一致しています。**\n')
      process.exit(0)
    }
    console.log('不合格: **出力が基準と違います。**')
    for (const x of problems) console.log(`  - ${x}`)
    console.log('')
    process.exit(1)
  }

  const out = {
    schemaVersion: 1,
    schemaId: 'trs-jack-3d-cli-output-baseline.v1',
    purpose:
      '**core / CLI 分離が「何も変えていない」ことを確かめるための基準。**'
      + '分離の前に取り、分離のあとで byte 一致を見る。'
      + 'JSON として比べず byte で比べる——キーの順序が変われば受け手の差分も変わるため。',
    takenAt: process.env.ARTIFACT_DATE ?? new Date().toISOString().slice(0, 10),
    takenFromCommit: (() => {
      try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
      } catch {
        return 'UNKNOWN'
      }
    })(),
    toolSha256: sha256(readFileSync(resolve(ROOT, TOOL))),
    routes: live,
  }
  writeFileSync(p, JSON.stringify(out, null, 1) + '\n')
  console.log(`  ${BASELINE_PATH} に ${live.length} 経路を記録しました。`)
  for (const r of live) {
    console.log(`    ${String(r.label).padEnd(30)} exit ${r.exitCode} / stdout ${String(r.stdoutBytes).padStart(6)} B / stderr ${String(r.stderrBytes).padStart(5)} B`)
  }
}
