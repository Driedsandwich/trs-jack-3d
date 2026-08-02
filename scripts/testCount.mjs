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

const ROOT = process.cwd()
const TMP = resolve(ROOT, 'node_modules/.cache/test-count.json')
const OUT = resolve(ROOT, 'artifacts/test_counts.json')

mkdirSync(resolve(ROOT, 'node_modules/.cache'), { recursive: true })
// **失敗しても続ける。** vitest はテストが落ちると非ゼロで終了するが、JSON レポートは書く。
// ここで例外にすると「件数の照合が落ちている間は件数を更新できない」という循環になる
// (実際に一度そうなった)。件数を数えるのが目的なので、成否は allPassed に記録するだけにする。
try {
  execFileSync('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${TMP}`], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
} catch {
  // レポートが書けていれば続行する。書けていなければ次の readFileSync で落ちる
}

const r = JSON.parse(readFileSync(TMP, 'utf8'))
rmSync(TMP, { force: true })

const byFile = {}
for (const f of r.testResults) {
  byFile[f.name.split('/').slice(-1)[0]] = f.assertionResults.length
}
const total = Object.values(byFile).reduce((a, b) => a + b, 0)

// ARTIFACT_DATE で固定できる。既存 artifact と同じ規約
const generatedAt = process.env.ARTIFACT_DATE ?? new Date().toISOString().slice(0, 10)

mkdirSync(resolve(ROOT, 'artifacts'), { recursive: true })
writeFileSync(
  OUT,
  JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt,
      note:
        'npm run test:count で生成。README と UNKNOWNS には件数を書かない (読者に意味が無く、'
        + '手作業が増えるだけだった)。docs/TEST_RESULTS.md の件数だけをこの artifact と突き合わせる。',
      total,
      byFile: Object.fromEntries(Object.entries(byFile).sort()),
      allPassed: r.numFailedTests === 0,
    },
    null,
    1,
  ) + '\n',
)
console.log(`artifacts/test_counts.json: 合計 ${total} 件 / ${Object.keys(byFile).length} ファイル`)
for (const [k, v] of Object.entries(byFile).sort()) console.log(`  ${k.padEnd(30)} ${v}`)
