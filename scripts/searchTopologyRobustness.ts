/**
 * 目標トポロジー `ground-open-differential` が、**どの仮定を動かしても残るか**を測る。
 *   npm run search:robustness
 *
 * ## なぜ event spread では足りないか（非阻害フォローアップ 2026-08-03 P1-4）
 *
 * `artifacts/sensitivity.trs_jack_trrs.json` が測っているのは
 * **イベントが起きる深さの幅**である。帰線接点の軸位置とパッド幅の 2 軸しか振っていない。
 *
 * Half-Plug Lab が知りたいのはそれではない。
 *
 * ```
 * ground-open-differential が そもそも存在するか
 * その区間幅がどの程度残るか
 * ```
 *
 * **この 2 つは別の量である。**深さの幅がいくら安定していても、
 * Tip 接点位置を動かしたら区間ごと消えるなら、頑健とは言えない。
 * 実際に消える条件がある（→ `necessaryConditions`）。
 *
 * ## 走査軸を決める前に、その軸が効くことを実測した
 *
 * 動かないキーを「振った」と数えると、同じ構成を何百回も繰り返すだけの空振りになり、
 * **「その仮定は結論に影響しない」という誤った結論が出る。**
 * 下の `assertAxesBite` が、各軸について「既定値以外のどれかでトポロジー列が変わる」
 * ことを実行時に確かめる。
 *
 * **`beamOffset` はこの検査で落ちた。**
 * `trrs.jack.contact.beamOffset` を単独で上書きしてもモデルは 1mm も動かない。
 * 接点位置は「端子位置 − beamOffset」を**計算済みの別項目**として持っているためで、
 * beamOffset 自身はどこからも読まれていない。
 * 素直にキーを振ると「beamOffset は結論に影響しない」と出てしまう。
 * ここでは 3 接点を連動させる複合軸として実装している。
 *
 * ## これは実物の確率ではない
 *
 * `presenceFractionWithinConstructedSweep` は**この構成空間の中での割合**であって、
 * 実在のジャックでこの状態が起きる確率ではない。走査範囲の取り方は任意である。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildProvenance, listRobustnessInputs } from './provenance'
import { buildModelWithOverrides, getModel } from '../src/data'
import { DEFAULT_FAULTS } from '../src/model/contact'
import { sweep } from '../src/model/sweep'
import { classifyFromEvaluation } from '../src/model/topology'
import type { TrsModel } from '../src/model/engine'

const ROOT = resolve(process.cwd())
const argv = process.argv.slice(2)
const RELEASE = argv.includes('--release')
const VARIANT = 'TRS|JACK-TRRS' as const
const SLUG = 'trs_jack_trrs'
const TARGET_CLASS = 'ground-open-differential' as const
const STEP_MM = 0.02

/** 端子位置（図面の記載値 = FACT）。接点位置 = 端子位置 − beamOffset */
const TERMINAL = { tip: 11.3, ring1: 7.5, ring2: 4.74 } as const

// ---------------------------------------------------------------------------
// 走査軸
// ---------------------------------------------------------------------------

interface Axis {
  /** 記録名。単一キーの軸は寸法キーそのもの、複合軸は概念名 */
  name: string
  /** 実際に動かす寸法キー */
  keys: string[]
  levels: number[]
  shipped: number
  unit: string
  meaning: string
  /** 水準からモデルの上書きを作る */
  apply: (level: number) => Record<string, number>
}

/**
 * beamOffset。**単独キーでは効かないので 3 接点を連動させる。**
 * 成立範囲は 0〜1.3mm（完全挿入でばね 3 本が対応導体にパッド全幅で乗る条件）。
 */
const beamAxis: Axis = {
  name: 'beamOffset',
  keys: ['trrs.jack.contact.tip.axialCenter', 'trrs.jack.contact.ring1.axialCenter', 'trrs.jack.contact.ring2.axialCenter'],
  levels: [0, 0.65, 1.3],
  shipped: 0,
  unit: 'mm',
  meaning: '接点が端子より何 mm 手前にあるか。3 接点をまとめて手前へずらす。4極ジャックの接点位置に残る唯一の仮定',
  apply: (b) => ({
    'trrs.jack.contact.tip.axialCenter': +(TERMINAL.tip - b).toFixed(4),
    'trrs.jack.contact.ring1.axialCenter': +(TERMINAL.ring1 - b).toFixed(4),
    'trrs.jack.contact.ring2.axialCenter': +(TERMINAL.ring2 - b).toFixed(4),
  }),
}

