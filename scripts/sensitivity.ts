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
      if (k.includes('TIP')) tipBridge = true
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

  return { bridgeKinds: kinds, bridgeBands: bands, tipBridge, fullOk, events: ev }
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
