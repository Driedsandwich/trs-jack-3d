/**
 * 目標トポロジーの探索。統合オーダー (2026-08-01) §3 P1。
 *   npm run search:topology -- --target GROUND_OPEN
 *
 * 何のためか:
 *   既定モデルには GROUND_OPEN (共通帰線断) が現れない。これは Half-Plug Lab が
 *   再現したい「半挿しの音」の中核候補なので、**そもそも成立しうるのか**を
 *   構成空間を振って調べる。
 *
 * 見つからないことも結果である:
 *   目標が現れなくても正常終了し、反証として artifact に残す。
 *   「探したが無かった」は「探していない」とは違う情報である。
 *
 * 実在部品と架空の構成を混同しない:
 *   既定値から動かした構成は constructed = true とし、evidenceGrade を
 *   ASSUMPTION にする。**実在の Lumberg 部品がそう振る舞うという主張ではない。**
 *   また、この探索は「一般的な 3.5mm ジャック」の代表性を一切主張しない。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildModelWithOverrides, getModel } from '../src/data'
import { DEFAULT_FAULTS } from '../src/model/contact'
import { sweep } from '../src/model/sweep'
import type { TrsModel } from '../src/model/engine'

const ROOT = resolve(process.cwd())

// --- 引数 ---------------------------------------------------------------
const argv = process.argv.slice(2)
const argOf = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
// 既定は本命の DIFFERENCE_SIGNAL。
// 2026-08-02 に GROUND_OPEN の意味を「帰線が浮くが差分にならない方」へ狭めたので、
// 既定を GROUND_OPEN のままにすると、引数なしの実行が本命でない方を探してしまう。
const TARGET = argOf('target', 'DIFFERENCE_SIGNAL')
const COARSE = Number(argOf('step', '0.05'))

// --- 探索空間 -----------------------------------------------------------
// 既定値から動かす。範囲は「その接点が完全挿入で自分の導体に収まる」条件より広く取る。
// 広く取るのは意図的で、成立しないなら「広げても成立しない」と言えるようにするため。

interface Axis {
  key: string
  levels: number[]
  shipped: number
}

const base3 = getModel('TRS|JACK-TRS')
const shipped = (k: string) => base3.dims.entry(k).value

// **variant ごとにキーが違う。** 3極ジャックは jack.contact.*、4極ジャックは
// trrs.jack.contact.* から解決する。dims.has() は共通の台帳を見るので
// どちらでも true を返してしまい、**効かない override を「振った」と誤認する。**
// (2026-08-02: 実際にこの罠を踏み、4極 2 variant が既定値のまま数百回
//  繰り返されるだけの空振りになっていた。下の assertAxesBite で検出する。)

const AXES_BY_JACK: Record<string, Axis[]> = {
  'JACK-TRS': [
    { key: 'jack.contact.sleeve.axialCenter', levels: [0.5, 1.5, 2.5, 3.2, 4.5, 6.0, 8.0], shipped: shipped('jack.contact.sleeve.axialCenter') },
    { key: 'jack.contact.ring.axialCenter', levels: [4.0, 5.5, 7.1, 8.5, 10.0, 11.5], shipped: shipped('jack.contact.ring.axialCenter') },
    { key: 'jack.contact.tip.axialCenter', levels: [8.0, 9.5, 11.4, 12.5, 13.5], shipped: shipped('jack.contact.tip.axialCenter') },
    { key: 'jack.contact.sleeve.padWidth', levels: [0.1, 0.3, 0.55, 0.9, 1.5], shipped: shipped('jack.contact.sleeve.padWidth') },
    { key: 'model.contact.complianceMm', levels: [0.02, 0.05, 0.1], shipped: shipped('model.contact.complianceMm') },
  ],
  'JACK-TRRS': [
    { key: 'trrs.jack.contact.sleeve.axialCenter', levels: [0.5, 1.25, 2.5, 4.0, 6.0, 8.0], shipped: shipped('trrs.jack.contact.sleeve.axialCenter') },
    { key: 'trrs.jack.contact.ring2.axialCenter', levels: [2.5, 4.35, 6.0, 8.0, 10.0], shipped: shipped('trrs.jack.contact.ring2.axialCenter') },
    { key: 'trrs.jack.contact.ring1.axialCenter', levels: [5.0, 7.35, 9.0, 11.0], shipped: shipped('trrs.jack.contact.ring1.axialCenter') },
    { key: 'trrs.jack.contact.tip.axialCenter', levels: [9.5, 11.4, 12.5, 13.5], shipped: shipped('trrs.jack.contact.tip.axialCenter') },
    { key: 'trrs.jack.contact.narrowPadWidth', levels: [0.1, 0.3, 0.5, 0.9], shipped: shipped('trrs.jack.contact.narrowPadWidth') },
    { key: 'model.contact.complianceMm', levels: [0.02, 0.05, 0.1], shipped: shipped('model.contact.complianceMm') },
  ],
}

const VARIANTS = ['TRS|JACK-TRS', 'TRRS-CTIA|JACK-TRRS', 'TRS|JACK-TRRS'] as const

/**
 * その軸を動かすと本当にモデルが変わることを確かめる。
 * 変わらない軸を「振った」と数えると、探索の網羅性を偽ることになる。
 */
