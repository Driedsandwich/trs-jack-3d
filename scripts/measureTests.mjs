/**
 * **テストを 1 回走らせて、件数の実測値を返す（v0.6.16・外部監査 2026-08-14 P0-1）。**
 *
 * ## なぜ切り出したか
 *
 * v0.6.15 は、**v0.6.14 のテスト証拠を根拠に `READY` を名乗って公開された。**
 * 公開した `test_counts.json` は次のままだった。
 *
 * ```
 * total                1236        （実際の CI は 1304）
 * generatedAt          2026-08-12
 * generatedFromCommit  1c79e059…   （v0.6.14 の第2段のコミット）
 * ```
 *
 * `validation-results.json` の `testEvidence.total` も 1236 で、
 * それでも `releaseReadinessStatus` は `READY` だった。
 *
 * **なぜ誰も止めなかったか。**
 *
 * ```
 * check:vacuity      byFile を「これ以上減ってはいけない下限」として使う
 *                    → 1304 ≥ 1236 なので通る（空振り検査としては正しい）
 * check:doc-numbers  docs/TEST_RESULTS.md と test_counts.json を突き合わせる
 *                    → **どちらも古いので一致する**
 * release:evidence   allPassed / failed / exitCode しか見ない
 *                    → 古いかどうかは一度も見ていない
 * ```
 *
 * **3 つの門が全部「整合している」と言い、誰も「いまのものか」を訊いていなかった。**
 * 一致は現在性の証拠にならない——**古いもの同士は仲良く一致する。**
 *
 * 生成側（`test:count`）と検査側（`check:test-evidence-current`）が
 * **別々に数え方を持つと、また 2 つ目の一覧になる。**ここを唯一の測り方にする。
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * vitest を実行して、`test_counts.json` に入るのと同じ形の実測値を返す。
 *
 * **失敗しても投げない。**テストが落ちている間に「件数を数え直せない」という
 * 循環に入るため（v0.4.1 で実際に入った）。成否は数えた結果として返す。
 */
export function measureTests(root = process.cwd(), reportPath = null) {
  /**
   * **既に取った報告があれば、それを読む。**
   * CI では `npm run test` が同じ run の JSON を書けるので、
   * **同じ工程で 2 回テストを回さない**（時間だけでなく、
   * 2 回目が負荷で flake したときに「証拠が古い」と誤読されるのも避ける）。
   */
  if (reportPath) {
    const r = JSON.parse(readFileSync(reportPath, 'utf8'))
    /** 終了コードは報告から導く。**0 を決め打ちすると、落ちた run を「通った」と数える** */
    return summarize(r, (r.numFailedTests ?? 0) > 0 || (r.numFailedTestSuites ?? 0) > 0 ? 1 : 0)
  }

  const tmp = resolve(root, 'node_modules/.cache/test-count.json')
  mkdirSync(resolve(root, 'node_modules/.cache'), { recursive: true })
  let exitCode = 0
  try {
    execFileSync('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${tmp}`], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'inherit'],
    })
  } catch (e) {
    exitCode = typeof e.status === 'number' ? e.status : 1
  }
  const r = JSON.parse(readFileSync(tmp, 'utf8'))
  rmSync(tmp, { force: true })
  return summarize(r, exitCode)
}

/** vitest の JSON 報告を、`test_counts.json` に入るのと同じ形へ畳む */
function summarize(r, exitCode) {
  const byFile = {}
  let skipped = 0
  for (const f of r.testResults) {
    byFile[f.name.split('/').slice(-1)[0]] = f.assertionResults.length
    skipped += f.assertionResults.filter((a) => a.status === 'skipped' || a.status === 'pending').length
  }
  return {
    total: Object.values(byFile).reduce((a, b) => a + b, 0),
    byFile: Object.fromEntries(Object.entries(byFile).sort()),
    skipped,
    failed: r.numFailedTests ?? 0,
    failedSuites: r.numFailedTestSuites ?? 0,
    exitCode,
    allPassed: r.numFailedTests === 0 && exitCode === 0,
  }
}

/**
 * **実測と記録を 1 つずつ突き合わせる。**
 * 差があれば、どの欄がどうずれているかを返す（空配列なら一致）。
 *
 * `byFile` は**下限ではなく完全一致**で見る。増えたときも止める
 * ——増えた分は「まだ記録に入っていないテスト」であり、
 * その証拠で `READY` を名乗ってはいけない。
 */
export const EVIDENCE_FIELDS = ['total', 'skipped', 'failed', 'failedSuites', 'exitCode', 'allPassed']

export function diffEvidence(live, recorded) {
  const problems = []
  for (const k of EVIDENCE_FIELDS) {
    if (live[k] !== recorded?.[k]) problems.push(`${k}: 実測 ${JSON.stringify(live[k])} / 記録 ${JSON.stringify(recorded?.[k])}`)
  }
  const names = [...new Set([...Object.keys(live.byFile), ...Object.keys(recorded?.byFile ?? {})])].sort()
  for (const n of names) {
    const a = live.byFile[n]
    const b = recorded?.byFile?.[n]
    if (a !== b) problems.push(`byFile.${n}: 実測 ${a ?? '(無し)'} / 記録 ${b ?? '(無し)'}`)
  }
  return problems
}
