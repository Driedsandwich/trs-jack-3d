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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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
    return summarizeVitestReport(r, (r.numFailedTests ?? 0) > 0 || (r.numFailedTestSuites ?? 0) > 0 ? 1 : 0)
  }
  const { report, exitCode } = runVitestJson(root)
  return summarizeVitestReport(report, exitCode)
}

/**
 * vitest を 1 回走らせて、JSON 報告と終了コードを返す。
 *
 * **落ちても投げない。**テストが落ちている間に「件数を数え直せない」という循環に入る
 * （v0.4.1 で実際に入った）。成否は `exitCode` として返し、止めるのは配布側で行う。
 */
export function runVitestJson(root = process.cwd()) {
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
  const report = JSON.parse(readFileSync(tmp, 'utf8'))
  rmSync(tmp, { force: true })
  return { report, exitCode }
}

/**
 * vitest の JSON 報告を、`test_counts.json` に入るのと同じ形へ畳む。
 *
 * **これが唯一の集計器（v0.6.17・外部監査 P1-D）。**
 * v0.6.16 まで、`testCount.mjs`（書く側）がこれと同じ処理を**別に持っていた**
 * ——`byFile` の作り方、skip の数え方、`allPassed` の決め方まで二重実装だった。
 * 値がたまたま一致していたので誰も気付かない。**同じ境界を 2 つの一覧で持たない。**
 *
 * 純関数にしてあるので、実行経路（live / 保存済み報告）は別でよい。
 */
export function summarizeVitestReport(r, exitCode) {
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

/**
 * **テストの結果を変えうるファイルの範囲（v0.6.17・外部監査 P1-E）。**
 *
 * v0.6.16 まで `buildReleaseEvidence.mjs` の関数の中に直書きされていて、
 * `tsconfig*.json` と lint 設定が抜けていた。中央へ出し、抜けを埋める。
 *
 * **artifact と文書はここに入れない。**入れると、証拠を書く工程が自分の書き込みで
 * 「古くなった」と判定して収束しない（循環）。
 *
 * **これは補助的な由来の検査に使う範囲であって、現在性の最終判定ではない。**
 * 最終判定は `release:stage` が実際に測り直して行う（`checkTestEvidenceCurrent.mjs` 冒頭）。
 * ここに漏れがあっても最終判定はすり抜けない——漏れると、
 * **`release:evidence` の段階で気付けなくなるだけ**である。
 */
const TEST_INPUT_DIRS = ['test/', 'src/', 'scripts/', 'schemas/']
const TEST_INPUT_FILES = ['package.json', 'package-lock.json', 'vitest.config.ts', '.oxlintrc.json']

/**
 * その時点の実在から範囲を決める。
 * **`tsconfig*.json` を手で並べない**——v0.6.17 の作業中に実際、
 * 手で 3 本書いたら `tsconfig.scripts.json` が抜けた。数は増える。
 */
export function testInputPaths(root = process.cwd()) {
  const tsconfigs = readdirSync(root).filter((f) => /^tsconfig\..*\.json$|^tsconfig\.json$/.test(f))
  return [...TEST_INPUT_DIRS, ...TEST_INPUT_FILES, ...tsconfigs.sort()]
    .filter((p) => p.endsWith('/') || existsSync(resolve(root, p)))
}

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

/**
 * **2 つの証拠を結び直す（v0.6.17・外部監査 P1-B）。**
 *
 * `validation-results.testEvidence` は「どの `test_counts.json` を根拠にしたか」を
 * sha256・commit・日付で名乗る。v0.6.16 はその値を**書いてはいた**が、
 * **名乗った先の実物と突き合わせる工程がどこにも無かった。**
 *
 * 結果として、**片方だけ作り直した状態**——`test_counts.json` は新しいのに
 * `validation-results.json` が古いまま——を、どの検査も単体では通してしまう。
 * 鮮度検査は `test_counts.json` しか見ず、`READY` の検査は文字列しか見ないためである。
 *
 * @param tc         `artifacts/test_counts.json` の中身
 * @param validation `artifacts/validation-results.json` の中身
 * @param tcSha256   `artifacts/test_counts.json` の実ファイルの sha256
 * @returns 食い違いの一覧（空なら一致）
 */
export function crossBindTestEvidence(tc, validation, tcSha256) {
  const problems = []
  const te = validation?.testEvidence
  if (!te) return ['validation-results.json に testEvidence が無い（何を根拠にしたか名乗っていない）']

  if (te.testCountsSha256 !== tcSha256) {
    problems.push(`testCountsSha256: 名乗り ${String(te.testCountsSha256).slice(0, 12)}…`
      + ` / 実物 ${tcSha256.slice(0, 12)}…（別の test_counts.json を指している）`)
  }
  if (te.testCountsGeneratedFromCommit !== (tc.generatedFromCommit ?? null)) {
    problems.push(`testCountsGeneratedFromCommit: 名乗り ${te.testCountsGeneratedFromCommit}`
      + ` / 実物 ${tc.generatedFromCommit}`)
  }
  if (te.testCountsGeneratedAt !== (tc.generatedAt ?? null)) {
    problems.push(`testCountsGeneratedAt: 名乗り ${te.testCountsGeneratedAt} / 実物 ${tc.generatedAt}`)
  }
  /** 数値も同じ 1 つの実行から来ているか。**sha256 が合っていれば従属だが、単独でも読めるようにする** */
  for (const k of EVIDENCE_FIELDS) {
    if (k === 'failedSuites') continue // testEvidence は持たない欄
    const a = te[k]
    const b = tc[k] ?? null
    if (a !== b) problems.push(`${k}: validation ${JSON.stringify(a)} / test_counts ${JSON.stringify(b)}`)
  }
  return problems
}