function assertAxesBite(variantId: (typeof VARIANTS)[number], axes: Axis[]): void {
  for (const a of axes) {
    const alt = a.levels.find((v) => v !== a.shipped)
    if (alt === undefined) continue
    const b = JSON.stringify(getModel(variantId).jack.contacts.map((c) => [c.axialCenterMm, c.padWidthMm]))
    const m2 = buildModelWithOverrides(variantId, { [a.key]: alt })
    const after = JSON.stringify(m2.jack.contacts.map((c) => [c.axialCenterMm, c.padWidthMm]))
    // compliance は接点の寸法を変えないので、この検査の対象外
    if (a.key.includes('complianceMm')) continue
    if (b === after) throw new Error(`${variantId}: 軸 ${a.key} を動かしてもモデルが変わらない。探索が空振りになる`)
  }
}

// --- 判定 ---------------------------------------------------------------

/** 完全挿入で全端子が正しい導体につながるか。実在の部品として成立する条件 */
function fullInsertionOk(m: TrsModel): boolean {
  const ev = m.evaluate(m.fullDepthMm, DEFAULT_FAULTS)
  return ev.acoustic.code === 'NORMAL'
}

/**
 * **GROUND_OPEN には 2 種類ある。**
 *
 * predictAcoustic は「帰線がどの導体にも届かない かつ L と R が何かに届く」で
 * GROUND_OPEN を出す。この判定は lrShorted より先にあるので、
 * **L と R が同じ導体に落ちていても GROUND_OPEN と分類される。**
 *
 * Half-Plug が再現したいのは左右の差分が残る状態なので、
 * 「L と R が別々の導体に正しく届いていて、帰線だけが浮いている」厳密な場合を
 * 分けて数える。両者を混ぜると、実体が左右短絡の構成まで数に入る。
 */
function isStrictDifferenceSignal(m: TrsModel, depthMm: number): boolean {
  // **端子 ID を直書きしてはいけない。** 3極ジャックは T1/T2/T3、4極ジャックは
  // P1〜P4 を使う。直書きすると 4極側が常に false になり、
  // 「4極も調べた」と言いながら一度も判定していない状態になる
  // (2026-08-02 に実際にそうなった。この探索で同種の空振りは 3 件目)。
  // predictAcoustic と同じく signalRole から引く。
  const tt = m.evaluate(depthMm, DEFAULT_FAULTS).circuit.terminalToPlugNet
  const byRole = (role: string) => {
    const t = m.jack.terminals.find((x) => x.signalRole === role)
    return t ? tt[t.id] ?? [] : null
  }
  const l = byRole('L')
  const r = byRole('R')
  const g = byRole('GND')
  if (!l || !r || !g) return false
  return g.length === 0 && l.length === 1 && r.length === 1 && l[0] !== r[0]
}

