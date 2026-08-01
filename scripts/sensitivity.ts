/**
 * 仮定パラメータの感度解析。
 *   npm run sensitivity
 *
 * このプロジェクトの結論のうち、どれが図面 (FACT) から出ていて揺れないもので、
 * どれが仮定次第で動く数字なのかを、機械的に仕分ける。
 *
 * 実物との突き合わせをしていない以上、「11.78mm で橋絡する」のような単一値は
 * そのままでは意味が強すぎる。ここで各仮定を成立範囲いっぱいに振り、
 * 何が不変で何が動くかを実測して、動く数字には幅を付ける。
 *
 * 範囲は勝手に決めない。すべて図面の FACT 値と、モデルが成立するための
 * 幾何条件から導く (deriveRanges を参照)。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildModelWithOverrides, getModel } from '../src/data'
import { sweep } from '../src/model/sweep'
import { DEFAULT_FAULTS } from '../src/model/contact'
import { plugRadiusAt } from '../src/model/resolve'

import type { TrsModel } from '../src/model/engine'

const STEP = 0.01
const VARIANT = 'TRS|JACK-TRS' as const

// ---------------------------------------------------------------------------
// 観測量
// ---------------------------------------------------------------------------

interface Observation {
  /** 橋絡した導体の組。出現順 */
  bridgeKinds: string[]
  /** 橋絡区間 [開始深度, 終了深度, 幅] */
  bridgeBands: [number, number, number][]
  /** Tip 導体を含む橋絡が 1 度でも起きたか (幾何的にありえないはずのもの) */
  tipBridge: boolean
  /** どの接点が、何と何を橋絡したか。接点 ID で絞らないと取り違える */
  bridgingByContact: Record<string, string[]>
  /** 完全挿入で 3 端子とも正しい導体に CLOSED でつながるか */
  fullOk: boolean
  /** 主要イベントの深度 */
  events: Record<string, number | null>
}

function observe(m: TrsModel, stepMm = STEP): Observation {
  const rows = sweep(m, { stepMm })
  const bands: [number, number, number][] = []
  const kinds: string[] = []
  let tipBridge = false
  const byContact: Record<string, Set<string>> = {}
  let cur: { k: string; a: number; b: number } | null = null

  const ev: Record<string, number | null> = {
    firstTouch: null,
    firstConduction: null,
    sleeveOnTip: null,
    ringBreakOpen: null,
    firstBridge: null,
    bridgeEnd: null,
    allCorrect: null,
  }

  for (const r of rows) {
    const sl = r.contacts.find((c) => c.contactId === 'JC_SLEEVE')!
    const rg = r.contacts.find((c) => c.contactId === 'JC_RING')!
    const tp = r.contacts.find((c) => c.contactId === 'JC_TIP')!

    if (ev.firstTouch === null && r.contacts.some((c) => c.touchingSegments.length > 0)) ev.firstTouch = r.depthMm
    if (ev.firstConduction === null && r.contacts.some((c) => c.connectedNets.length > 0)) ev.firstConduction = r.depthMm
    if (ev.sleeveOnTip === null && sl.connectedNets.includes('TIP')) ev.sleeveOnTip = r.depthMm
    if (ev.ringBreakOpen === null && rg.breakState === 'BREAK_OPEN') ev.ringBreakOpen = r.depthMm

    // 橋絡 (どの接点でも)
    for (const c of r.contacts) {
      if (c.connectedNets.length < 2) continue
      const k = [...c.connectedNets].sort().join('+')
      if (c.connectedNets.includes('TIP')) tipBridge = true
      ;(byContact[c.contactId] ??= new Set()).add(k)
      if (!cur || cur.k !== k) {
        if (cur) bands.push([cur.a, cur.b, +(cur.b - cur.a).toFixed(4)])
        cur = { k, a: r.depthMm, b: r.depthMm }
        if (!kinds.includes(k)) kinds.push(k)
      } else cur.b = r.depthMm
    }

    // 全接点が正しい導体だけにつながった最初の深度
    if (ev.allCorrect === null) {
      const ok =
        tp.connectedNets.join() === 'TIP' &&
        rg.connectedNets.join() === 'RING' &&
        sl.connectedNets.join() === 'SLEEVE'
      if (ok) ev.allCorrect = r.depthMm
    }
  }
  if (cur) bands.push([cur.a, cur.b, +(cur.b - cur.a).toFixed(4)])

  if (bands.length) {
    ev.firstBridge = bands[0][0]
    ev.bridgeEnd = bands[bands.length - 1][1]
  }

  const full = rows[rows.length - 1]
  const t = full.contacts
  const fullOk =
    t.every((c) => c.state === 'CLOSED' && c.connectedNets.length === 1) &&
    t.find((c) => c.contactId === 'JC_TIP')!.connectedNets[0] === 'TIP' &&
    t.find((c) => c.contactId === 'JC_RING')!.connectedNets[0] === 'RING' &&
    t.find((c) => c.contactId === 'JC_SLEEVE')!.connectedNets[0] === 'SLEEVE'

  return {
    bridgeKinds: kinds,
    bridgeBands: bands,
    tipBridge,
    bridgingByContact: Object.fromEntries(Object.entries(byContact).map(([k, v]) => [k, [...v]])),
    fullOk,
    events: ev,
  }
}