/** 個々の接点を beamOffset とは独立にずらす分 */
const contactDelta = (id: 'tip' | 'ring1' | 'ring2', levels: number[]): Axis => ({
  name: `trrs.jack.contact.${id}.axialCenterDelta`,
  keys: [`trrs.jack.contact.${id}.axialCenter`],
  levels,
  shipped: 0,
  unit: 'mm',
  meaning: `${id} 接点を端子位置から独立にずらす分。端子位置は図面記載 (FACT) だが、接点位置は図面に無い (ASSUMPTION)`,
  apply: (d) => ({ [`trrs.jack.contact.${id}.axialCenter`]: +(TERMINAL[id] + d).toFixed(4) }),
})

/**
 * プラグの Ring 帯を丸ごとずらす。**単独キーでは組めない。**
 * 導体境界は連鎖している（tip.end = ins1.start, ins1.end = ring.start, …）ので、
 * 1 つだけ動かすと不連続になって組み立てが失敗する。
 */
const plugRingBand: Axis = {
  name: 'plug.ringBandShift',
  keys: ['plug.ins1.end', 'plug.ring.start', 'plug.ring.end', 'plug.ins2.start'],
  levels: [-0.3, 0, 0.2],
  shipped: 0,
  unit: 'mm',
  meaning: 'プラグの Ring 帯（絶縁帯に挟まれた区間）を丸ごと軸方向へずらす分。導体境界は連鎖しているので個別には動かせない',
  apply: (d) => ({
    'plug.ins1.end': +(5.5 + d).toFixed(4),
    'plug.ring.start': +(5.5 + d).toFixed(4),
    'plug.ring.end': +(8.3 + d).toFixed(4),
    'plug.ins2.start': +(8.3 + d).toFixed(4),
  }),
}

const single = (key: string, levels: number[], shipped: number, unit: string, meaning: string): Axis => ({
  name: key, keys: [key], levels, shipped, unit, meaning,
  apply: (v) => ({ [key]: v }),
})

const AXES: Axis[] = [
  beamAxis,
  contactDelta('tip', [-1.0, 0, 1.0, 2.0]),
  contactDelta('ring1', [-1.0, 0, 1.0]),
  contactDelta('ring2', [-0.5, 0, 0.5]),
  plugRingBand,
  single('trrs.jack.contact.narrowPadWidth', [0.2, 0.35, 0.5, 0.65], 0.5, 'mm',
    '4極ジャックの接点パッド幅。狭いほど区間が広がる'),
  single('trrs.jack.contact.sleeve.axialCenter', [1.25, 3.0], 1.25, 'mm',
    'Sleeve 接点の軸位置'),
  single('model.conduction.minOverlap', [0.01, 0.02], 0.01, 'mm',
    '導通と見なす最小の重なり。幾何ではなくモデルの閾値'),
]

/**
 * 走査範囲の根拠。**任意性を明示する（オーダーの要件）。**
 * 「広く取れば頑健に見える」ことも「狭く取れば脆く見える」こともあるので、
 * どういう理由でこの幅にしたのかを artifact に残す。
 */
const SEARCH_RANGE_BASIS = [
  'beamOffset 0〜1.3mm は、完全挿入でばね 3 本が対応導体にパッド全幅で乗る条件から出した成立範囲そのもの。',
  '接点の独立ずらし ±1〜2mm は、端子間隔 (2.76〜3.8mm) より狭く、隣の導体へ移るかどうかを跨ぐ幅として選んだ。',
  'プラグ Ring 帯のずらし -0.3〜+0.2mm は、導体境界の連鎖が破れず組み立てが成立する範囲。',
  'パッド幅 0.2〜0.65mm は探索用の下限 0.3mm を跨ぐように取った。**製造可能性の判定ではない。**',
  '**どれも任意である。**範囲を広げれば割合は下がり、狭めれば上がる。割合そのものに意味を持たせないこと。',
]

