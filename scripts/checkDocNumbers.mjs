/**
 * 文書中の数値を artifact と機械照合する。
 *   npm run check:doc-numbers
 *
 * **なぜ要るか。** 2026-08-05 に、表のすぐ下のまとめ文だけが表と食い違っている誤りが
 * 2 件見つかった（`VERIFICATION_PLAN` §2-2 の「L だけが 1.35 mm」「他の 3 点は 0.2 mm 以内」、
 * `REAL_JACK_COMPARISON` §3-1 の「Tip 接点が 1.35 mm 奥へ」）。
 * 正しい値は同じ artifact の `contactPositions.deltaMm` にあり、**表は正しかった。**
 * 表を読んだ人と文を読んだ人で結論が変わる状態だった。
 *
 * **この検査が「0 件」と言うときの意味を狭く保つ。**
 * 宣言した対象だけを見て「不一致 0 件」と報告すると、
 * **宣言していない数値がいくらずれていても 0 件になる**（v0.5.2 の allowlist と同じ穴）。
 * そこで次を必ず同時に出す。
 *
 *   1. 走査した文書と、抽出した mm 値の総数
 *   2. **artifact で裏が取れなかった数の件数**（これが本体。0 にはならない）
 *   3. 宣言照合の結果（一致 / 不一致 / **本文に無い**＝宣言が空振り）
 *   4. md ↔ html の同期（生成し直して byte 比較）
 *   5. **自己検査**（検出器がわざと入れた誤りを実際に捕まえるか）
 *
 * 5 が落ちたら、他の結果は全部無効として非 0 で終わる。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { TARGETS, renderToString } from './mdToHtml.mjs'
import { allCases } from '../test/_corruptTar.mjs'
import { expectedOutcome } from '../test/_tarExpectations.mjs'

const ROOT = process.cwd()
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8')

// ---------------------------------------------------------------- artifact 側の値集合

/**
 * 文書は小数第 2 位まで丸めて書くので、照合も **±0.005 の窓**で行う。
 *
 * **丸めの実装で合わせようとすると落ちる。**`sensitivity.json` の 12.325 は
 * 二進で 12.32499999… なので `toFixed(2)` が `12.32` を返し、
 * 本文の正しい値 `12.33` を「artifact に無い」と誤判定した（2026-08-05 実測）。
 * 生の値を持って窓で比べる。窓が広すぎないことは自己検査 ③ で確かめる。
 */
const EPS = 0.005 + 1e-9

function collectNumbers() {
  const raw = []
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk)
    if (o && typeof o === 'object') return Object.values(o).forEach(walk)
    if (typeof o === 'number' && Number.isFinite(o)) raw.push(o)
  }
  const dirs = ['artifacts', 'src/data']
  let files = 0
  for (const d of dirs) {
    const dir = resolve(ROOT, d)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      walk(JSON.parse(read(join(d, f))))
      files++
    }
  }
  raw.sort((a, b) => a - b)
  return { vals: raw, files }
}

/** 昇順配列に、v との差が EPS 以内の値があるか */
function near(sorted, v) {
  let lo = 0, hi = sorted.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (Math.abs(sorted[mid] - v) <= EPS) return true
    if (sorted[mid] < v) lo = mid + 1
    else hi = mid - 1
  }
  return false
}

/**
 * **差として引用される値**も裏取りの対象にする。
 * 今回の誤り 2 件はどちらも「2 つの値の差」で、artifact に直接は載っていなかった。
 * 同じ辞書の中の 2 値の差をすべて作る（対象は数の少ない対応表だけ。全 artifact でやると
 * 組み合わせが爆発して、何にでも当たる＝判別力がゼロになる）。
 */
function collectDifferences() {
  const out = []
  const p = 'artifacts/real_jack_comparison.json'
  if (!existsSync(resolve(ROOT, p))) return out
  const d = JSON.parse(read(p))
  const groups = [
    d.contactPositions?.assumed, d.contactPositions?.drawing, d.contactPositions?.deltaMm,
    ...Object.values(d.testerPredictions ?? {}).filter((v) => v && typeof v === 'object'),
  ].filter(Boolean)
  for (const g of groups) {
    const nums = Object.values(g)
      .flatMap((v) => (v && typeof v === 'object' ? Object.values(v) : [v]))
      .filter((v) => typeof v === 'number')
    for (const a of nums) for (const b of nums) out.push(Math.abs(a - b))
  }
  out.sort((a, b) => a - b)
  return out
}