// ---------------------------------------------------------------------------
// 成立範囲の導出 (勝手な値を置かない)
// ---------------------------------------------------------------------------

const base = getModel(VARIANT)
const seg = (id: string) => base.plug.segments.find((s) => s.id === id)!
const D = base.fullDepthMm // 14.0 (FACT)

/**
 * 接点の軸位置の成立範囲。
 * ・完全挿入 (d=D) で、パッド全幅が対応する導体区間の内側に入ること
 * ・端子から前方へ伸びる片持ち梁なので、接点は端子より前 (浅い側) にあること
 * いずれも図面の FACT 値だけから決まる。
 */
function axialRange(segId: string, padWidth: number, terminalAxial: number): [number, number] {
  const s = seg(segId)
  const lo = D - (s.endMm - padWidth / 2) // 導体後端にパッド後端が接する
  const hi = D - (s.startMm + padWidth / 2) // 導体前端にパッド前端が接する
  return [Math.max(0, lo), Math.min(hi, terminalAxial)]
}

function deriveRanges() {
  const padTip = base.jack.contacts.find((c) => c.id === 'JC_TIP')!.padWidthMm
  const padRing = base.jack.contacts.find((c) => c.id === 'JC_RING')!.padWidthMm
  const padSleeve = base.jack.contacts.find((c) => c.id === 'JC_SLEEVE')!.padWidthMm
  return {
    'jack.contact.tip.axialCenter': axialRange('TIP', padTip, base.dims.num('jack.pin3.axial')),
    'jack.contact.ring.axialCenter': axialRange('RING', padRing, base.dims.num('jack.pin2.axial')),
    'jack.contact.sleeve.axialCenter': axialRange('SLEEVE', padSleeve, base.dims.num('jack.pin1.axial')),
    // パッド幅: 下限は導通とみなす最小重なり、上限は接点が乗る導体の幅
    // (それより広いと完全挿入で必ず絶縁帯にはみ出す)
    'jack.contact.tip.padWidth': [base.contactCfg.minConductionOverlapMm, seg('TIP').endMm - seg('TIP').startMm] as [number, number],
    'jack.contact.ring.padWidth': [base.contactCfg.minConductionOverlapMm, seg('RING').endMm - seg('RING').startMm] as [number, number],
    'jack.contact.sleeve.padWidth': [base.contactCfg.minConductionOverlapMm, seg('SLEEVE').endMm - seg('SLEEVE').startMm] as [number, number],
    // 追従量: ここだけは「成立範囲」ではなく、あえて壊れるところまで振る。
    // Tip と Ring の半径差 0.15mm を上限にしてしまうと、「Tip 橋絡が起きない」
    // という結論がその上限の言い換えになり、検証にならない (循環する)。
    // 段差の 2 倍まで振って、どこで壊れるかを実測する。
    'model.contact.complianceMm': [0, 2 * (base.plug.bodyRadiusMm - 1.6)] as [number, number],
  }
}

