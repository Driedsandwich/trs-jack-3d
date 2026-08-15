/**
 * **配ろうとしているテスト証拠が、いまのものか（v0.6.16・外部監査 2026-08-14 P0-1）。**
 *
 *   npm run check:test-evidence-current
 *
 * v0.6.15 は **v0.6.14 のテスト証拠で `READY` を名乗って公開された。**
 * 既存の門は 3 つとも通した——`check:vacuity` は下限としてしか見ず、
 * `check:doc-numbers` は**古い文書と古い artifact が一致する**ので通り、
 * `release:evidence` は `allPassed` しか見ていなかった。
 *
 * **一致は現在性の証拠にならない。**この検査だけが「いまのものか」を訊く。
 *
 * ## 何を比べるか
 *
 * `total` / `byFile` / `skipped` / `failed` / `failedSuites` / `exitCode` / `allPassed` を
 * **完全一致**で比べる。`byFile` を下限で見ない——**増えても止める。**
 * 増えた分は記録に入っていないテストであり、その証拠で配ってはいけない。
 *
 * ## 使うところ——**2 つの門は、同じことをしていない**（v0.6.17・外部監査 P1-C）
 *
 * v0.6.16 のこの説明は「両方が必ず通す」と書いていたが、実装は違った。
 * 監査の指摘どおり、実際はこうである。
 *
 * ```
 * release:evidence   由来だけを見る（provenance gate）
 *                    ——証拠を取った commit 以降に、テストへ効くファイルが動いていないか
 * release:stage      実際に測り直して全欄を突き合わせる（live exact gate）
 * check:test-evidence-current / CI   この file を直接叩く（live exact gate）
 * ```
 *
 * **`release:evidence` の中でテストを回さないのには理由がある。**
 * `validation-results.json` はその実行の結果を自分の中へ書くので、
 * 回した瞬間に「いま書いている自分」を含まない証拠になり、**`READY` へ到達できなくなる。**
 * だから生成側は由来だけを見て、実測は配布側（`release:stage`）で行う。
 *
 * 由来の検査は**補助**であって、現在性の最終判定ではない。
 * 最終判定は `release:stage` の live exact gate が行う。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EVIDENCE_FIELDS, diffEvidence, measureTests } from './measureTests.mjs'

const ROOT = process.cwd()
const PATH_TC = 'artifacts/test_counts.json'

/** 記録を読む。無ければ「証拠が無い」として落とす */
export function loadRecorded(root = ROOT) {
  const p = resolve(root, PATH_TC)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}

/** 実測して突き合わせる。問題の一覧を返す（空なら現在のもの） */
export function checkTestEvidenceCurrent(root = ROOT, reportPath = null) {
  const recorded = loadRecorded(root)
  if (!recorded) return { problems: [`${PATH_TC} が無い`], live: null, recorded: null }
  const live = measureTests(root, reportPath)
  return { problems: diffEvidence(live, recorded), live, recorded }
}

if (resolve(process.argv[1] ?? '') === resolve(import.meta.filename)) {
  /** `--report <path>` で、既に取った vitest の JSON を使える（CI で 2 回回さないため） */
  const i = process.argv.indexOf('--report')
  const reportPath = i >= 0 ? process.argv[i + 1] : null
  const { problems, live, recorded } = checkTestEvidenceCurrent(ROOT, reportPath)
  console.log(`\n  実測 ${live?.total ?? '-'} 件 / ${Object.keys(live?.byFile ?? {}).length} ファイル`)
  console.log(`  記録 ${recorded?.total ?? '-'} 件 / ${Object.keys(recorded?.byFile ?? {}).length} ファイル`
    + `（${recorded?.generatedAt ?? '-'} ／ ${String(recorded?.generatedFromCommit ?? '-').slice(0, 12)}）`)
  console.log(`  比べた欄: ${EVIDENCE_FIELDS.join(' / ')} と byFile 全件\n`)
  if (!problems.length) {
    console.log('  テスト証拠はいまのものです。\n')
    process.exit(0)
  }
  console.log('不合格: **記録が実測と違います。配る前に npm run test:count を回し直してください。**')
  for (const p of problems.slice(0, 20)) console.log(`  - ${p}`)
  if (problems.length > 20) console.log(`  … ほか ${problems.length - 20} 件`)
  console.log('')
  process.exit(1)
}
