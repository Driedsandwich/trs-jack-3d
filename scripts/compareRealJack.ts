/**
 * 実在部品の図面値と、本モデルの仮定値を突き合わせる。
 *   npm run compare:real-jack
 *
 * 何のためか:
 *   4極ジャックの接点位置は一次資料が無く、4 件とも仮定だった (UNKNOWNS §5-2)。
 *   2026-08-02 のデータシート探索で、**接点位置を寸法記入した断面図**を 1 件だけ
 *   見つけた (pro-SIGNAL PS000001)。この図面値を入れると本モデルの結論がどう動くかを
 *   測り、結果を artifact として固定する。
 *
 * 結論を先に書いておく:
 *   **図面値では、看板だった「3極プラグ×4極ジャックで左右差分が残る区間」が消える。**
 *   都合の悪い結果なので、消さずに artifact とテストで固定する。
 *
 * この 1 件で「4極ジャック一般」を語らない:
 *   PS000001 は 1 部品 (SMT・IPX5/7 防水) にすぎない。代表性は主張しない。
 *   また、この部品の接点位置**以外**の諸元 (パッド幅・ばね・端子) は図面に無いので、
 *   本モデルはこの部品を再現していない。差し替えでも variant 追加でもなく、
 *   **比較対象**として扱う。理由は docs/REAL_JACK_COMPARISON.md。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildModelWithOverrides, getModel } from '../src/data'
import { DEFAULT_FAULTS } from '../src/model/contact'
import type { TrsModel } from '../src/model/engine'

const ROOT = resolve(process.cwd())
const STEP = 0.01
const VARIANT = 'TRS|JACK-TRRS' as const

/** ARTIFACT_DATE で固定できる。既存 artifact と同じ規約 */
const generatedAt = () => process.env.ARTIFACT_DATE ?? new Date().toISOString().slice(0, 10)

/**
 * PS000001 の断面図 SEC:A-A から読んだ接点の軸位置。
 * 基準は図中の "* Reference plane" で、完全挿入時にプラグ肩が来る面である
 * (図中の絶縁帯 3 本の位置を目視で読み取って確かめた。docs/REAL_JACK_COMPARISON.md §2)。
 */
const DRAWING: Record<string, number> = {
  'trrs.jack.contact.sleeve.axialCenter': 1.28,
  'trrs.jack.contact.ring2.axialCenter': 4.4,
  'trrs.jack.contact.ring1.axialCenter': 7.55,
  'trrs.jack.contact.tip.axialCenter': 12.75,
}

/** 「帰線が浮き、L と R が別々の導体に届いている」厳密な区間 */
function differenceWindows(m: TrsModel): { fromMm: number; toMm: number; widthMm: number }[] {
  const term = (r: string) => m.jack.terminals.find((t) => t.signalRole === r)
  const out: { fromMm: number; toMm: number; widthMm: number }[] = []
  let cur: { fromMm: number; toMm: number } | null = null
  for (let d = 0; d <= m.fullDepthMm + 1e-9; d += STEP) {
    const dd = +d.toFixed(4)
    const tt = m.evaluate(dd, DEFAULT_FAULTS).circuit.terminalToPlugNet
    const nets = (r: string) => {
      const t = term(r)
      return t ? tt[t.id] ?? [] : []
    }
    const l = nets('L')
    const r = nets('R')
    const g = nets('GND')
    if (g.length === 0 && l.length === 1 && r.length === 1 && l[0] !== r[0]) {
      if (!cur) cur = { fromMm: dd, toMm: dd }
      else cur.toMm = dd
    } else if (cur) {
      out.push({ ...cur, widthMm: +(cur.toMm - cur.fromMm + STEP).toFixed(4) })
      cur = null
    }
  }
  if (cur) out.push({ ...cur, widthMm: +(cur.toMm - cur.fromMm + STEP).toFixed(4) })
  return out
}

const fullInsertionOk = (m: TrsModel) =>
  m.evaluate(m.fullDepthMm, DEFAULT_FAULTS).acoustic.code === 'NORMAL'

const build = (ov: Record<string, number>) => buildModelWithOverrides(VARIANT, ov)

// --- 1. 仮定値と図面値の比較 -------------------------------------------
const assumed = getModel(VARIANT)
const drawing = build(DRAWING)

const assumedContacts = Object.fromEntries(
  Object.keys(DRAWING).map((k) => [k, assumed.dims.entry(k).value]),
)