const RANGES = deriveRanges()

// ---------------------------------------------------------------------------
// 1) 一つずつ振る (OAT)
// ---------------------------------------------------------------------------

const N = 41
const oat: Record<string, unknown> = {}

for (const [key, [lo, hi]] of Object.entries(RANGES)) {
  const rows: { v: number; o: Observation | null }[] = []
  for (let i = 0; i < N; i++) {
    const v = +(lo + ((hi - lo) * i) / (N - 1)).toFixed(5)
    try {
      rows.push({ v, o: observe(buildModelWithOverrides(VARIANT, { [key]: v })) })
    } catch {
      rows.push({ v, o: null }) // モデルが組めない値 (幅ゼロ等)
    }
  }
  const valid = rows.filter((r) => r.o)
  const fullOkRows = valid.filter((r) => r.o!.fullOk)
  const anyTipBridge = valid.filter((r) => r.o!.tipBridge)
  const fb = fullOkRows.map((r) => r.o!.events.firstBridge).filter((x): x is number => x !== null)
  const kindsSet = new Set(fullOkRows.map((r) => r.o!.bridgeKinds.join(' → ')))

  oat[key] = {
    range: [lo, hi],
    current: base.dims.num(key),
    tried: rows.length,
    modelBuilt: valid.length,
    fullInsertionOkCount: fullOkRows.length,
    fullInsertionOkRange: fullOkRows.length
      ? [fullOkRows[0].v, fullOkRows[fullOkRows.length - 1].v]
      : null,
    tipBridgeCount: anyTipBridge.length,
    bridgeKindPatterns: [...kindsSet],
    firstBridgeRange: fb.length ? [Math.min(...fb), Math.max(...fb)] : null,
    // 完全挿入が成立する範囲だけで、各イベントの深さがどこまで動くか
    eventRanges: (() => {
      const out: Record<string, [number, number] | null> = {}
      for (const k of Object.keys(fullOkRows[0]?.o!.events ?? {})) {
        const vs = fullOkRows.map((r) => r.o!.events[k]).filter((x): x is number => x !== null)
        out[k] = vs.length ? [Math.min(...vs), Math.max(...vs)] : null
      }
      return out
    })(),
  }
  const r = oat[key] as { fullInsertionOkCount: number; tipBridgeCount: number; firstBridgeRange: number[] | null }
  console.log(
    `  ${key.padEnd(38)} 範囲 ${lo.toFixed(3)}〜${hi.toFixed(3)}  ` +
      `完全挿入OK ${r.fullInsertionOkCount}/${valid.length}  ` +
      `Tip橋絡 ${r.tipBridgeCount}  ` +
      `橋絡深度 ${r.firstBridgeRange ? `${r.firstBridgeRange[0].toFixed(2)}〜${r.firstBridgeRange[1].toFixed(2)}` : '—'}`,
  )
}

// ---------------------------------------------------------------------------
// 2) 全部同時に振る (交互作用を見る)
//    OAT だけだと「1 つずつなら平気だが組み合わせると壊れる」を見逃す。
//    乱数は使えない (再現性のため) ので、決定論的な格子で回す。
// ---------------------------------------------------------------------------

const JOINT_KEYS = Object.keys(RANGES)
const LEVELS = 3 // 各パラメータ 3 水準 → 3^7 = 2187 通り
const JOINT_STEP = 0.02 // 同時振りは刻みを粗くする。0.05 だと 0.18mm の橋絡窓を取りこぼしうる
console.log(`\n  同時振り: ${LEVELS}^${JOINT_KEYS.length} = ${LEVELS ** JOINT_KEYS.length} 通り`)

