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
import { classifyFromEvaluation, type TopologyClass } from '../src/model/topology'

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

/**
 * 目標を**分類器の語彙**へ写す (統合オーダー P0-4)。
 *
 * CLI と成果物のファイル名は従来の音響コードのままにしてある
 * (`topology_search_difference_signal.json` を参照している検査・文書があるため)。
 * 判定に使うのは分類器のクラスだけで、ここが唯一の対応表になる。
 */
const TARGET_CLASS_BY_CODE: Record<string, TopologyClass> = {
  DIFFERENCE_SIGNAL: 'ground-open-differential',
  GROUND_OPEN: 'ground-open-nondifferential',
  LR_SHORTED: 'signal-to-return-short',
  SILENT: 'no-path',
  NORMAL: 'all-expected-functions-match',
}
const TARGET_CLASS = TARGET_CLASS_BY_CODE[TARGET]
if (!TARGET_CLASS)
  throw new Error(
    `--target ${TARGET} は分類器のクラスへ写せない。使えるのは ${Object.keys(TARGET_CLASS_BY_CODE).join(' / ')}`,
  )
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

/**
 * **振る水準には、必ず既定値そのものを含める。**
 *
 * 2026-08-02、4極ジャックを Lumberg 1503 28 ベースへ組み直して既定値が
 * 11.4 → 11.30 などへ動いたとき、水準の直書きリストがそのままだったため
 * **「無改造の構成」が一度も評価されなかった。**それでも探索は正常終了し、
 * 「無改造で成立: 0」と報告した。0 は事実ではなく取りこぼしだった。
 * 既定値を必ず混ぜ、下の assertShippedIncluded でも二重に検査する。
 */
const withShipped = (levels: number[], key: string): number[] => {
  const v = shipped(key)
  return [...new Set([...levels, v])].sort((a, b) => a - b)
}

const AXES_BY_JACK: Record<string, Axis[]> = {
  'JACK-TRS': [
    { key: 'jack.contact.sleeve.axialCenter', levels: withShipped([0.5, 1.5, 2.5, 3.2, 4.5, 6.0, 8.0], 'jack.contact.sleeve.axialCenter'), shipped: shipped('jack.contact.sleeve.axialCenter') },
    { key: 'jack.contact.ring.axialCenter', levels: withShipped([4.0, 5.5, 7.1, 8.5, 10.0, 11.5], 'jack.contact.ring.axialCenter'), shipped: shipped('jack.contact.ring.axialCenter') },
    { key: 'jack.contact.tip.axialCenter', levels: withShipped([8.0, 9.5, 11.4, 12.5, 13.5], 'jack.contact.tip.axialCenter'), shipped: shipped('jack.contact.tip.axialCenter') },
    { key: 'jack.contact.sleeve.padWidth', levels: withShipped([0.1, 0.3, 0.55, 0.9, 1.5], 'jack.contact.sleeve.padWidth'), shipped: shipped('jack.contact.sleeve.padWidth') },
    { key: 'model.contact.complianceMm', levels: withShipped([0.02, 0.05, 0.1], 'model.contact.complianceMm'), shipped: shipped('model.contact.complianceMm') },
  ],
  'JACK-TRRS': [
    { key: 'trrs.jack.contact.sleeve.axialCenter', levels: withShipped([0.5, 1.25, 2.5, 4.0, 6.0, 8.0], 'trrs.jack.contact.sleeve.axialCenter'), shipped: shipped('trrs.jack.contact.sleeve.axialCenter') },
    { key: 'trrs.jack.contact.ring2.axialCenter', levels: withShipped([2.5, 4.35, 6.0, 8.0, 10.0], 'trrs.jack.contact.ring2.axialCenter'), shipped: shipped('trrs.jack.contact.ring2.axialCenter') },
    { key: 'trrs.jack.contact.ring1.axialCenter', levels: withShipped([5.0, 7.35, 9.0, 11.0], 'trrs.jack.contact.ring1.axialCenter'), shipped: shipped('trrs.jack.contact.ring1.axialCenter') },
    { key: 'trrs.jack.contact.tip.axialCenter', levels: withShipped([9.5, 11.4, 12.5, 13.5], 'trrs.jack.contact.tip.axialCenter'), shipped: shipped('trrs.jack.contact.tip.axialCenter') },
    { key: 'trrs.jack.contact.narrowPadWidth', levels: withShipped([0.1, 0.3, 0.5, 0.9], 'trrs.jack.contact.narrowPadWidth'), shipped: shipped('trrs.jack.contact.narrowPadWidth') },
    { key: 'model.contact.complianceMm', levels: withShipped([0.02, 0.05, 0.1], 'model.contact.complianceMm'), shipped: shipped('model.contact.complianceMm') },
  ],
}

