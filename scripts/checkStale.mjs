/**
 * 重い成果物が古くなっていないかを判定する。
 *   npm run check:stale
 *
 * 何のためか:
 *   `npm run search:topology` は約 10 分、`npm run sensitivity` は約 15 分かかるので、
 *   毎回は回せない。しかし回し忘れると、**成果物だけが古い値のまま残る**。
 *
 *   CONTRIBUTING.md §3 には「接点位置や区分を変えたときは必要」と書いていたが、
 *   2026-08-03 の通し確認で**その条件が足りない**ことが分かった。
 *   帰線パッド幅を変えたときも両方の再実行が要る（どちらも走査軸に持っている）のに、
 *   手順書からはそう読み取れなかった。人が条件を覚えるのではなく、機械が判定する。
 *
 * どう判定するか:
 *   **成果物自身が「どの値の上で作られたか」を記録している。**それを現在のモデルと突き合わせる。
 *   - topology_search_*.json … searchSpace.axesByJack[*].shipped
 *   - sensitivity.json       … inputs（schemaVersion 5 から）
 *   キーの一覧を人が保守しないので、走査軸が増えても勝手に追随する。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = process.cwd()
const dims = JSON.parse(readFileSync(resolve(ROOT, 'src/data/dimensions.json'), 'utf8')).entries
const now = (k) => dims[k]?.value

const stale = []
const checked = []

// --- 1. 目標トポロジー探索 -------------------------------------------------
for (const f of readdirSync(resolve(ROOT, 'artifacts')).filter((x) => x.startsWith('topology_search_'))) {
  const a = JSON.parse(readFileSync(resolve(ROOT, 'artifacts', f), 'utf8'))
  const axes = Object.values(a.searchSpace?.axesByJack ?? {}).flat()
  if (!axes.length) {
    stale.push({ artifact: f, reason: '走査軸の記録が無い（古い schemaVersion）', cmd: 'npm run search:topology' })
    continue
  }
  const diff = axes.filter((x) => now(x.key) !== undefined && now(x.key) !== x.shipped)
  checked.push(`${f}: 軸 ${axes.length} 件`)
  for (const d of diff)
    stale.push({
      artifact: f,
      reason: `${d.key} が ${d.shipped} → ${now(d.key)} に変わっている`,
      cmd: 'npm run search:topology -- --target DIFFERENCE_SIGNAL',
    })
}

// --- 2. 感度解析 -----------------------------------------------------------
const sp = resolve(ROOT, 'artifacts/sensitivity.json')
if (!existsSync(sp)) {
  stale.push({ artifact: 'sensitivity.json', reason: '存在しない', cmd: 'npm run sensitivity' })
} else {
  const a = JSON.parse(readFileSync(sp, 'utf8'))
  if (!a.inputs) {
    stale.push({
      artifact: 'sensitivity.json',
      reason: '入力値の記録が無い（schemaVersion 5 より前）',
      cmd: 'npm run sensitivity',
    })
  } else {
    checked.push(`sensitivity.json: 入力 ${Object.keys(a.inputs).length} 件`)
    for (const [k, v] of Object.entries(a.inputs))
      if (now(k) !== undefined && now(k) !== v)
        stale.push({ artifact: 'sensitivity.json', reason: `${k} が ${v} → ${now(k)} に変わっている`, cmd: 'npm run sensitivity' })
  }
}

// --- 出力 -----------------------------------------------------------------
for (const c of checked) console.log(`  照合: ${c}`)
if (!stale.length) {
  console.log('\n重い成果物は現在のモデルと整合しています。再実行は不要です。')
  process.exit(0)
}
console.log('\n**再実行が必要です。**')
const byCmd = {}
for (const s of stale) (byCmd[s.cmd] ??= []).push(s)
for (const [cmd, list] of Object.entries(byCmd)) {
  console.log(`\n  ${cmd}`)
  for (const s of list) console.log(`    ${s.artifact}: ${s.reason}`)
}
process.exit(1)