/** L / R / GND の端子が引けることを確かめる。引けない variant は判定不能 */
function assertRolesResolvable(variantId: (typeof VARIANTS)[number]): void {
  const m = getModel(variantId)
  for (const role of ['L', 'R', 'GND']) {
    if (!m.jack.terminals.some((t) => t.signalRole === role))
      throw new Error(`${variantId}: 端子 role=${role} が引けない。厳密判定が常に false になる`)
  }
}

/** 目標コードが現れる深さ区間 (粗い走査) */
function hitWindows(m: TrsModel, step: number): { fromMm: number; toMm: number }[] {
  const rows = sweep(m, { stepMm: step }).filter((r) => r.depthMm >= 0)
  const wins: { fromMm: number; toMm: number }[] = []
  let cur: { fromMm: number; toMm: number } | null = null
  for (const r of rows) {
    if (r.acoustic === TARGET) {
      if (cur) cur.toMm = r.depthMm
      else cur = { fromMm: r.depthMm, toMm: r.depthMm }
    } else if (cur) {
      wins.push(cur)
      cur = null
    }
  }
  if (cur) wins.push(cur)
  return wins
}

// --- 探索 ---------------------------------------------------------------

interface Witness {
  variantId: string
  overrides: Record<string, number>
  constructed: boolean
  evidenceGrade: 'ASSUMPTION'
  fullInsertionOk: boolean
  /** L と R が別々の導体に届いたまま帰線だけが浮く、厳密な差分信号か */
  strictDifferenceSignal: boolean
  /** 既定値から 1 つも動かしていないか。＝市販品のままで起きるか */
  needsNoModification: boolean
  /** 製造しうるパッド幅か (0.3mm 未満は現実的でないとみなす) */
  realizablePadWidth: boolean
  windows: { fromMm: number; toMm: number }[]
  robustIntervalWidthMm: number
}

const witnesses: Witness[] = []
let tried = 0
let buildFailed = 0

function* grid(axes: Axis[]): Generator<Record<string, number>> {
  const idx = axes.map(() => 0)
  for (;;) {
    yield Object.fromEntries(axes.map((a, i) => [a.key, a.levels[idx[i]]]))
    let k = axes.length - 1
    while (k >= 0) {
      idx[k]++
      if (idx[k] < axes[k].levels.length) break
      idx[k] = 0
      k--
    }
    if (k < 0) return
  }
}

const axesUsed: Record<string, string[]> = {}
for (const variantId of VARIANTS) {
  const jackId = variantId.split('|')[1]
  const axes = AXES_BY_JACK[jackId]
  if (!axes) throw new Error(`${variantId}: 軸の定義が無い`)
  assertAxesBite(variantId, axes) // 空振りならここで落ちる
  assertRolesResolvable(variantId) // 端子 role が引けなければここで落ちる
  axesUsed[variantId] = axes.map((a) => a.key)
  for (const ov of grid(axes)) {
    tried++
    let m: TrsModel
    try {
      m = buildModelWithOverrides(variantId, ov)
    } catch {
      buildFailed++
      continue
    }
    const wins = hitWindows(m, COARSE)
    if (wins.length === 0) continue
    const constructed = axes.some((a) => ov[a.key] !== a.shipped)
    witnesses.push({
      variantId,
      overrides: ov,
      constructed,
      evidenceGrade: 'ASSUMPTION',
      fullInsertionOk: fullInsertionOk(m),
      needsNoModification: axes.every((a) => ov[a.key] === a.shipped),
      realizablePadWidth: axes
        .filter((a) => a.key.toLowerCase().includes('padwidth'))
        .every((a) => ov[a.key] >= 0.3),
      strictDifferenceSignal: wins.some((w) => {
        for (let d = w.fromMm; d <= w.toMm + 1e-9; d += COARSE) if (isStrictDifferenceSignal(m, d)) return true
        return false
      }),
      windows: wins.map((w) => ({ fromMm: +w.fromMm.toFixed(3), toMm: +w.toMm.toFixed(3) })),
      robustIntervalWidthMm: +Math.max(...wins.map((w) => w.toMm - w.fromMm + COARSE)).toFixed(3),
    })
  }
}

// --- どの軸が効いたか ---------------------------------------------------

