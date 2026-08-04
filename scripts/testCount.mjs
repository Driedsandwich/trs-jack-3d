/**
 * テスト件数を artifact に書き出す。
 *   npm run test:count
 *
 * 何のためか:
 *   2026-08-03 までの 8 コミットすべてで、テスト件数を README / UNKNOWNS /
 *   docs/TEST_RESULTS.md の 3 か所へ手で書き写していた (24 回の手作業)。
 *   数えるのは機械にできる。docs.test.ts がこの artifact と文書を突き合わせる。
 *
 * 静的に `it(` を数えないのはなぜか:
 *   docs.test.ts は CLAIMS 表から it() を動的に生成しているため、
 *   ソースを読んで数えても実際の件数と合わない。実行結果から取る必要がある。
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { migrationFor } from './contractMigration.mjs'

const ROOT = process.cwd()
const TMP = resolve(ROOT, 'node_modules/.cache/test-count.json')
const OUT = resolve(ROOT, 'artifacts/test_counts.json')

/** 引けなければ `UNKNOWN`。**推測で埋めない** */
const gitHead = () => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'UNKNOWN'
  }
}
const runnerVersion = () => {
  try {
    return JSON.parse(readFileSync(resolve(ROOT, 'node_modules/vitest/package.json'), 'utf8')).version
  } catch {
    return 'UNKNOWN'
  }
}

mkdirSync(resolve(ROOT, 'node_modules/.cache'), { recursive: true })
/**
 * **失敗しても続ける。生成は止めない。**
 *
 * vitest はテストが落ちると非ゼロで終了するが、JSON レポートは書く。
 * ここで例外にすると「件数の照合が落ちている間は件数を更新できない」という循環になる
 * (実際に一度そうなった)。件数を数えるのが目的なので、成否は記録するだけにする。
 *
 * ## 止めるのは配布側（v0.4.1・P0-1/P0-2）
 *
 * v0.4.0 では、**2 件落ちている時点でこれを回し、直したあと取り直さなかった。**
 * 件数は変わらなかったので `total` を突き合わせる検査は通り、
 * `allPassed: false` のまま公開された。
 *
 * 生成を止める設計にすると上の循環に戻るので、**生成は許して配布を止める。**
 * `npm run release:stage` が `allPassed !== true` を拒否し、
 * `validation-results.json` の `releaseReadinessStatus` にも出す。
 */
let exitCode = 0
try {
  execFileSync('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${TMP}`], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
} catch (e) {
  exitCode = typeof e.status === 'number' ? e.status : 1
  // レポートが書けていれば続行する。書けていなければ次の readFileSync で落ちる
}

const r = JSON.parse(readFileSync(TMP, 'utf8'))
rmSync(TMP, { force: true })

const byFile = {}
let skipped = 0
for (const f of r.testResults) {
  byFile[f.name.split('/').slice(-1)[0]] = f.assertionResults.length
  // **飛ばされたテストを数える。** 0 でないと npm run check:vacuity が落ちる。
  // 「通った」と「そもそも走っていない」を同じ緑にしないため (→ CONTRIBUTING §7)
  skipped += f.assertionResults.filter((a) => a.status === 'skipped' || a.status === 'pending').length
}
const total = Object.values(byFile).reduce((a, b) => a + b, 0)

// ARTIFACT_DATE で固定できる。既存 artifact と同じ規約
const generatedAt = process.env.ARTIFACT_DATE ?? new Date().toISOString().slice(0, 10)

mkdirSync(resolve(ROOT, 'artifacts'), { recursive: true })
writeFileSync(
  OUT,
  JSON.stringify(
    {
      schemaVersion: 2,
      contractMigration: migrationFor('test-counts.v2'),
      generatedAt,
      note:
        'npm run test:count で生成。README と UNKNOWNS には件数を書かない (読者に意味が無く、'
        + '手作業が増えるだけだった)。docs/TEST_RESULTS.md の件数だけをこの artifact と突き合わせる。'
        + 'byFile は npm run check:vacuity の下限としても使う。件数が減る変更は理由を書く。',
      total,
      byFile: Object.fromEntries(Object.entries(byFile).sort()),
      skipped,
      /**
       * **同じ実行から取る（v0.4.1・P0-1）。**
       * `allPassed` だけだと「なぜ false なのか」が残らず、
       * 直したあと取り直したかどうかも分からない。
       */
      failed: r.numFailedTests ?? 0,
      failedSuites: r.numFailedTestSuites ?? 0,
      exitCode,
      allPassed: r.numFailedTests === 0 && exitCode === 0,
      testCommand: 'npx vitest run --reporter=json',
      runner: 'vitest',
      runnerVersion: runnerVersion(),
      nodeVersion: process.version,
      generatedFromCommit: gitHead(),
    },
    null,
    1,
  ) + '\n',
)
console.log(`artifacts/test_counts.json: 合計 ${total} 件 / ${Object.keys(byFile).length} ファイル`)
for (const [k, v] of Object.entries(byFile).sort()) console.log(`  ${k.padEnd(30)} ${v}`)
if (r.numFailedTests || exitCode) {
  console.log(`\n  **失敗 ${r.numFailedTests} 件 / exit ${exitCode}。件数は記録したが、この artifact では配布できない。**`)
  console.log('  npm run release:stage が allPassed !== true を拒否する。直してから取り直すこと。')
}