// --- 2. 図面が縮尺どおりかの照合材料 -----------------------------------
// 完全挿入したとき、プラグの絶縁帯の中心が肩から何 mm の位置に来るか。
// 図面からの目視読み取り (2.76 / 5.79 / 8.80) と突き合わせる。
// 図面に描かれているのは **4極プラグ** なので、4極プラグの絶縁帯を使う。
// ここで 3極プラグ (TRS|JACK-TRRS の plug 側) を使うと絶縁帯が 2 本しか出ず、照合にならない。
const trrsPlug = getModel('TRRS-CTIA|JACK-TRRS')
const insulatorCentersFromShoulder = trrsPlug.plug.segments
  .filter((s) => s.kind === 'insulator')
  .map((s) => +(trrsPlug.fullDepthMm - (s.startMm + s.endMm) / 2).toFixed(3))
  .sort((a, b) => a - b)

// --- 3. どこで切り替わるか (Tip 接点の軸位置だけを振る) ------------------
const others = { ...DRAWING }
delete others['trrs.jack.contact.tip.axialCenter']

const tipScan: { tipAxialMm: number; fullInsertionOk: boolean; widthMm: number }[] = []
for (let tip = 10.0; tip <= 13.5 + 1e-9; tip += 0.05) {
  const t = +tip.toFixed(2)
  const m = build({ ...others, 'trrs.jack.contact.tip.axialCenter': t })
  const w = differenceWindows(m)
  tipScan.push({
    tipAxialMm: t,
    fullInsertionOk: fullInsertionOk(m),
    widthMm: w.length ? Math.max(...w.map((x) => x.widthMm)) : 0,
  })
}
const lastAlive = [...tipScan].reverse().find((r) => r.widthMm > 0)
const firstDead = tipScan.find((r) => r.tipAxialMm > (lastAlive?.tipAxialMm ?? -1) && r.widthMm === 0)

// --- 4. 他の軸で取り戻せるか -------------------------------------------
const recovery: { padWidthMm: number; complianceMm: number; widthMm: number }[] = []
for (const pad of [0.3, 0.4, 0.5, 0.7, 0.9])
  for (const c of [0.02, 0.05, 0.1, 0.15]) {
    const m = build({
      ...DRAWING,
      'trrs.jack.contact.narrowPadWidth': pad,
      'model.contact.complianceMm': c,
    })
    recovery.push({
      padWidthMm: pad,
      complianceMm: c,
      widthMm: differenceWindows(m).reduce((a, x) => Math.max(a, x.widthMm), 0),
    })
  }

/**
 * Lumberg 1503 28 (4極・JEITA RC-5325A) の **端子** 軸位置。接点位置ではない。
 * 基板レイアウト図の 2.75 / 5.50 / 9.30 に、ノーズ突出 2.00 を足して挿入口面基準にした値。
 * 端子 1 は回路記号の箱 = Sleeve バレルなので、ばねは端子 2 / 3 / 4 の 3 本。
 *
 * **これを接点位置として使ってよい保証は無い。** 端子は「ばねが基板へ降りる位置」であって
 * 接点そのものではなく、実在の 4極品には端子の並びが接点の並びと逆のものもある
 * (Cliff FC68125)。ここでは「もし接点が端子の真上にあるなら」という条件付きの計算をする。
 */
const LUMBERG_TERMINALS: Record<string, number> = {
  'trrs.jack.contact.ring2.axialCenter': 4.74,
  'trrs.jack.contact.ring1.axialCenter': 7.5,
  'trrs.jack.contact.tip.axialCenter': 11.3,
}

/** 完全挿入時に各接点が触れる導体。端子位置が接点位置として成立しうるかの検査 */
function landingAtFullInsertion(ov: Record<string, number>) {
  const m = build(ov)
  const ev = m.evaluate(m.fullDepthMm, DEFAULT_FAULTS)
  const tt = ev.circuit.terminalToPlugNet
  return Object.fromEntries(
    m.jack.terminals.map((t) => [t.signalRole ?? t.id, (tt[t.id] ?? []).join('+') || null]),
  )
}