const VARIANTS = ['TRS|JACK-TRS', 'TRRS-CTIA|JACK-TRRS', 'TRS|JACK-TRRS'] as const

/**
 * パッド幅の下限。**製造可能性の判定ではない (統合オーダー P0-5)。**
 *
 * 2026-08-03 まで `realizablePadWidth` という名前で「作れる」と読める形にしていたが、
 * 実体は 0.3mm という 1 本の閾値だけである。しかもこの値に出典が無い。
 * 材料・ばね応力・耐久性・成形・公差・接触圧・メーカー工程のいずれも確認していない。
 */
const PAD_WIDTH_HEURISTIC = {
  name: 'minimumPadWidth',
  thresholdMm: 0.3,
  source: null,
  manufacturingVerified: false,
  note: '探索空間を切るための下限。出典は無く、製造上の妥当性も確認していない',
} as const

/**
 * variant ごとの土台。**探索結果を「3.5mm ジャック一般」へ広げさせない。**
 *
 * 代表性の断り書きが 1 本しかないと、Lumberg 1532 10 × 1503 09 の話に見えてしまう。
 * 実際には 4極ジャックを含む variant が 2 つあり、そちらは構成 profile である。
 */
const VARIANT_BASIS: Record<string, Record<string, unknown>> = {
  'TRS|JACK-TRS': {
    basePartOrConstructedProfile: 'Lumberg 1532 10 × Lumberg 1503 09 (どちらも実在の単一品)',
    sourceBasis: 'メーカー公開データシートの図面・基板レイアウト・回路記号',
    unverifiedAssumptions: ['接点ばねの自由半径・公称たわみ・ばね定数 (別メーカー資料への逆算)'],
    representativenessDisclaimer: 'この 1 組についての結果であり、3.5mm ジャック全般を代表しない',
  },
  'TRRS-CTIA|JACK-TRRS': {
    basePartOrConstructedProfile: '構成 profile。4極プラグは合成、4極ジャックは端子系のみ Lumberg 1503 28',
    sourceBasis: '導体境界は図面記載寸法からの演算 (FACT)。端子位置は 1503 28 の基板レイアウト図 (FACT)',
    unverifiedAssumptions: [
      '接点の軸方向オフセット (beamOffset) — 一次資料なし',
      '4極ジャックの外形 — 3極 1503 09 からの流用',
    ],
    representativenessDisclaimer: '実在の特定製品ではない。実物がこう振る舞うという主張ではない',
  },
  'TRS|JACK-TRRS': {
    basePartOrConstructedProfile: '構成 profile。3極プラグ Lumberg 1532 10 × 端子系 Lumberg 1503 28 の混挿',
    sourceBasis: '端子位置は 1503 28 の基板レイアウト図 (FACT)。接点位置は端子位置に拘束された仮定',
    unverifiedAssumptions: [
      '接点の軸方向オフセット (beamOffset) — 一次資料なし',
      'PS000001 の断面図を入れると左右差分の区間は消える。実在資料 2 件が逆を指している',
    ],
    representativenessDisclaimer: '実在の単一製品ではない組み合わせ。実物がこう振る舞うという主張ではない',
  },
}

