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
 *   - sensitivity.<slug>.json … provenance.inputDigest（2026-08-03 追加）
 *   - topology-robustness.<slug>.json … provenance.inputDigest（2026-08-03 追加）
 *   キーの一覧を人が保守しないので、走査軸が増えても勝手に追随する。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildProvenance, listRobustnessInputs, listSensitivityInputs } from './provenance'

const ROOT = process.cwd()
const dims = JSON.parse(readFileSync(resolve(ROOT, 'src/data/dimensions.json'), 'utf8')).entries as Record<
  string,
  { value: number }
>
const now = (k: string) => dims[k]?.value

const stale: { artifact: string; reason: string; cmd: string }[] = []
const checked: string[] = []

// --- 1. 目標トポロジー探索 -------------------------------------------------
for (const f of readdirSync(resolve(ROOT, 'artifacts')).filter((x) => x.startsWith('topology_search_'))) {
  const a = JSON.parse(readFileSync(resolve(ROOT, 'artifacts', f), 'utf8'))
  const axes = Object.values(a.searchSpace?.axesByJack ?? {}).flat() as { key: string; shipped: number }[]
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

// --- 2b. 感度 event artifact が入力より古くなっていないか -------------------
//
// **provenance を足しただけでは何も守れない。**現在の入力と突き合わせて初めて意味が出る。
// profile 側で同じ穴が実際に開いていた（記録は目の前にあったのに使っていなかった）ので、
// 感度 artifact にも同じ日に同じ検査を付ける（非阻害フォローアップ P1-1）。
for (const f of readdirSync(resolve(ROOT, 'artifacts')).filter((x) => /^sensitivity\.trs_jack_/.test(x))) {
  const a = JSON.parse(readFileSync(resolve(ROOT, 'artifacts', f), 'utf8'))
  const got = a.provenance?.inputDigest
  if (!got) {
    stale.push({ artifact: f, reason: 'provenance.inputDigest が無い', cmd: 'npm run sensitivity:events:all' })
    continue
  }
  // 記録された設定をそのまま使う。走査軸や刻みを変えた場合は
  // scripts/sensitivityEvents.ts 自身が入力なので、ファイルの指紋の側で捕まる
  const wanted = buildProvenance({
    root: ROOT,
    inputs: listSensitivityInputs(ROOT),
    settings: a.provenance.inputSettings,
    command: 'check:stale',
    artifactDate: '1970-01-01',
    release: false,
    allowRevisionOverride: false,
  }).inputDigest
  checked.push(`${f}: inputDigest ${String(got).slice(0, 12)}`)
  if (got !== wanted)
    stale.push({
      artifact: f,
      reason: `入力が変わっている (記録 ${String(got).slice(0, 12)} → 現在 ${wanted.slice(0, 12)})`,
      cmd: `npm run sensitivity:events -- --variant "${a.variantId}"`,
    })
}

// --- 2c. 目標トポロジーの頑健性 artifact ------------------------------------
// 約 12 分かかる重い成果物。古いまま残ると「この仮定でも目標は残る」が嘘になる。
for (const f of readdirSync(resolve(ROOT, 'artifacts')).filter((x) => /^topology-robustness\./.test(x))) {
  const a = JSON.parse(readFileSync(resolve(ROOT, 'artifacts', f), 'utf8'))
  const got = a.provenance?.inputDigest
  if (!got) {
    stale.push({ artifact: f, reason: 'provenance.inputDigest が無い', cmd: 'npm run search:robustness' })
    continue
  }
  const wanted = buildProvenance({
    root: ROOT,
    inputs: listRobustnessInputs(ROOT),
    settings: a.provenance.inputSettings,
    command: 'check:stale',
    artifactDate: '1970-01-01',
    release: false,
    allowRevisionOverride: false,
  }).inputDigest
  checked.push(`${f}: inputDigest ${String(got).slice(0, 12)}`)
  if (got !== wanted)
    stale.push({
      artifact: f,
      reason: `入力が変わっている (記録 ${String(got).slice(0, 12)} → 現在 ${wanted.slice(0, 12)})`,
      cmd: 'npm run search:robustness',
    })
}

// --- 3. profile が入力より古くなっていないか -------------------------------
//
// **2026-08-03 の完了条件の通し確認で見つかった穴。**
// profile は provenance.inputDigest に「何から作ったか」を記録しているのに、
// **それを現在の入力と突き合わせる検査がどこにも無かった。**
//
// 実際に古くなっていた。ajv を dev 依存へ足したとき package-lock.json が変わり、
// これは digest の対象なので profile を作り直す必要があったが、誰も気付かなかった。
// 記録は目の前にあったのに使っていなかった。
//
// 重い成果物と違い profile は数秒で作り直せるが、**古いまま公開されるのは同じ害**である。
// **variant ごとに計算する。** 感度 artifact は variant 別なので、
// 単一の digest と比べると必ず食い違う (P1-2)
const wantedFor = (variantId: string) =>
  buildProvenance({
    root: ROOT,
    variantSlug: variantId.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
    command: 'check:stale',
    artifactDate: '1970-01-01', // digest に日付は入らない。何を入れても同じ
    release: false,
    allowRevisionOverride: false,
  }).inputDigest

for (const f of readdirSync(resolve(ROOT, 'artifacts')).filter((x) => x.startsWith('half_plug_topology_profile'))) {
  const a = JSON.parse(readFileSync(resolve(ROOT, 'artifacts', f), 'utf8'))
  const got = a.provenance?.inputDigest
  if (!got) {
    stale.push({ artifact: f, reason: 'provenance.inputDigest が無い', cmd: 'npm run export:half-plug:all' })
    continue
  }
  const wanted = wantedFor(String(a.variantId))
  checked.push(`${f}: inputDigest ${String(got).slice(0, 12)}`)
  if (got !== wanted)
    stale.push({
      artifact: f,
      reason: `入力が変わっている (記録 ${String(got).slice(0, 12)} → 現在 ${wanted.slice(0, 12)})`,
      cmd: 'npm run export:half-plug:all',
    })
}

// --- 出力 -----------------------------------------------------------------
for (const c of checked) console.log(`  照合: ${c}`)
if (!stale.length) {
  console.log('\n重い成果物は現在のモデルと整合しています。再実行は不要です。')
  process.exit(0)
}
console.log('\n**再実行が必要です。**')
const byCmd: Record<string, typeof stale> = {}
for (const s of stale) (byCmd[s.cmd] ??= []).push(s)
for (const [cmd, list] of Object.entries(byCmd)) {
  console.log(`\n  ${cmd}`)
  for (const s of list) console.log(`    ${s.artifact}: ${s.reason}`)
}
process.exit(1)