// --- 5. テスターで測れる形の予測 (VERIFICATION_PLAN §2-2 の突き合わせ用) --------
// 4極プラグを使う。各端子が「最初に導通する深さ」と、そのときの肩〜ジャック前面のすき間。
function testerPredictions(ov: Record<string, number>) {
  const m = ov === null ? getModel('TRRS-CTIA|JACK-TRRS') : buildModelWithOverrides('TRRS-CTIA|JACK-TRRS', ov)
  const out: Record<string, { firstContactDepthMm: number | null; shoulderGapMm: number | null }> = {}
  for (const t of m.jack.terminals) {
    let first: number | null = null
    for (let d = 0; d <= m.fullDepthMm + 1e-9; d += STEP) {
      const dd = +d.toFixed(4)
      const nets = m.evaluate(dd, DEFAULT_FAULTS).circuit.terminalToPlugNet[t.id] ?? []
      if (nets.length > 0) {
        first = dd
        break
      }
    }
    out[t.signalRole ?? t.id] = {
      firstContactDepthMm: first,
      shoulderGapMm: first === null ? null : +(m.fullDepthMm - first).toFixed(3),
    }
  }
  return out
}

const out = {
  schemaVersion: 1,
  generatedAt: generatedAt(),
  variantId: VARIANT,
  stepMm: STEP,

  question:
    '4極ジャックの接点位置に一次資料が無いという未確認事項 (UNKNOWNS §5-2) を、実在部品の図面で埋められるか',

  referencePart: {
    partNumber: 'PS000001',
    brand: 'pro-SIGNAL (Premier Farnell 自社ブランド)',
    manufacturer: null,
    manufacturerNote: '実際の製造者は図面に記載が無い。商社の自社ブランド資料である',
    title: '3.5mm 4 Pole Audio Jack, SMT, IPX5/7',
    docDate: '2017-03-31 (V1.0)',
    url: 'https://www.farnell.com/datasheets/2261829.pdf',
    accessed: '2026-08-02',
    whatMakesItRare:
      'SEC:A-A が 4極プラグを挿した状態の断面図で、"* Reference plane" から各接点へ引出線を引き、4 接点すべての軸位置が寸法記入されている。探索した 170 型番のうち、接点位置そのものが寸法記入されていたのはこの 1 件だけ',
    hasTolerances: false,
    representativeness:
      'この 1 部品にすぎない。4極ジャック一般を代表するものではない。またこの部品の接点位置以外の諸元 (パッド幅・ばね定数・端子配置) は図面に無く、本モデルはこの部品を再現していない',
  },

  contactPositions: {
    unit: 'mm',
    datum: '完全挿入時にプラグ肩が来る面 (図面の Reference plane と一致することを §2 の照合で確かめた)',
    assumed: assumedContacts,
    drawing: DRAWING,
    deltaMm: Object.fromEntries(
      Object.keys(DRAWING).map((k) => [k, +(DRAWING[k] - assumedContacts[k]).toFixed(3)]),
    ),
  },

  scaleCheck: {
    method:
      '断面図を 800dpi で描画し、Reference plane を 0・12.75 の寸法線終端を基準に px/mm を求めて、絶縁帯 3 本の中心位置を目視で読み取った。自動計測ではないので精度は約 0.1mm',
    measuredFromDrawingMm: [2.76, 5.79, 8.8],
    predictedByModelMm: insulatorCentersFromShoulder,
    note:
      '本モデルのプラグ導体境界は独立 2 社の図面から得た FACT。ここが一致するということは、'
      + '断面図が縮尺どおりに描かれており、かつプラグが完全挿入の状態で描かれていることを意味する',
  },

  result: {
    assumed: {
      fullInsertionOk: fullInsertionOk(assumed),
      differenceWindows: differenceWindows(assumed),
    },
    drawing: {
      fullInsertionOk: fullInsertionOk(drawing),
      differenceWindows: differenceWindows(drawing),
    },
    verdict:
      differenceWindows(drawing).length === 0
        ? '図面値では左右差分の区間が消える。看板の結論は、この 1 件の実在図面には支持されていない'
        : '図面値でも左右差分の区間が残る',
  },

  whyItDisappears: {
    mechanism:
      'Tip 接点が 1.35mm 奥へ動くため、帰線が浮いている深さ帯 (〜13.16mm) に達しても Tip 接点がまだプラグ先端の円錐部にしか届かず、L が生きない。判定は DIFFERENCE_SIGNAL ではなく SILENT になる',
    thresholdTipAxialMm: {
      aliveUpTo: lastAlive?.tipAxialMm ?? null,
      deadFrom: firstDead?.tipAxialMm ?? null,
      statement:
        'Tip 接点の軸位置がこのしきい値より浅ければ区間が出る。図面値 12.75 はしきい値の奥側にある',
    },
    tipScan,
    recoveryAttempts: {
      note: '図面の 4 値を固定したまま、パッド幅と接触ドームの追従量を振って区間が戻るかを試した',
      grid: recovery,
      anyRecovered: recovery.some((r) => r.widthMm > 0),
    },
    drawingIsNotArbitrary:
      '図面値 12.75 は s = 14 − 12.75 = 1.25mm、つまりプラグ先端の円錐が終わって外径が最大になる位置にあたる '
      + '(本モデルの図面実測では円錐終端 s=1.296)。実在部品は Tip 導体に触れられる最も手前で当てている',
  },

  decision: {
    chosen: 'compare-only',
    rejected: ['replace-assumed-values', 'add-new-variant'],
    reasoning: [
      '差し替えない: 図面にあるのは接点の軸位置 4 件だけで、パッド幅・ばね・端子配置は無い。'
        + '4 件だけ入れ替えると、残りが仮定のままなのに「実在部品の値」を名乗ることになる',
      'variant を足さない: 同じ理由で、部品の形をした別物になる。'
        + '公開済みの artifact と profile が参照している構成も静かに変わる',
      '比較として持つ: いま確実に言えるのは「Tip 接点の軸位置がしきい値より浅いことが、'
        + '看板の結論の必要条件である」ということ。これはしきい値と反例として記録するのが正確',
    ],
  },

  lumbergTerminalScenario: {
    note:
      'Lumberg 1503 28 の基板レイアウトから読んだ **端子** 軸位置 (挿入口面基準)。'
      + '接点位置ではない。「もし接点が端子の真上にあるなら」という条件付きの計算',
    partNumber: '1503 28',
    url: 'https://downloads.lumberg.com/datenblaetter/en/1503_28.pdf',
    terminalsFromNoseMm: LUMBERG_TERMINALS,
    caveat:
      '端子位置を接点位置として使ってよい保証は無い。実在の 4極品には端子の並びが接点の並びと逆のものがある (Cliff FC68125)',
    landingAtFullInsertion: landingAtFullInsertion(LUMBERG_TERMINALS),
    fullInsertionOk: fullInsertionOk(build(LUMBERG_TERMINALS)),
    differenceWindows: differenceWindows(build(LUMBERG_TERMINALS)),
  },

  testerPredictions: {
    note:
      '4極プラグを 4極ジャックへ挿し、各端子が最初に導通する位置でプラグ肩とジャック前面のすき間を測る '
      + '(docs/VERIFICATION_PLAN.md §2-2)。仮定値と図面値でどこに差が出るかを示す',
    variantId: 'TRRS-CTIA|JACK-TRRS',
    assumed: testerPredictions({}),
    drawing: testerPredictions(DRAWING),
  },

  limitations: [
    '図面値に公差の記載が無い。実物がこの値ちょうどである保証は無い',
    'PS000001 は 1 部品であり、4極ジャック一般を代表しない。別の部品では Tip 接点がもっと浅いかもしれない',
    '本モデルの接点判定 (パッド幅・追従量) 自体も仮定を含む。図面値を入れても、モデル全体が実測になるわけではない',
    '断面図の読み取りは人手 (画素実測)。図面そのものは再配布していない',
  ],
}

mkdirSync(resolve(ROOT, 'artifacts'), { recursive: true })
writeFileSync(
  resolve(ROOT, 'artifacts/real_jack_comparison.json'),
  JSON.stringify(out, null, 1) + '\n',
)

console.log('artifacts/real_jack_comparison.json を書きました')
console.log(`  仮定値の区間: ${JSON.stringify(out.result.assumed.differenceWindows)}`)
console.log(`  図面値の区間: ${JSON.stringify(out.result.drawing.differenceWindows)}`)
console.log(`  しきい値: ${out.whyItDisappears.thresholdTipAxialMm.aliveUpTo} まで生存 / ${out.whyItDisappears.thresholdTipAxialMm.deadFrom} から消える`)
console.log(`  縮尺照合: 図面 ${JSON.stringify(out.scaleCheck.measuredFromDrawingMm)} / モデル ${JSON.stringify(out.scaleCheck.predictedByModelMm)}`)