/**
 * その軸を動かすと本当にモデルが変わることを確かめる。
 * 変わらない軸を「振った」と数えると、探索の網羅性を偽ることになる。
 */
/** 既定値が水準に入っていることを確かめる。入っていないと「無改造」を数え損なう */
function assertShippedIncluded(variantId: string, axes: Axis[]): void {
  for (const a of axes)
    if (!a.levels.includes(a.shipped))
      throw new Error(
        `${variantId}: 軸 ${a.key} の水準に既定値 ${a.shipped} が入っていない。` +
          `このままでは「無改造で成立するか」を一度も評価しないまま 0 と報告してしまう`,
      )
}

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
 * その深さの電気トポロジーを分類する。**判定はここに書かない。**
 *
 * 2026-08-03 まで、ここに `isStrictDifferenceSignal` という独自実装があり、
 * 「帰線が浮き L と R が別々の導体」という同じ判定が**このリポジトリに 5 か所**
 * あった (src/model/circuit.ts / ここ / compareRealJack / テスト 2 件)。
 *
 * さらにその説明文が旧実装のまま取り残されていた。
 * 「predictAcoustic は判定順の都合で L と R が同じ導体でも GROUND_OPEN を出す」
 * と書いてあったが、**その挙動は 2026-08-02 に直っていた**（逆向きの陳腐化）。
 * 分類は src/model/topology.ts が唯一持つ。
 */
function topologyAt(m: TrsModel, depthMm: number): TopologyClass {
  return classifyFromEvaluation(
    m.jack.terminals,
    m.plug.netFunctions,
    m.evaluate(depthMm, DEFAULT_FAULTS),
  ).topologyClass
}

/** L / R / GND の端子が引けることを確かめる。引けない variant は判定不能 */
function assertRolesResolvable(variantId: (typeof VARIANTS)[number]): void {
  const m = getModel(variantId)
  for (const role of ['L', 'R', 'GND']) {
    if (!m.jack.terminals.some((t) => t.signalRole === role))
      throw new Error(`${variantId}: 端子 role=${role} が引けない。厳密判定が常に false になる`)
  }
}