// ---------------------------------------------------------------- 文書側の mm 値

const MM = /(\d+(?:\.\d+)?)\s*mm/g

function extractMm(md) {
  const hits = []
  md.split('\n').forEach((line, idx) => {
    if (/^\s*(?:\/\/|#{1,6}\s)/.test(line)) return
    for (const m of line.matchAll(MM)) hits.push({ line: idx + 1, value: parseFloat(m[1]), text: line.trim() })
  })
  return hits
}

// ---------------------------------------------------------------- 宣言照合
//
// **宣言は「本文の文字列」と「artifact から計算した真値」の組**にする。
// 本文が書き換わったら「本文に無い」で落ちるので、宣言だけが古く残ることがない。

function declarations() {
  const rj = JSON.parse(read('artifacts/real_jack_comparison.json'))
  const delta = rj.contactPositions.deltaMm
  const tp = rj.testerPredictions
  const gap = (k) => +(tp.assumed[k].shoulderGapMm - tp.drawing[k].shoulderGapMm).toFixed(2)
  const trrs = JSON.parse(read('artifacts/half_plug_topology_profile.v3.trs_jack_trrs.json'))
  const trs = JSON.parse(read('artifacts/half_plug_topology_profile.v3.trs_jack_trs.json'))
  const tc = JSON.parse(read('artifacts/test_counts.json'))
  const vr = JSON.parse(read('artifacts/validation-results.json'))
  const vs = JSON.parse(read('artifacts/verification_summary.json')).gradeCounts
  const iv = trrs.intervals.find((x) => x.intervalId === 'IV028')
  const man = JSON.parse(read('artifacts/source-input-manifest.json'))

  /**
   * corpus の数は artifact ではなく試験の材料そのものから引く（v0.6.12）。
   * **`ok` 旗ではなく期待値表から数える**——旗は v0.6.11 で消した（誰も検査していなかった）。
   */
  const corpusCases = allCases()
  const corpusTotal = Object.values(corpusCases).flat().length
  const corpusGroups = Object.keys(corpusCases).length
  const corpusSafe = Object.entries(corpusCases)
    .flatMap(([kind, list]) => list.map((c) => expectedOutcome(kind, c.id)))
    .filter((w) => w === 'safe').length

  /** 手元に控えのある release のうち最大の版数（`docs/release/<tag>-SHA256SUMS.txt`） */
  const latestRecordedTag = readdirSync(resolve(ROOT, 'docs/release'))
    .map((f) => /^(v\d+\.\d+\.\d+)-SHA256SUMS\.txt$/.exec(f)?.[1])
    .filter(Boolean)
    .sort((a, b) => a.slice(1).split('.').map(Number).reduce((s, n, i) => s || n - Number(b.slice(1).split('.')[i]), 0))
    .pop()

  return [
    ['docs/VERIFICATION_PLAN.md', '**L だけが 1.45 mm 離れています。**', Math.abs(gap('L')) === 1.45],
    ['docs/VERIFICATION_PLAN.md', '次点は GND（0.34 mm）', Math.abs(gap('GND')) === 0.34],
    ['docs/VERIFICATION_PLAN.md', 'MIC と R は 0.05 mm 以内',
      Math.abs(gap('MIC')) <= 0.05 && Math.abs(gap('R')) <= 0.05],
    ['docs/VERIFICATION_PLAN.md', 'Tip = **1.45**、', delta['trrs.jack.contact.tip.axialCenter'] === 1.45],
    ['docs/VERIFICATION_PLAN.md', 'Ring2（GND）= **-0.34**', delta['trrs.jack.contact.ring2.axialCenter'] === -0.34],
    ['docs/VERIFICATION_PLAN.md', '> **Tip だけが 1.45 mm 奥**です', delta['trrs.jack.contact.tip.axialCenter'] === 1.45],
    ['docs/REAL_JACK_COMPARISON.md', 'Tip 接点が 1.45 mm 奥へ動いたため', delta['trrs.jack.contact.tip.axialCenter'] === 1.45],
    // 募集文（2026-08-06 追記）。**測る方が最初に読む数字なので、宣言で縛る**
    ['docs/VERIFICATION_PLAN.md', '| 見分けたいのは | すき間が **2.14 mm** か **0.69 mm** か |',
      tp.assumed.L.shoulderGapMm === 2.14 && tp.drawing.L.shoulderGapMm === 0.69],
    ['docs/VERIFICATION_PLAN.md', '| その差 | **1.45 mm** ＝ **デジタルノギスの分解能 0.01 mm の 145 倍** |',
      Math.abs(gap('L')) === 1.45 && Math.round(Math.abs(gap('L')) / 0.01) === 145],
    ['docs/V060_PLAN_20260805.md', 'IV028  nominalStartMm 13.3  /  nominalEndMm 13.52   幅 0.22 mm',
      iv.nominalStartMm === 13.3 && iv.nominalEndMm === 13.52],
    ['docs/V060_MEASUREMENT_DECISION_20260805.md', 'すき間 **2.14 mm** か **0.69 mm** か',
      tp.assumed.L.shoulderGapMm === 2.14 && tp.drawing.L.shoulderGapMm === 0.69],
    ['docs/V060_MEASUREMENT_DECISION_20260805.md', '8.33 か 8.67 か',
      tp.assumed.GND.shoulderGapMm === 8.33 && tp.drawing.GND.shoulderGapMm === 8.67],
    ['docs/release/v0.6.0-notes.md', `| 検証対象（\`validate:profiles\`） | 13 | **${vr.targetsTotal}** |`, true],
    ['docs/release/v0.6.0-notes.md', `| 根拠の区分 | FACT ${vs.FACT} / DERIVED ${vs.DERIVED} / ASSUMPTION ${vs.ASSUMPTION} | **変わらず** |`, true],
    ['docs/release/v0.6.0-notes.md', `**変わらず**（TRS ${trs.intervals.length}/${trs.events.length}・TRRS ${trrs.intervals.length}/${trrs.events.length}）`, true],

    /**
     * **SECURITY.md と TEST_RESULTS.md をここへ入れた（v0.6.12）。**
     *
     * v0.6.11 まで、この 2 つは宣言照合の対象に 1 件も入っていなかった。
     * 実測すると **4 件が古いまま**だった——直近 release が 3 版前、corpus が 26 個（実際は 182 個）、
     * 通す材料が 66 個（**旗から数えた誤り**。実際は 72 個）、入力が 29 件（実際は 32 件）。
     * **どれも artifact から確かめられる数**なのに、誰も見ていなかった。
     */
    ['SECURITY.md', `**すべての細工に耐えることは示していません。**${corpusTotal} 個・${corpusGroups} 種類で試験した範囲までです`, true],
    ['SECURITY.md', `v16 では corpus の「通す」材料を ${corpusSafe} 個へ増やしました`, true],
    ['docs/TEST_RESULTS.md', `| 単体テスト | \`npm run test\` | **${tc.total} 件**`, true],
    ['docs/TEST_RESULTS.md', `**入力 ${man.inputFilesTotal} 件すべて一致**`, true],
    /**
     * 直近 release だけは artifact に無いので、**手元の SHA256SUMS の控えの最大版数**で縛る。
     * 版を出したら控えを置く運用なので、控えが増えればここも動く。
     */
    ['SECURITY.md', `- 直近の release 1 本（現時点では ${latestRecordedTag}）`, true],

    /** 根拠の区分。**3 つの文書が同じ数を別々に書いている**ので、3 つとも縛る */
    ['SECURITY.md', `**\`ASSUMPTION\` が ${vs.ASSUMPTION} 件あります**`, true],
    ['README.md', `（寸法 ${vs.FACT + vs.DERIVED + vs.ASSUMPTION + vs.UNKNOWN} 件のうち ${vs.ASSUMPTION} 件が仮定）`, true],
    ['README.md', `仮定は全体で ${vs.ASSUMPTION} 件`, true],
  ]
}

// ---------------------------------------------------------------- 公開済み文書の凍結値
//
// **公開した release notes は、作業ツリーの artifact を追いかけない。**
//
// v0.6.0 を出したあとに profile を作り直すと ID が変わる。
// それに合わせて notes を書き換えると、**公開済みの本文と手元の notes がずれる**——
// しかも本文のほうが古いまま残るので、受け手が読む数字と食い違う。
// 公開した本文は編集しない方針なので、**手元の控えのほうを凍結する。**
//
// 凍結して確かめるのは「公開したときの値が、いまも同じ文字列で書いてあるか」だけになる。
// artifact との突き合わせは、その release を出したときに済んでいる
// （`docs/release/<tag>-SHA256SUMS.txt` が配布物そのものの控え）。
//
// **凍結できるのは tag が実在する release の notes だけ。**
// 未公開の文書を凍結すると、artifact との照合から静かに逃げられてしまう。

const FROZEN = [
  { tag: 'v0.6.0', file: 'docs/release/v0.6.0-notes.md', text: 'v0.6.0  trs-jack-3d:TRS|JACK-TRS:480daac80519' },
  { tag: 'v0.6.0', file: 'docs/release/v0.6.0-notes.md', text: 'v0.6.0  trs-jack-3d:TRS|JACK-TRRS:b5b1e5ff2dba' },
  { tag: 'v0.6.0', file: 'docs/release/v0.6.0-notes.md', text: '| 単体テスト | 570 | **681**（skip 0） |' },
  { tag: 'v0.6.0', file: 'docs/release/v0.6.0-notes.md', text: 'docs/measurements/measurement-records.v1.json@sha256:dfe5020f9198' },
]

// ---------------------------------------------------------------- 説明済みの未照合値
//
// **裏が取れない ≠ 誤り。**点検して理由が付いたものはここへ移し、
// 「まだ誰も見ていない件数」だけが残るようにする。
// 理由の付いていない数が減らないと、この検査は進捗を主張できない。
// **使われなくなった注記は落とす**（宣言と同じで、空振りしたまま残らないようにする）。

const EXPLAINED = [
  { file: 'docs/VERIFICATION_PLAN.md', values: [11.23, 12.01, 10.07, 7.03, 8.27, 8.01, 11.11, 12.17, 2.77, 1.99, 6.97, 5.73, 5.99],
    reason: '走査刻み 0.01 mm 時代の出力。現行 profile は stepMm 0.02 なので末尾が 0.01 ずれる。本文もその旨を明記しており、合否は ±0.3 mm で見る' },
  { file: 'docs/REPORT.md', values: [7.21], reason: '実ブラウザのタッチ操作試験で読んだ HUD の値。モデルの出力ではない' },
  { file: 'docs/TEST_RESULTS.md', values: [7.21], reason: '同上' },
  { file: 'docs/SENSITIVITY.md', values: [16.15], reason: 'コードが到達できない深さの範囲を説明した文。モデルの出力ではない' },
  { file: 'ASSUMPTIONS.md', values: [2.75], reason: '表示専用の ASSUMPTION（artifact へ出していない形状パラメータ）' },
]

function explain(unbacked) {
  const used = new Set()
  const rest = []
  for (const u of unbacked) {
    const hit = EXPLAINED.findIndex((e) => e.file === u.file && e.values.some((v) => Math.abs(v - u.value) <= EPS))
    if (hit >= 0) { used.add(hit); continue }
    rest.push(u)
  }
  const stale = EXPLAINED.map((e, i) => (used.has(i) ? null : `${e.file}: ${e.values.join(' / ')}`)).filter(Boolean)
  return { rest, stale }
}

// ---------------------------------------------------------------- 実行

function runDeclarations(overrideDoc) {
  const res = { ok: 0, mismatch: [], absent: [], frozen: 0 }
  for (const [file, needle, truth] of declarations()) {
    const body = overrideDoc && overrideDoc.file === file ? overrideDoc.body : read(file)
    if (!body.includes(needle)) { res.absent.push(`${file}: "${needle}"`); continue }
    if (!truth) { res.mismatch.push(`${file}: "${needle}"`); continue }
    res.ok++
  }
  /**
   * **凍結値。**公開済み notes は artifact を追いかけないので、
   * 「公開したときの文字列がいまも書いてあるか」だけを見る。
   * **凍結できるのは tag が実在する release の notes だけ**——
   * 未公開の文書を凍結すると、artifact との照合から静かに逃げられる。
   */
  for (const { tag, file, text } of FROZEN) {
    if (!/^docs\/release\/v[0-9.]+-notes\.md$/.test(file)) {
      res.mismatch.push(`${file}: 凍結できるのは公開済み release notes だけ`)
      continue
    }
    if (!tagExists(tag)) { res.mismatch.push(`${file}: 凍結の根拠にした tag ${tag} が実在しない`); continue }
    const body = overrideDoc && overrideDoc.file === file ? overrideDoc.body : read(file)
    if (!body.includes(text)) { res.absent.push(`${file}（${tag} 時点で凍結）: "${text}"`); continue }
    res.frozen++
  }
  return res
}

/** tag が実在するか。**凍結の前提**なので、無ければ凍結そのものを不合格にする */
function tagExists(tag) {
  try {
    execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}`], { cwd: ROOT, stdio: 'pipe' })
    return true
  } catch { return false }
}

function runMmSweep(extraDocs = []) {
  const { vals, files: artifactFiles } = collectNumbers()
  const diffs = collectDifferences()
  const docs = [...TARGETS.map((t) => t.md), 'UNKNOWNS.md', 'ASSUMPTIONS.md', 'README.md', 'SOURCES.md']
    .filter((p) => existsSync(resolve(ROOT, p)))
  const seen = new Set()
  const scanned = []
  for (const p of docs) { if (!seen.has(p)) { seen.add(p); scanned.push({ path: p, body: read(p) }) } }
  for (const d of extraDocs) scanned.push(d)

  let total = 0, backed = 0
  const unbacked = []
  for (const { path: p, body } of scanned) {
    for (const h of extractMm(body)) {
      total++
      if (near(vals, h.value) || near(diffs, h.value)) backed++
      else unbacked.push({ file: p, line: h.line, value: h.value, text: h.text.slice(0, 90) })
    }
  }
  return { artifactFiles, artifactValues: vals.length, diffValues: diffs.length, docs: scanned.length, total, backed, unbacked }
}

function runHtmlSync() {
  const drift = []
  let checked = 0
  for (const t of TARGETS) {
    if (!existsSync(resolve(ROOT, t.html))) { drift.push(`${t.html}: 生成物が無い`); continue }
    const { html } = renderToString(t.md, t.title)
    checked++
    if (html !== read(t.html)) drift.push(`${t.html}: ${t.md} から生成し直すと変わる`)
  }
  return { checked, drift }
}

// ---------------------------------------------------------------- 自己検査（対照）
//
// **検出器が鳴ることを、同じ実行の中で示す。**これが無いと「0 件」が
// 「見つからなかった」なのか「検査が動かなかった」なのか区別できない。

function selfTest() {
  const results = []

  // ① 存在しない mm 値を混ぜたら「裏が取れなかった」に入るか
  const bogus = { path: '<self-test>', body: 'ここに 987.65 mm という artifact に無い値を書く\n' }
  const swept = runMmSweep([bogus])
  const caught = swept.unbacked.some((u) => u.file === '<self-test>' && u.value === 987.65)
  results.push(['① artifact に無い mm 値を検出する', caught])

  // ② 逆に、artifact にある値は裏が取れる（何でも未照合に落とす検出器ではない）
  const rj = JSON.parse(read('artifacts/real_jack_comparison.json'))
  const known = rj.testerPredictions.assumed.L.shoulderGapMm
  const good = { path: '<self-test-positive>', body: `既知の値 ${known} mm を書く\n` }
  const swept2 = runMmSweep([good])
  const notFlagged = !swept2.unbacked.some((u) => u.file === '<self-test-positive>')
  results.push(['② artifact にある mm 値は裏が取れる', notFlagged])

  // ③ **窓が広すぎないこと。**もっともらしい大きさで artifact に無い値は捕まえる
  const { vals } = collectNumbers()
  let absent = null
  for (let v = 1; v < 14 && absent === null; v += 0.01) {
    const r = +v.toFixed(2)
    if (!near(vals, r)) absent = r
  }
  const swept3 = absent === null ? null : runMmSweep([{ path: '<self-test-window>', body: `${absent} mm\n` }])
  results.push([
    `③ artifact に無い現実的な値（${absent ?? '見つからず'} mm）も捕まえる＝窓が広すぎない`,
    absent !== null && swept3.unbacked.some((u) => u.file === '<self-test-window>'),
  ])

  // ③ 宣言の本文を書き換えたら「本文に無い」で鳴るか
  const file = 'docs/REAL_JACK_COMPARISON.md'
  const mutated = { file, body: read(file).replace('Tip 接点が 1.45 mm 奥へ動いたため', 'Tip 接点が 9.99 mm 奥へ動いたため') }
  const decl = runDeclarations(mutated)
  results.push(['④ 宣言した文が変わったら鳴る', decl.absent.some((s) => s.includes(file))])

  return results
}

// ---------------------------------------------------------------- 出力

const sweep = runMmSweep()
const { rest, stale } = explain(sweep.unbacked)
const decl = runDeclarations()
const sync = runHtmlSync()
const self = selfTest()

console.log('文書の数値を artifact と機械照合')
console.log()
console.log(`  走査した文書        ${sweep.docs} 件`)
console.log(`  読んだ artifact     ${sweep.artifactFiles} 件 / 数値 ${sweep.artifactValues} 個 + 差 ${sweep.diffValues} 個`)
console.log(`  抽出した mm 値      ${sweep.total} 件`)
console.log(`    artifact で裏が取れた   ${sweep.backed} 件`)
console.log(`    裏が取れなかった        ${sweep.unbacked.length} 件`)
console.log(`      うち理由を付けた      ${sweep.unbacked.length - rest.length} 件`)
console.log(`      **まだ誰も見ていない** ${rest.length} 件`)
console.log()
console.log(`  宣言照合            一致 ${decl.ok} / 不一致 ${decl.mismatch.length} / 本文に無い ${decl.absent.length}`)
console.log(`  公開済みの凍結値    ${decl.frozen} 件（公開した release notes は artifact を追いかけない）`)
console.log(`  md → html 同期      ${sync.checked} 件検査 / ずれ ${sync.drift.length} 件`)
console.log()
console.log('  自己検査（対照）')
for (const [name, ok] of self) console.log(`    ${ok ? '✓' : '✗'} ${name}`)
console.log()

const show = process.argv.includes('--list')
if (rest.length) {
  console.log(`  まだ誰も見ていない mm 値 ${rest.length} 件${show ? '' : '（--list で全件）'}`)
  for (const u of (show ? rest : rest.slice(0, 10))) {
    console.log(`    ${u.file}:${u.line}  ${u.value} mm  ${u.text}`)
  }
  console.log()
  console.log('  **これは不合格ではありません。**寸法以外の mm（在庫・価格・手順の目安）も入ります。')
  console.log('  合否は宣言照合・html 同期・自己検査で決めます。')
  console.log('  ここの件数は「照合できていない範囲の大きさ」を隠さないために出しています。')
  console.log('  点検して理由が付いたら EXPLAINED へ移してください。この数だけが減ります。')
  console.log()
}

const problems = []
for (const s of decl.mismatch) problems.push(`宣言と artifact が食い違う: ${s}`)
for (const s of decl.absent) problems.push(`宣言した文が本文に無い（宣言が空振り）: ${s}`)
for (const s of sync.drift) problems.push(`md と html がずれている: ${s}`)
for (const s2 of stale) problems.push(`理由を付けた値が本文から消えている（注記が空振り）: ${s2}`)
for (const [name, ok] of self) if (!ok) problems.push(`自己検査が落ちた（他の結果は無効）: ${name}`)

if (problems.length) {
  console.log('不合格:')
  for (const p of problems) console.log(`  - ${p}`)
  process.exit(1)
}
console.log('宣言した数値はすべて artifact と一致し、html も md から生成し直した結果と一致しています。')
console.log(`（裏が取れない mm 値が ${sweep.unbacked.length} 件、うち未点検が ${rest.length} 件あることを、上に出しています）`)