let jointTried = 0
let jointBuilt = 0
let jointFullOk = 0
let jointTipBridge = 0
const jointFirstBridge: number[] = []
const jointKindPatterns = new Map<string, number>()
const violations: { cfg: Record<string, number>; why: string }[] = []
let belowStepTried = 0
let belowStepTipBridge = 0
/** Tip 導体の最大半径と Ring/Sleeve の半径の差。Tip 橋絡が起きうる下限 */
const STEP_HEIGHT = base.plug.bodyRadiusMm - 1.6

const idx = new Array(JOINT_KEYS.length).fill(0)
const total = LEVELS ** JOINT_KEYS.length
for (let n = 0; n < total; n++) {
  let t = n
  for (let d = 0; d < JOINT_KEYS.length; d++) {
    idx[d] = t % LEVELS
    t = Math.floor(t / LEVELS)
  }
  const cfg: Record<string, number> = {}
  JOINT_KEYS.forEach((k, d) => {
    const [lo, hi] = RANGES[k as keyof typeof RANGES]
    cfg[k] = +(lo + ((hi - lo) * idx[d]) / (LEVELS - 1)).toFixed(5)
  })
  jointTried++
  let o: Observation
  try {
    o = observe(buildModelWithOverrides(VARIANT, cfg), JOINT_STEP)
  } catch {
    continue
  }
  jointBuilt++
  if (o.fullOk) {
    jointFullOk++
    if (o.events.firstBridge !== null) jointFirstBridge.push(o.events.firstBridge)
    const kp = o.bridgeKinds.join(' → ') || '(橋絡なし)'
    jointKindPatterns.set(kp, (jointKindPatterns.get(kp) ?? 0) + 1)
  }
  // Tip 橋絡は compliance が段差 0.15mm を超えたときだけ起きるはず。
  // 「超えていないのに起きた」ものがあれば、それが本当の反例になる。
  const comp = cfg['model.contact.complianceMm']
  if (comp < STEP_HEIGHT) {
    belowStepTried++
    if (o.tipBridge) {
      belowStepTipBridge++
      if (violations.length < 5) violations.push({ cfg, why: 'compliance が段差未満なのに Tip 橋絡' })
    }
  }
  if (o.tipBridge) jointTipBridge++
}

console.log(`  組めた ${jointBuilt} / 完全挿入OK ${jointFullOk} / Tip橋絡 ${jointTipBridge}`)
console.log(
  `  うち compliance < 段差 ${STEP_HEIGHT} の ${belowStepTried} 通りでの Tip 橋絡: ${belowStepTipBridge} 件`,
)

// Tip 橋絡が始まる compliance のしきい値を二分法で求め、段差 0.15 と照合する
let lo2 = 0
let hi2 = 2 * STEP_HEIGHT
for (let i = 0; i < 24; i++) {
  const mid = (lo2 + hi2) / 2
  if (observe(buildModelWithOverrides(VARIANT, { 'model.contact.complianceMm': mid })).tipBridge) hi2 = mid
  else lo2 = mid
}
console.log(`  Tip 橋絡が始まる compliance = ${hi2.toFixed(5)} (段差 ${STEP_HEIGHT} の直上)`)

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 3) 4極 (TRRS)
//
// 4極ジャックの接点位置には一次図面が無い。そこを振っても「仮定を振ったら
// 仮定の分だけ動いた」で終わる。意味があるのは、**プラグ側が FACT** である
// ことを使った次の 2 つ。
//   (A) Tip 導体は他の 3 本より 0.15mm 低い → Tip を含む橋絡は起きない
//   (B) 同一半径 (1.750) のプラトーの間隔は 3 本とも 0.700 (図面記載の絶縁帯幅)
//       → パッドがこれを超えるかどうかだけで橋絡の有無が決まる
// どちらも接点の軸位置に依存しないはず。それを実測で確かめる。
// ---------------------------------------------------------------------------

const V4 = 'TRRS-CTIA|JACK-TRRS' as const
const m4 = getModel(V4)
const seg4 = (id: string) => m4.plug.segments.find((s) => s.id === id)!