const usable = witnesses.filter((w) => w.fullInsertionOk)
const allAxes = Object.values(AXES_BY_JACK).flat()
const sensitivity = allAxes.map((a) => {
  const vals = [...new Set(witnesses.map((w) => w.overrides[a.key]).filter((v) => v !== undefined))]
  const usableVals = [...new Set(usable.map((w) => w.overrides[a.key]).filter((v) => v !== undefined))]
  return {
    key: a.key,
    shipped: a.shipped,
    levelsTried: a.levels,
    valuesAmongWitnesses: vals.sort((x, y) => x - y),
    valuesAmongUsableWitnesses: usableVals.sort((x, y) => x - y),
    shippedValueAppearsInWitness: vals.includes(a.shipped),
  }
})

/** 目標のために既定から動かす必要があった軸 */
const requiredAssumptions = witnesses.length
  ? allAxes.filter((a) => {
      const vals = new Set(witnesses.map((w) => w.overrides[a.key]))
      return vals.size > 0 && !vals.has(a.shipped)
    }).map((a) => ({
      key: a.key,
      shipped: a.shipped,
      note: '既定値のままでは目標が現れなかった。この軸を動かすことが必要条件である。',
    }))
  : []

let notFoundReason: string | null = null
if (witnesses.length === 0) {
  notFoundReason =
    `探索した ${tried} 構成 (${VARIANTS.length} variant × 接点軸位置・パッド幅・compliance の格子) の` +
    `どれでも ${TARGET} が現れなかった。走査刻みは ${COARSE}mm なので、` +
    `これより狭い窓しか持たない構成は取りこぼしうる。`
} else if (usable.length === 0) {
  notFoundReason =
    `${TARGET} が現れる構成は ${witnesses.length} 件見つかったが、` +
    `そのすべてで完全挿入時の結線が壊れている (acoustic !== NORMAL)。` +
    `つまり「正しく使えるジャックでありながら ${TARGET} を通る」構成は見つからなかった。`
}

// --- 集計の道具 ---------------------------------------------------------
//
// **合計だけを出すと、どの variant で成立したのかが読み手に分からない。**
// 幅の広い順に上位を取ると 3極が上位を占め、4極が 1 件も載らないまま
// 「240 件成立」とだけ書かれた artifact ができる。variant ごとに数え、
// variant ごとに標本を取る。

const byVariant = (ws: Witness[]) =>
  Object.fromEntries(VARIANTS.map((v) => [v, ws.filter((w) => w.variantId === v).length]))

/** variant ごとに上位 n 件ずつ取る。どの variant も 0 件にならないようにする */
const stratified = (ws: Witness[], nPerVariant: number) =>
  VARIANTS.flatMap((v) =>
    ws
      .filter((w) => w.variantId === v)
      .sort((a, b) => b.robustIntervalWidthMm - a.robustIntervalWidthMm)
      .slice(0, nPerVariant),
  )

const strict = usable.filter((w) => w.strictDifferenceSignal)
// 「作れる可能性のある構成」と「計算上そうなるだけの構成」を分ける
const realizable = strict.filter((w) => w.realizablePadWidth)
const noMod = strict.filter((w) => w.needsNoModification)
const broken = witnesses.filter((w) => !w.fullInsertionOk)

// --- 書き出し -----------------------------------------------------------