/** 目標クラスが現れる深さ区間 (粗い走査)。**判定は分類器に任せる** */
function hitWindows(m: TrsModel, step: number): { fromMm: number; toMm: number }[] {
  const rows = sweep(m, { stepMm: step }).filter((r) => r.depthMm >= 0)
  const wins: { fromMm: number; toMm: number }[] = []
  let cur: { fromMm: number; toMm: number } | null = null
  for (const r of rows) {
    if (topologyAt(m, r.depthMm) === TARGET_CLASS) {
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
  /**
   * 既定値から 1 つも動かしていないか。
   *
   * **「市販品のままで起きる」という意味ではない (統合オーダー P0-5)。**
   * 意味するのは「このモデルの入力値を 1 つも変えていない」だけである。
   */
  matchesCurrentNominalParameters: boolean
  /**
   * パッド幅が探索用の下限 0.3mm 以上か。
   *
   * **製造可能性の判定ではない (統合オーダー P0-5)。** 材料・ばね応力・耐久性・成形・
   * 公差・接触圧・メーカー工程のどれも確認していない。0.3mm という値にも出典が無い。
   * 探索空間を切るための heuristic にすぎないので、名前でそう言う。
   */
  passesPadWidthHeuristic: boolean
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
  assertShippedIncluded(variantId, axes) // 既定値が水準に無ければここで落ちる
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
      matchesCurrentNominalParameters: axes.every((a) => ov[a.key] === a.shipped),
      passesPadWidthHeuristic: axes
        .filter((a) => a.key.toLowerCase().includes('padwidth'))
        .every((a) => ov[a.key] >= PAD_WIDTH_HEURISTIC.thresholdMm),
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

// **`strictDifferenceSignal` という別集計は廃止した (統合オーダー P0-4)。**
// 目標そのものが分類器の `ground-open-differential` になったので、
// 見つかった構成は定義上すべて「厳密」である。
// 2026-08-03 の実測でも usableWitnesses と strictDifferenceSignal はどちらも 1338 件で、
// **同じ数を 2 つの名前で報告していた** (独立した裏付けに見えてしまう)。
const realizable = usable.filter((w) => w.passesPadWidthHeuristic)
const noMod = usable.filter((w) => w.matchesCurrentNominalParameters)
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
    // variant ごとに土台を書く。1 本の断り書きだと 3極×3極の話に見えてしまう
    variantBasis: Object.fromEntries(VARIANTS.map((v) => [v, { variantId: v, ...VARIANT_BASIS[v] }])),
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
  // **廃止した集計を、消したことごと記録する。**
  removedMeasures: [
    {
      key: 'strictDifferenceSignal',
      removedOn: '2026-08-03',
      reason:
        '目標そのものが分類器の ground-open-differential になったので、見つかった構成は定義上すべて厳密である。'
        + '廃止前の実測でも usableWitnesses と strictDifferenceSignal はどちらも 1338 件で、'
        + '**同じ数を 2 つの名前で報告していた**。独立した裏付けがあるように読めてしまうため消した。'
        + '厳密な差分信号の件数が要る場合は usableWitnesses.total を見ること。',
    },
  ],
  // **ここが「モデル上どこまで絞れるか」の答え。作れるかどうかではない。**
  realizability: {
    note:
      'passesPadWidthHeuristic は探索用の下限 (パッド幅 0.3mm 以上) を通ったというだけである。'
      + '**製造可能性の判定ではない。** 材料・ばね応力・耐久性・成形・公差・接触圧・メーカー工程のいずれも確認していない。'
      + 'matchesCurrentNominalParameters は「このモデルの入力値を 1 つも変えていない」という意味であって、'
      + '**市販の実物でそうなると確認したという意味ではない。**'
      + 'さらに 4極ジャックの接点の軸方向オフセットは一次資料が無く仮定なので、'
      + 'この列のどの数字も実物の挙動を主張しない。',
    heuristic: PAD_WIDTH_HEURISTIC,
    passesPadWidthHeuristic: { total: realizable.length, byVariant: byVariant(realizable) },
    matchesCurrentNominalParameters: {
      total: noMod.length,
      byVariant: byVariant(noMod),
      samples: stratified(noMod, 3),
    },
    counterEvidence: {
      note:
        '**同じ可視性で反対証拠を置く。** 唯一入手できた実在 4極ジャックの断面図 (pro-SIGNAL PS000001) の'
        + '接点位置を入れると、左右差分の区間は 1 件も出ない。詳細は artifacts/real_jack_comparison.json と'
        + ' docs/REAL_JACK_COMPARISON.md。実在資料 2 件 (PS000001 と Lumberg 1503 28 の端子位置) は逆を指している。',
      ref: 'artifacts/real_jack_comparison.json',
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
console.log(`    variant 別: ${JSON.stringify(byVariant(usable))}`)
console.log(`  うちパッド幅 heuristic (>= ${PAD_WIDTH_HEURISTIC.thresholdMm}mm) を通ったもの: ${realizable.length}`)
console.log(`    **製造可能性は確認していない。探索用の下限にすぎない**`)
console.log(`  うち既定の入力値のまま: ${noMod.length} ${JSON.stringify(byVariant(noMod))}`)
console.log(`    **市販の実物でそうなるという意味ではない**`)
if (out.robustIntervalWidthMm !== null) console.log(`  最も広い窓: ${out.robustIntervalWidthMm} mm`)
if (notFoundReason) console.log(`  → ${notFoundReason}`)
console.log(`  artifacts/topology_search_${TARGET.toLowerCase()}.json を書き出した`)