/** 4極プラグの同一半径プラトーの間隔 (FACT 由来のはず) */
function plateauGaps(m: TrsModel): number[] {
  const rMax = Math.max(...m.plug.profile.map((p) => p.r))
  const runs: [number, number][] = []
  for (let s = 0; s <= m.plug.fingerLengthMm; s += 0.001) {
    const hi = plugRadiusAt(m.plug.profile, s) >= rMax - 1e-9
    const last = runs[runs.length - 1]
    if (hi && last && Math.abs(last[1] - s) < 0.0015) last[1] = s
    else if (hi) runs.push([s, s])
  }
  return runs.slice(1).map((r, i) => +(r[0] - runs[i][1]).toFixed(4))
}

const GAPS4 = plateauGaps(m4)
console.log(`\n  4極プラグの同一半径プラトー間隔: ${GAPS4.join(', ')} mm`)

/** 4極ジャック接点の成立範囲 (完全挿入でパッド全幅が対応導体に収まること) */
function axialRange4(segId: string, padWidth: number): [number, number] {
  const s = seg4(segId)
  return [Math.max(0, D - (s.endMm - padWidth / 2)), D - (s.startMm + padWidth / 2)]
}

const narrow = m4.dims.num('trrs.jack.contact.narrowPadWidth')
const RANGES4: Record<string, [number, number]> = {
  'trrs.jack.contact.tip.axialCenter': axialRange4('TIP', m4.dims.num('jack.contact.tip.padWidth')),
  'trrs.jack.contact.ring1.axialCenter': axialRange4('RING', narrow),
  'trrs.jack.contact.ring2.axialCenter': axialRange4('RING2', narrow),
  'trrs.jack.contact.sleeve.axialCenter': axialRange4('SLEEVE', m4.dims.num('jack.contact.sleeve.padWidth')),
  'trrs.jack.contact.narrowPadWidth': [base.contactCfg.minConductionOverlapMm, 2.3],
  'jack.contact.sleeve.padWidth': [base.contactCfg.minConductionOverlapMm, 2.5],
  'model.contact.complianceMm': [0, 2 * STEP_HEIGHT],
}

// --- (A) Tip を含む橋絡 -----------------------------------------------------
const K4 = Object.keys(RANGES4)
const L4 = 3
const total4 = L4 ** K4.length
let built4 = 0
let fullOk4 = 0
let tip4 = 0
let belowStep4 = 0
let belowStepTip4 = 0
const kinds4 = new Map<string, number>()
const byContact4 = new Map<string, number>()
const pairByContact4 = new Set<string>()
const viol4: { cfg: Record<string, number>; why: string }[] = []

const idx4 = new Array(K4.length).fill(0)
for (let n = 0; n < total4; n++) {
  let t = n
  for (let d = 0; d < K4.length; d++) {
    idx4[d] = t % L4
    t = Math.floor(t / L4)
  }
  const cfg: Record<string, number> = {}
  K4.forEach((k, d) => {
    const [lo, hi] = RANGES4[k]
    cfg[k] = +(lo + ((hi - lo) * idx4[d]) / (L4 - 1)).toFixed(5)
  })
  let o: Observation
  try {
    o = observe(buildModelWithOverrides(V4, cfg), JOINT_STEP)
  } catch {
    continue
  }
  built4++
  if (o.fullOk) {
    fullOk4++
    kinds4.set(o.bridgeKinds.join(' → ') || '(橋絡なし)', (kinds4.get(o.bridgeKinds.join(' → ') || '(橋絡なし)') ?? 0) + 1)
    for (const [cid, ks] of Object.entries(o.bridgingByContact)) {
      byContact4.set(cid, (byContact4.get(cid) ?? 0) + 1)
      for (const k of ks) pairByContact4.add(`${cid}: ${k}`)
    }
  }
  if (o.tipBridge) tip4++
  if (cfg['model.contact.complianceMm'] < STEP_HEIGHT) {
    belowStep4++
    if (o.tipBridge) {
      belowStepTip4++
      if (viol4.length < 5) viol4.push({ cfg, why: '4極: compliance が段差未満なのに Tip 橋絡' })
    }
  }
}
console.log(`  4極 同時振り ${L4}^${K4.length} = ${total4} 通り: 組めた ${built4} / 完全挿入OK ${fullOk4}`)
console.log(`  橋絡した接点 (完全挿入OK のみ): ${[...byContact4.entries()].map(([c, n]) => `${c} ${n}件`).join(' / ') || 'なし'}`)
console.log(`  接点ごとの組: ${[...pairByContact4].sort().join(' | ')}`)
console.log(`  うち compliance < ${STEP_HEIGHT.toFixed(3)} の ${belowStep4} 通りでの Tip 橋絡: ${belowStepTip4} 件`)