const SOURCE_EVIDENCE_BOUNDARY = {
  fact: [
    '4極ジャックの端子位置 4.74 / 7.50 / 11.30mm — Lumberg 1503 28 の基板レイアウト図の記載値',
    '3極プラグの導体境界 — Lumberg 1532 10 の図面記載寸法からの演算',
  ],
  assumption: [
    '接点位置そのもの — 1503 28 に断面図が無く、接点がどこにあるかは図面に書かれていない',
    'beamOffset — 一次資料なし。採用値 0 は「接点は端子の真上」という最小の仮定',
    'パッド幅 0.5mm — 一次資料なし',
    'model.conduction.minOverlap 0.01mm — モデルの閾値であって部品の性質ではない',
  ],
  notMeasured: ['導通の実測', '音響の実測', '実物の分解・断面観察'],
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

function topologySequence(m: TrsModel): string {
  return sweep(m, { stepMm: 0.05 })
    .filter((r) => r.depthMm >= 0)
    .map((r) => classifyFromEvaluation(m.jack.terminals, m.plug.netFunctions, m.evaluate(r.depthMm, DEFAULT_FAULTS)).topologyClass)
    .join(',')
}

interface Window {
  startMm: number
  lastSampleMm: number
  endExclusiveMm: number
  widthMm: number
}

/**
 * 目標クラスが現れる区間。複数あれば全部返す。
 *
 * ## 端点の意味を分けた（v0.2.0 フォローアップ §4）
 *
 * v1 では `fromMm` / `toMm` / `widthMm` の 3 項目だった。
 * `toMm` は**最後に当たった標本の位置**で、`widthMm` はその次の刻みまで含む幅だったため、
 * profile の区間終端（13.52mm）と `toMm`（13.50mm）が食い違って見えた。
 * **同じ「終わり」という語で 2 つの違う量を指していた。**
 *
 * v2 では 3 つを別々に持つ。
 *
 *   startMm        区間の始まり（profile の nominalStartMm と一致する）
 *   lastSampleMm   目標クラスが観測された最後の標本位置
 *   endExclusiveMm lastSampleMm + stepMm。**profile の nominalEndMm と一致する**
 *   widthMm        endExclusiveMm − startMm
 */
function targetWindows(m: TrsModel): Window[] {
  const rows = sweep(m, { stepMm: STEP_MM }).filter((r) => r.depthMm >= 0)
  const out: Window[] = []
  let cur: { startMm: number; lastSampleMm: number } | null = null
  const close = (c: { startMm: number; lastSampleMm: number }): Window => {
    const startMm = +c.startMm.toFixed(2)
    const lastSampleMm = +c.lastSampleMm.toFixed(2)
    const endExclusiveMm = +(lastSampleMm + STEP_MM).toFixed(4)
    return { startMm, lastSampleMm, endExclusiveMm, widthMm: +(endExclusiveMm - startMm).toFixed(4) }
  }
  for (const r of rows) {
    const cls = classifyFromEvaluation(m.jack.terminals, m.plug.netFunctions, m.evaluate(r.depthMm, DEFAULT_FAULTS)).topologyClass
    if (cls === TARGET_CLASS) {
      if (cur) cur.lastSampleMm = r.depthMm
      else cur = { startMm: r.depthMm, lastSampleMm: r.depthMm }
    } else if (cur) {
      out.push(close(cur))
      cur = null
    }
  }
  if (cur) out.push(close(cur))
  return out
}

const fullInsertionOk = (m: TrsModel) => m.evaluate(m.fullDepthMm, DEFAULT_FAULTS).acoustic.code === 'NORMAL'

// ---------------------------------------------------------------------------
// 着手前の検査
// ---------------------------------------------------------------------------

/** 既定値が水準に入っていること。入っていないと「無改造で成立するか」を評価し損なう */
function assertShippedIncluded(): void {
  for (const a of AXES)
    if (!a.levels.includes(a.shipped))
      throw new Error(`軸 ${a.name} の水準に既定値 ${a.shipped} が入っていない。無改造の構成を一度も評価しないまま報告してしまう`)
}

/**
 * **その軸を動かすとモデルが本当に変わるか。**
 *
 * 接点の座標だけを見ると足りない。閾値の軸（minOverlap）や
 * プラグ側の軸は接点座標を変えないためである。
 * トポロジー列そのものを比べる。
 */
function assertAxesBite(): void {
  const baseSeq = topologySequence(getModel(VARIANT))
  for (const a of AXES) {
    let bites = false
    for (const lv of a.levels) {
      if (lv === a.shipped) continue
      try {
        if (topologySequence(buildModelWithOverrides(VARIANT, a.apply(lv))) !== baseSeq) {
          bites = true
          break
        }
      } catch {
        // 組めない水準は判定材料にしない
      }
    }
    if (!bites)
      throw new Error(
        `軸 ${a.name} はどの水準でもトポロジー列を変えない。空振りの軸を「振った」と数えると、`
        + `「その仮定は結論に影響しない」という誤った結論になる`,
      )
  }
}

// ---------------------------------------------------------------------------
// 走査
// ---------------------------------------------------------------------------

interface Row {
  overrides: Record<string, number>
  levels: Record<string, number>
  usable: boolean
  windows: Window[]
}

function* grid(): Generator<Record<string, number>> {
  const idx = AXES.map(() => 0)
  for (;;) {
    yield Object.fromEntries(AXES.map((a, i) => [a.name, a.levels[idx[i]]]))
    let k = AXES.length - 1
    while (k >= 0) {
      idx[k]++
      if (idx[k] < AXES[k].levels.length) break
      idx[k] = 0
      k--
    }
    if (k < 0) return
  }
}

assertShippedIncluded()
assertAxesBite()

const rows: Row[] = []
let total = 0
let buildFailed = 0
let notFullOk = 0

for (const levels of grid()) {
  total++
  // 後の軸の上書きが前の軸を上書きする。beamOffset → 個別ずらし の順に効かせる
  const overrides: Record<string, number> = {}
  for (const a of AXES) Object.assign(overrides, a.apply(levels[a.name]))
  // 個別ずらしは beamOffset の結果へ足す（両方が同じキーを触るため）
  for (const id of ['tip', 'ring1', 'ring2'] as const) {
    const d = levels[`trrs.jack.contact.${id}.axialCenterDelta`]
    if (d !== undefined) overrides[`trrs.jack.contact.${id}.axialCenter`] = +(TERMINAL[id] - levels.beamOffset + d).toFixed(4)
  }
  let m: TrsModel
  try {
    m = buildModelWithOverrides(VARIANT, overrides)
  } catch {
    buildFailed++
    rows.push({ overrides, levels, usable: false, windows: [] })
    continue
  }
  if (!fullInsertionOk(m)) {
    notFullOk++
    rows.push({ overrides, levels, usable: false, windows: [] })
    continue
  }
  rows.push({ overrides, levels, usable: true, windows: targetWindows(m) })
}

const usable = rows.filter((r) => r.usable)
const withTarget = usable.filter((r) => r.windows.length > 0)
if (!usable.length) throw new Error('成立する構成が 1 つも無かった。割合を報告する前に軸を見直すこと')

const widths = withTarget.map((r) => Math.max(...r.windows.map((w) => w.widthMm))).sort((a, b) => a - b)
const median = widths.length
  ? widths.length % 2
    ? widths[(widths.length - 1) / 2]
    : +((widths[widths.length / 2 - 1] + widths[widths.length / 2]) / 2).toFixed(4)
  : null

/**
 * **その水準では目標が 1 度も現れない**という条件を拾う。
 * 「目標が存在するには、この軸がこの水準でないことが必要」という形で書ける。
 */
const necessaryConditions = AXES.flatMap((a) => {
  const dead = a.levels.filter((lv) => {
    const at = usable.filter((r) => r.levels[a.name] === lv)
    return at.length > 0 && at.every((r) => r.windows.length === 0)
  })
  if (!dead.length) return []
  return [{
    parameter: a.name,
    unit: a.unit,
    levelsWhereTargetNeverAppears: dead,
    levelsTested: a.levels,
    statement: `${a.name} が ${dead.join(' / ')} のとき、他の軸をどう組み合わせても ${TARGET_CLASS} は現れない`,
    /** 走査した水準の中での話であって、連続的な境界を求めたものではない */
    boundaryResolved: false,
  }]
})

/**
 * 水準ごとの出現内訳。**`necessaryConditions` が 0 件でも、ここには構造が出る。**
 *
 * 「どの水準でも一度は現れる」と「どの水準でも同じくらい現れる」は全く違う。
 * 前者だけを報告すると、実際には強く効いている軸を「影響しない」と読ませてしまう。
 */
const presenceByLevel = Object.fromEntries(
  AXES.map((a) => [
    a.name,
    a.levels.map((lv) => {
      const at = usable.filter((r) => r.levels[a.name] === lv)
      const hit = at.filter((r) => r.windows.length > 0)
      const w = hit.map((r) => Math.max(...r.windows.map((x) => x.widthMm)))
      return {
        level: lv,
        isShipped: lv === a.shipped,
        configurationsUsable: at.length,
        configurationsWithTarget: hit.length,
        presenceFraction: at.length ? +(hit.length / at.length).toFixed(4) : null,
        medianIntervalWidthMm: w.length ? +[...w].sort((x, y) => x - y)[Math.floor(w.length / 2)].toFixed(4) : null,
      }
    }),
  ]),
)

/** 既定値だけの構成（無改造）。**「市販品でそうなる」という意味ではない** */
const nominalModel = getModel(VARIANT)
const nominalWindows = targetWindows(nominalModel)

/** PS000001 の図面値。**実在部品の一次資料で、こちらの仮定と逆を指している** */
const PS000001 = {
  'trrs.jack.contact.sleeve.axialCenter': 1.28,
  'trrs.jack.contact.ring2.axialCenter': 4.4,
  'trrs.jack.contact.ring1.axialCenter': 7.55,
  'trrs.jack.contact.tip.axialCenter': 12.75,
}
const psModel = buildModelWithOverrides(VARIANT, PS000001)
const psWindows = targetWindows(psModel)

/** 目標が現れなかった成立構成。全部は載せず、代表を等間隔で抜く */
const absentRows = usable.filter((r) => r.windows.length === 0)
const COUNTER_EXAMPLE_SAMPLES = 8

const counterExamples = [
  {
    kind: 'REAL_PART_DRAWING',
    label: 'pro-SIGNAL PS000001 の断面図から読んだ接点位置',
    overrides: PS000001,
    targetPresent: psWindows.length > 0,
    windows: psWindows,
    fullInsertionOk: fullInsertionOk(psModel),
    note: '**実在部品の一次資料であり、構成した仮定より重い。**この値では目標が消える。'
      + 'PS000001 は SMT・IPX5/7 の 1 部品にすぎず 4極ジャック一般を代表しないが、'
      + '「反対証拠が実在する」という事実は消えない',
  },
  // 走査の中から、目標が消えた構成を代表として少数だけ残す（全件は artifact が肥大する）。
  // **何件を落としたかを artifact に書く。**黙って切ると「これで全部」と読まれる
  ...absentRows
    .filter((_, i) => i % Math.max(1, Math.floor(absentRows.length / COUNTER_EXAMPLE_SAMPLES)) === 0)
    .slice(0, COUNTER_EXAMPLE_SAMPLES)
    .map((r) => ({
      kind: 'MODEL_SWEEP_ABSENT',
      label: '走査した構成のうち目標が現れなかったもの',
      overrides: r.levels,
      targetPresent: false,
      windows: [],
      fullInsertionOk: true,
      note: '構成した仮定であり、実在部品の主張ではない',
    })),
]

const provenance = buildProvenance({
  root: ROOT,
  inputs: listRobustnessInputs(ROOT),
  settings: {
    variantId: VARIANT,
    targetTopologyClass: TARGET_CLASS,
    stepMm: String(STEP_MM),
    axes: AXES.map((a) => `${a.name}[${a.levels.join('|')}]`).join(';'),
  },
  command: `npm run search:robustness${RELEASE ? ' -- --release' : ''}`,
  artifactDate: process.env.ARTIFACT_DATE ?? new Date().toISOString().slice(0, 10),
  release: RELEASE,
  allowRevisionOverride: argv.includes('--unsafe-revision-override'),
  envRevision: process.env.SOURCE_REVISION,
})

/**
 * **v1 → v2 の移行表。**profile と同じ方針で、旧語彙を読む消費側が沈黙しないようにする。
 *
 * 項目名を変えるのは破壊的変更である。`schemaVersion` を据え置いたまま名前を変えると、
 * 値を読む側は `undefined` を受け取り、**エラーも警告も出ないまま壊れる。**
 * v0.1.0 → v0.1.1 の `spreadStatus` で実際に起きた。同じことを別 artifact で繰り返さない。
 */
const CONTRACT_MIGRATION = {
  fromSchemaVersion: 1,
  toSchemaVersion: 2,
  breaking: true,
  renamedFields: [
    {
      field: 'nominalConfiguration.windows[].fromMm / counterExamples[].windows[].fromMm',
      from: 'fromMm',
      to: 'startMm',
      reason: '始まりは profile の nominalStartMm と一致する。名前を揃えた',
    },
    {
      field: 'windows[].toMm',
      from: 'toMm',
      to: 'lastSampleMm',
      reason: '**「終わり」という語で 2 つの違う量を指していた。**旧 toMm は最後に当たった標本位置であって区間の終端ではない',
    },
  ],
  addedFields: [
    { field: 'windows[].endExclusiveMm', reason: 'profile の nominalEndMm と一致する本当の終端。旧 toMm + stepMm' },
    { field: 'windowEndConvention', reason: '端点の規約を機械可読にする' },
    { field: 'contractMigration', reason: 'この表そのもの' },
    {
      field: 'provenance.inputFiles[].role に "input-scope" を追加',
      reason: '入力の範囲定義 (source-input-scope.v1.json) が入力になった。**追加のみで改名ではない**ので、'
        + 'role で絞り込む実装が沈黙して壊れることはない。v0.3.0 の schema を pin して新しい artifact を'
        + '検証すると enum で落ちるが、それは明示的に落ちる (v0.3.0 フォローアップ P1-2)',
    },
  ],
  consumerAction:
    '**schemaVersion で分岐すること。**1 を期待する実装は 2 を受け取ったら停止する。'
    + '区間の終端が要るなら endExclusiveMm を、観測の最後の点が要るなら lastSampleMm を使う。',
} as const

const out = {
  schemaVersion: 2 as const,
  generatedBy: 'npm run search:robustness',
  contractMigration: CONTRACT_MIGRATION,
  /** 端点の規約。`endExclusiveMm` は含まない側の端で、profile の `nominalEndMm` と一致する */
  windowEndConvention: 'EXCLUSIVE' as const,
  variantId: VARIANT,
  targetTopologyClass: TARGET_CLASS,
  basis: 'MODEL_PARAMETER_SWEEP',
  generatedFromCommit: provenance.generatedFromCommit,
  provenance,
  generatedAt: process.env.ARTIFACT_DATE ?? new Date().toISOString().slice(0, 10),
  stepMm: STEP_MM,
  sweptParameters: AXES.map((a) => a.name),
  parameterRanges: Object.fromEntries(
    AXES.map((a) => [a.name, {
      keys: a.keys,
      levels: a.levels,
      shipped: a.shipped,
      unit: a.unit,
      meaning: a.meaning,
      compound: a.keys.length > 1,
    }]),
  ),
  searchRangeBasis: SEARCH_RANGE_BASIS,
  configurationsTotal: total,
  configurationsUsable: usable.length,
  configurationsWithTarget: withTarget.length,
  configurationsBuildFailed: buildFailed,
  configurationsFullInsertionNotOk: notFullOk,
  presenceFractionWithinConstructedSweep: +(withTarget.length / usable.length).toFixed(6),
  intervalWidthMm: widths.length
    ? { min: widths[0], median, max: widths[widths.length - 1] }
    : { min: null, median: null, max: null },
  presenceByLevel,
  nominalConfiguration: {
    label: '既定値のまま（軸を 1 つも動かしていない）',
    targetPresent: nominalWindows.length > 0,
    windows: nominalWindows,
    note: '**「市販品でそうなる」という意味ではない。**このモデルの入力値を 1 つも変えていない、というだけ',
  },
  necessaryConditions,
  counterExamples,
  counterExampleSampling: {
    absentConfigurationsTotal: absentRows.length,
    modelSweepSamplesListed: Math.min(COUNTER_EXAMPLE_SAMPLES, absentRows.length),
    omitted: Math.max(0, absentRows.length - COUNTER_EXAMPLE_SAMPLES),
    note: '目標が現れなかった成立構成は等間隔で抜いた代表のみを載せている。**全件ではない。**内訳は presenceByLevel を見ること',
  },
  sourceEvidenceBoundary: SOURCE_EVIDENCE_BOUNDARY,
  /** **実物で起きる確率ではない。**この語を artifact 自身に持たせて、下流が読み違えないようにする */
  physicalProbabilityClaim: false,
  /** 実物の導通測定はまだ無い。model sweep と混ぜないため別項目にしてある */
  empiricalEvidence: null,
  notes: [
    '**これは実物の確率ではない。**presenceFractionWithinConstructedSweep は、'
    + 'ここで構成した走査空間の中で目標が現れた割合にすぎない。走査範囲の取り方は任意である (searchRangeBasis)。',
    '**イベント深さの幅 (artifacts/sensitivity.*.json) とは別の量である。**'
    + 'あちらは「イベントが何 mm で起きるか」の幅、こちらは「目標トポロジーがそもそも存在するか」。'
    + '深さの幅が安定していても、存在が仮定に依存することはありうる。',
    '目標が 0 件でも正常な結果として保存する。「探したが無かった」は「探していない」とは違う。',
    'necessaryConditions は走査した水準の中での話であり、連続的な境界を求めたものではない (boundaryResolved: false)。',
    '実物の導通測定を得たら empiricalEvidence へ入れる。**model sweep と同じ項目に混ぜない。**',
  ],
}

mkdirSync(resolve(ROOT, 'artifacts'), { recursive: true })
writeFileSync(resolve(ROOT, `artifacts/topology-robustness.${SLUG}.json`), JSON.stringify(out, null, 1) + '\n')

console.log(`\n  ${VARIANT} — ${TARGET_CLASS}`)
console.log(`  走査 ${total} 構成 / 成立 ${usable.length} (組めず ${buildFailed} / 完全挿入不成立 ${notFullOk})`)
console.log(`  目標が現れた構成: ${withTarget.length} (${(out.presenceFractionWithinConstructedSweep * 100).toFixed(1)}% ※実物の確率ではない)`)
console.log(`  区間幅: 最小 ${out.intervalWidthMm.min} / 中央 ${out.intervalWidthMm.median} / 最大 ${out.intervalWidthMm.max} mm`)
console.log(`  無改造の構成: ${nominalWindows.length ? `${nominalWindows[0].startMm}〜${nominalWindows[0].endExclusiveMm} mm (最後の標本 ${nominalWindows[0].lastSampleMm})` : '目標なし'}`)
console.log(`  目標が消える単独水準: ${necessaryConditions.length} 件`)
for (const c of necessaryConditions) console.log(`    ${c.statement}`)
console.log('  水準ごとの出現率:')
for (const [name, lv] of Object.entries(presenceByLevel))
  console.log(`    ${name.padEnd(46)} ${lv.map((x) => `${x.level}:${x.presenceFraction === null ? '-' : (x.presenceFraction * 100).toFixed(0) + '%'}`).join(' ')}`)
console.log(`  PS000001 の図面値: ${psWindows.length ? '目標あり' : '**目標なし（反対証拠）**'}`)
console.log(`  artifacts/topology-robustness.${SLUG}.json を書き出した`)
