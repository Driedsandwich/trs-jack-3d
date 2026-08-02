/**
 * テストが「通った」のか「そもそも走っていない」のかを分ける。
 *   npm run check:vacuity
 *
 * ## 何のためか
 *
 * このリポジトリでは 2026-08-02〜03 に **7 回**、同じ形の欠陥を作った。
 * 「識別子で引く → 見つからない → それでもテストが通る」である (一覧は test/_must.ts)。
 *
 * 構文を機械で洗うのは筋が悪い。候補は 142 件あったが、そのうち
 * **本当に偽の合格になるのは 7 件**だった (誤検出 95 %)。`.find(...)!` は
 * 引けなければ TypeError で落ちるし、空の `for..of` はモデルが壊れた印であって、
 * それは他の数十件が先に捕まえる。
 *
 * 代わりに**結果の側**を見る。空振りは形がばらばらでも、必ず次のどちらかで現れる。
 *
 *   1. テストが skip される (describe.skipIf / it.skip)
 *   2. テストの件数が減る (ファイルが読めない / 動的生成が 0 件になる / 消された)
 *
 * どちらも `artifacts/test_counts.json` と突き合わせれば分かる。
 * **構文ではなく件数を見るので、新しい形の空振りにも効く。**
 *
 * ## 下限として使う
 *
 * byFile の値は「これ以上減ってはいけない」線として使う。
 * 減らす変更が正しいこともある (テストを統合した等) が、そのときは
 * npm run test:count で artifact を更新し、**なぜ減ったかをコミットに書く**。
 * 黙って減ることだけを止める。
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = process.cwd()
const TMP = resolve(ROOT, 'node_modules/.cache/check-vacuity.json')
const RECORDED = resolve(ROOT, 'artifacts/test_counts.json')

mkdirSync(resolve(ROOT, 'node_modules/.cache'), { recursive: true })
// テストが落ちても続ける。ここで見たいのは合否ではなく「走ったか」
try {
  execFileSync('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${TMP}`], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
} catch {
  /* レポートが書けていれば続行する */
}

const r = JSON.parse(readFileSync(TMP, 'utf8'))
rmSync(TMP, { force: true })
const recorded = JSON.parse(readFileSync(RECORDED, 'utf8'))

const problems = []

// --- 1. 飛ばされたテスト -----------------------------------------------------
const skippedNames = []
const byFile = {}
for (const f of r.testResults) {
  const name = f.name.split('/').slice(-1)[0]
  byFile[name] = f.assertionResults.length
  for (const a of f.assertionResults)
    if (a.status === 'skipped' || a.status === 'pending') skippedNames.push(`${name}: ${a.fullName}`)
}
if (skippedNames.length)
  problems.push({
    what: `飛ばされたテストが ${skippedNames.length} 件`,
    why:
      'skip は「通った」ではなく「見ていない」。artifacts/ は 14 件とも git 管理下なので、'
      + '成果物の有無で分岐する必要は無い。',
    detail: skippedNames,
  })

// --- 2. 件数が減っていないか -------------------------------------------------
const dropped = []
for (const [name, floor] of Object.entries(recorded.byFile ?? {})) {
  const now = byFile[name]
  if (now === undefined) dropped.push(`${name}: ${floor} 件 → **ファイルごと走っていない**`)
  else if (now < floor) dropped.push(`${name}: ${floor} → ${now} 件 (${floor - now} 件減)`)
}
if (dropped.length)
  problems.push({
    what: `テスト件数が減っているファイルが ${dropped.length} 件`,
    why:
      '動的生成の入力が消えると、件数だけが静かに減る。'
      + '意図して減らしたなら npm run test:count で更新し、理由をコミットに書く。',
    detail: dropped,
  })

// --- 出力 -------------------------------------------------------------------
const total = Object.values(byFile).reduce((a, b) => a + b, 0)
console.log(`  実行: ${total} 件 / ${Object.keys(byFile).length} ファイル (記録: ${recorded.total} 件)`)
if (!problems.length) {
  console.log('\n空振りしているテストはありません。全件が実際に走っています。')
  process.exit(0)
}
console.log('\n**空振りの疑いがあります。**')
for (const p of problems) {
  console.log(`\n  ${p.what}`)
  console.log(`    ${p.why}`)
  for (const d of p.detail.slice(0, 25)) console.log(`      ${d}`)
  if (p.detail.length > 25) console.log(`      ... 他 ${p.detail.length - 25} 件`)
}
process.exit(1)