// --- (B) 橋絡はパッド幅がプラトー間隔を超えたときだけ起きるか -----------------
//     narrowPadWidth を細かく振り、接点位置は 3 通りに動かしても
//     しきい値が動かないことを見る。
/**
 * 橋絡のしきい値を、走査ではなく「最も橋絡しやすい深さ」1 点で測る。
 *
 * 深さを走査して「どこかで橋絡したか」を見る方法は使えない。橋絡の窓は
 * しきい値付近で幾らでも狭くなるので、走査刻みが答えを変えてしまう
 * (0.02mm 刻みにしたら位置ごとに 0.725 と 0.745 に割れた)。
 * パッド中心が絶縁帯の中心に来る深さで評価すれば、サンプリングが要らない。
 */
function bridgeThreshold(
  axialKey: string,
  padKey: string,
  contactId: string,
  insulatorCenter: number,
  axial: number,
): number | null {
  for (let i = 600; i <= 900; i++) {
    const w = i / 1000
    const m = buildModelWithOverrides(V4, { [axialKey]: axial, [padKey]: w })
    const c = m.evaluate(insulatorCenter + axial, DEFAULT_FAULTS).contacts.find((x) => x.contactId === contactId)
    if (c && c.connectedNets.length > 1) return w
  }
  return null
}

const padThresholds: { contactId: string; axial: number; threshold: number | null }[] = []
for (const [contactId, axialKey, padKey, insC, axials] of [
  ['JC_RING2', 'trrs.jack.contact.ring2.axialCenter', 'trrs.jack.contact.narrowPadWidth', (7.8 + 8.5) / 2, [3.5, 4.0, 4.35, 4.8, 5.2]],
  ['JC_SLEEVE', 'trrs.jack.contact.sleeve.axialCenter', 'jack.contact.sleeve.padWidth', (10.8 + 11.5) / 2, [0.5, 1.25, 2.0]],
  // Ring1 接点がまたげるのは第1絶縁帯 (Tip↔Ring1) だけ。Tip が 0.15mm 低いので橋絡できないはず
  ['JC_RING', 'trrs.jack.contact.ring1.axialCenter', 'trrs.jack.contact.narrowPadWidth', (4.8 + 5.5) / 2, [6.45, 7.35, 8.25]],
] as const) {
  for (const axial of axials) {
    padThresholds.push({ contactId, axial, threshold: bridgeThreshold(axialKey, padKey, contactId, insC, axial) })
  }
}
for (const cid of ['JC_RING2', 'JC_SLEEVE', 'JC_RING']) {
  const g = padThresholds.filter((p) => p.contactId === cid)
  console.log(
    `  ${cid.padEnd(10)} が橋絡し始めるパッド幅: ${g.map((p) => `位置${p.axial}→${p.threshold ?? 'ならない'}`).join(' / ')}`,
  )
}
console.log(`  (プラトー間隔 ${GAPS4[0]} + 導通の最小重なり ${base.contactCfg.minConductionOverlapMm} × 2 = ${(0.7 + 2 * base.contactCfg.minConductionOverlapMm).toFixed(3)} が理論値)`)