const out = {
  schemaVersion: 1,
  generatedBy: 'npm run search:topology',
  targetCode: TARGET,
  searchSpace: {
    variants: VARIANTS,
    axesByJack: Object.fromEntries(Object.entries(AXES_BY_JACK).map(([j, ax]) => [j, ax.map((a) => ({ key: a.key, levels: a.levels, shipped: a.shipped }))])),
    axesUsedPerVariant: axesUsed,
    coarseStepMm: COARSE,
    configurationsTried: tried,
    buildFailed,
  },
  representativenessDisclaimer:
    'これは Lumberg 1532 10 × 1503 09 とその仮想的な改変についての探索である。' +
    '一般的な 3.5mm ジャックを代表するものではない。constructed=true の構成は実在部品ではない。',
  found: witnesses.length > 0,
  foundWithWorkingJack: usable.length > 0,
  // **使える構成と、完全挿入が壊れる構成を混ぜて上位を取ってはいけない。**
  // 混ぜて幅の広い順に 50 件取ると、壊れた構成が上位を占め、
  // 「318 件ある」と書きながら 1 件も収録しない artifact ができる (2026-08-02 に実際にそうなった)。
  usableWitnesses: {
    note: '完全挿入で正しく結線されたまま目標を通る構成。実在部品ではないが、成立しうることの証拠',
    total: usable.length,
    byVariant: byVariant(usable),
    samples: stratified(usable, 8),
    droppedFromListing: Math.max(0, usable.length - stratified(usable, 8).length),
  },
  // **ここが Half-Plug にとっての本命。**
  strictDifferenceSignal: {
    note:
      'GROUND_OPEN のうち、L と R が別々の導体へ正しく届いたまま帰線だけが浮くもの。' +
      'predictAcoustic の判定順の都合で、L と R が同じ導体に落ちていても GROUND_OPEN と分類される。' +
      'それらを混ぜると、実体が左右短絡の構成まで数に入ってしまう。',
    total: strict.length,
    outOfUsable: usable.length,
    byVariant: byVariant(strict),
    maxWindowMm: strict.length ? Math.max(...strict.map((w) => w.robustIntervalWidthMm)) : null,
    samples: stratified(strict, 8),
    droppedFromListing: Math.max(0, strict.length - stratified(strict, 8).length),
  },
  // **ここが「作れるか」の答え。**
  realizability: {
    note:
      'realizablePadWidth はパッド幅 0.3mm 以上 (それ未満は製造上現実的でないとみなす)。' +
      'needsNoModification は既定値から 1 つも動かしていない構成、つまり市販品のままで起きるもの。' +
      'ただし 4極ジャックの接点位置は一次資料が無く全て仮定なので、' +
      '「市販品のまま」であっても実物がそうだという意味にはならない。',
    realizablePadWidth: { total: realizable.length, byVariant: byVariant(realizable) },
    needsNoModification: {
      total: noMod.length,
      byVariant: byVariant(noMod),
      samples: stratified(noMod, 3),
    },
  },
  brokenJackWitnesses: {
    note: '目標は通るが、完全挿入時の結線が壊れている構成。ジャックとして使えない',
    total: broken.length,
    byVariant: byVariant(broken),
    samples: stratified(broken, 4),
    droppedFromListing: Math.max(0, broken.length - stratified(broken, 4).length),
  },
  witnessCount: witnesses.length,
  witnessCountByVariant: byVariant(witnesses),
  usableWitnessCount: usable.length,
  robustIntervalWidthMmAmongUsable: usable.length
    ? Math.max(...usable.map((w) => w.robustIntervalWidthMm))
    : null,
  robustIntervalWidthMm: witnesses.length ? Math.max(...witnesses.map((w) => w.robustIntervalWidthMm)) : null,
  sensitivity,
  requiredAssumptions,
  notFoundReason,
}

const OUT = resolve(ROOT, 'artifacts')
mkdirSync(OUT, { recursive: true })
writeFileSync(resolve(OUT, `topology_search_${TARGET.toLowerCase()}.json`), JSON.stringify(out, null, 1) + '\n')

console.log(`\n  目標 ${TARGET} / 試した構成 ${tried} (組めなかった ${buildFailed})`)
console.log(`  現れた構成: ${witnesses.length}`)
console.log(`  うち完全挿入が壊れていないもの: ${usable.length}`)
console.log(`  うち厳密な差分信号 (L/R が別導体・帰線だけ浮く): ${strict.length}`)
console.log(`    variant 別: ${JSON.stringify(byVariant(strict))}`)
console.log(`  うちパッド 0.3mm 以上 (作れそう): ${realizable.length}`)
console.log(`  うち既定値のまま (無改造): ${noMod.length} ${JSON.stringify(byVariant(noMod))}`)
if (out.robustIntervalWidthMm !== null) console.log(`  最も広い窓: ${out.robustIntervalWidthMm} mm`)
if (notFoundReason) console.log(`  → ${notFoundReason}`)
console.log(`  artifacts/topology_search_${TARGET.toLowerCase()}.json を書き出した`)