// --- (C) 混挿: 3極プラグ × 4極ジャック --------------------------------------
//     Ring2 接点が 3極プラグの Sleeve に当たるか絶縁帯に乗るかは、
//     仮定した接点位置で変わる。成立範囲のどこで結論が変わるかを測る。
const mixOutcomes: { axial: number; ring2Nets: string }[] = []
const [r2lo, r2hi] = RANGES4['trrs.jack.contact.ring2.axialCenter']
for (let i = 0; i <= 40; i++) {
  const a = +(r2lo + ((r2hi - r2lo) * i) / 40).toFixed(4)
  const m = buildModelWithOverrides('TRS|JACK-TRRS', { 'trrs.jack.contact.ring2.axialCenter': a })
  const full = sweep(m, { stepMm: 0.05 }).slice(-1)[0]
  const c = full.contacts.find((x) => x.contactId === 'JC_RING2')
  mixOutcomes.push({ axial: a, ring2Nets: c?.connectedNets.join('+') || '(未接続)' })
}
const mixCount = new Map<string, number>()
for (const o of mixOutcomes) mixCount.set(o.ring2Nets, (mixCount.get(o.ring2Nets) ?? 0) + 1)
console.log(
  `  混挿 3極×4極: Ring2 接点の行き先 ${[...mixCount.entries()].map(([k, v]) => `${k}:${v}/41`).join(' / ')}`,
)

const out = {
  schemaVersion: 1,
  variant: VARIANT,
  stepMm: STEP,
  note:
    '各仮定パラメータを、図面の FACT 値と幾何条件から導いた成立範囲いっぱいに振った結果。' +
    '範囲の導出は scripts/sensitivity.ts の deriveRanges を参照。乱数は使っていないので何度実行しても同じ結果になる。',
  baseline: observe(base),
  ranges: RANGES,
  oneAtATime: oat,
  trrs: {
    variant: V4,
    plateauGaps: GAPS4,
    ranges: RANGES4,
    joint: {
      levels: L4,
      combinations: total4,
      modelBuilt: built4,
      fullInsertionOk: fullOk4,
      tipBridgeCount: tip4,
      belowStepHeightTried: belowStep4,
      belowStepHeightTipBridge: belowStepTip4,
      violations: viol4,
      bridgeKindPatterns: [...kinds4.entries()].sort((a, b) => b[1] - a[1]).map(([pattern, count]) => ({ pattern, count })),
      bridgingContactCounts: [...byContact4.entries()].map(([contactId, count]) => ({ contactId, count })),
      bridgingPairsByContact: [...pairByContact4].sort(),
    },
    padWidthThresholds: padThresholds,
    mixedInsertion: {
      note: '3極プラグ × 4極ジャック。Ring2 接点の軸位置を成立範囲いっぱいに振ったときの、完全挿入での行き先。',
      range: [r2lo, r2hi],
      samples: mixOutcomes,
      counts: [...mixCount.entries()].map(([nets, count]) => ({ nets, count })),
    },
  },
  joint: {
    levels: LEVELS,
    combinations: total,
    modelBuilt: jointBuilt,
    fullInsertionOk: jointFullOk,
    tipBridgeCount: jointTipBridge,
    stepHeightMm: STEP_HEIGHT,
    belowStepHeightTried: belowStepTried,
    belowStepHeightTipBridge: belowStepTipBridge,
    tipBridgeComplianceThreshold: +hi2.toFixed(5),
    violations,
    firstBridgeRange: jointFirstBridge.length
      ? [Math.min(...jointFirstBridge), Math.max(...jointFirstBridge)]
      : null,
    bridgeKindPatterns: [...jointKindPatterns.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([pattern, count]) => ({ pattern, count })),
  },
}

const OUT = resolve(process.cwd(), 'artifacts')
mkdirSync(OUT, { recursive: true })
writeFileSync(resolve(OUT, 'sensitivity.json'), JSON.stringify(out, null, 1) + '\n')
console.log('\n  artifacts/sensitivity.json を書き出した')
