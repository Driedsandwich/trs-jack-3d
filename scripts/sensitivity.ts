/**
 * 仮定パラメータの感度解析。
 *   npm run sensitivity   (実行に 15 分ほどかかる。CI で回すものではない)
 *
 * このプロジェクトの結論のうち、どれが図面から出ていて揺れないもので、
 * どれが仮定次第で動く数字なのかを、機械的に仕分ける。
 *
 * 実物との突き合わせをしていない以上、「11.76mm で橋絡する」のような単一値は
 * そのままでは意味が強すぎる。ここで各仮定を成立範囲いっぱいに振り、
 * 何が不変で何が動くかを実測して、動く数字には幅を付ける。
 *
 * ── 2026-08-01 の作り直しについて ─────────────────────────────
 * 初版には手法上の欠陥が 4 つあり、独立した反証で全部指摘された。作り直した。
 *
 *  1. 同時振りの compliance が 3 水準 {0, 0.15, 0.30} だったため、「段差未満」に
 *     該当するのは 0 だけだった。しかも compliance=0 は Tip 導体に一切導通できない
 *     退化モデル (Tip はプラトーを持たず全域が斜面なので接触帯の幅が 0 になる) で、
 *     完全挿入すら成立しない。つまり「段差未満の 729 通りで Tip 橋絡 0 件」は
 *     幾何の証拠ではなく、自明な帰結だった。→ 区間の内側に水準を置く。
 *  2. しきい値を 0.001 刻みの走査で測っていた。真値 0.720 が 0.721 と 1 目盛ぶん
 *     過大に出ていた。→ 二分法にする。
 *  3. しきい値の評価深さ (絶縁帯中心) が完全挿入 14mm を超える構成でも、黙って
 *     値を返していた。到達できない深さの答えを報告していた。→ 深さを clamp する。
 *  4. 「範囲は『完全挿入で正しく結線される』条件から導いた」と書いていたが、
 *     実装は「パッド全幅が導体区間に収まる」という別の条件だった。両者は一致せず、
 *     公表していた幅がずれていた。→ 幅は同時振りの実測で出し直す。
 *
 * また、しきい値の式に自分で minOverlap を挙げておきながら、それを振っていなかった。
 * ブレーク接点のしきい値も振っていなかった。どちらも公表値を動かす。→ 追加した。
 *
 * ── schemaVersion 3 (2026-08-01 夕) で足したもの ──────────────
 *  A. 公差の「箱」。§6-1 では bodyRadius (FACT) だけを振っていたが、段差のもう一方の
 *     端 insulatorRadius は DERIVED で、注記自身が図面実測 φ3.20〜3.22 という幅を
 *     認めている。2 つを同時に振らないと「最悪どこまで薄くなるか」が出ない。
 *  B. 力のモデル (force.* 9 件)。初版は「対象外」とだけ書いていた。ただし
 *     calibrationScale は純粋な倍率で独立した根拠を持たないので、それを混ぜて振ると
 *     「倍率を振れば倍率の分動く」以上のことが言えない。校正係数は固定し、
 *     物理的な意味のある 8 件だけを振る。
 * ────────────────────────────────────────────────────────────
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildModelWithOverrides, getModel } from '../src/data'
import { sweep } from '../src/model/sweep'
import { computeForceCurve } from '../src/model/force'
import { plugRadiusAt } from '../src/model/resolve'
import { DEFAULT_FAULTS } from '../src/model/contact'
import type { TrsModel } from '../src/model/engine'

const V3 = 'TRS|JACK-TRS' as const
const V4 = 'TRRS-CTIA|JACK-TRRS' as const
const F = DEFAULT_FAULTS

const base = getModel(V3)
/** Tip 導体の最大半径と Ring/Sleeve プラトーの差。Tip 橋絡が起きうる床 */
const STEP_HEIGHT = base.plug.bodyRadiusMm - 1.6

// ---------------------------------------------------------------------------
// 道具
// ---------------------------------------------------------------------------

/** 単調な述語の切り替わり点を二分法で。走査刻みに答えを支配させないため */
function bisect(lo: number, hi: number, holds: (v: number) => boolean, iters = 50): number {
  for (let i = 0; i < iters; i++) {
    const mid = (lo + hi) / 2
    if (holds(mid)) hi = mid
    else lo = mid
  }
  return hi
}

/** その接点「そのもの」が 2 導体に同時に触れているか。必ず接点 ID で絞る */
function bridgingAt(m: TrsModel, contactId: string, depth: number): string | null {
  const c = m.evaluate(depth, F).contacts.find((x) => x.contactId === contactId)
  return c && c.connectedNets.length > 1 ? [...c.connectedNets].sort().join('+') : null
}

/** どこかの接点が Tip を含む橋絡をするか (存在判定なので走査でよい) */
function anyTipBridge(m: TrsModel, stepMm = 0.01): boolean {
  return sweep(m, { stepMm }).some((r) =>
    r.contacts.some((c) => c.connectedNets.length > 1 && c.connectedNets.includes('TIP')),
  )
}

/** 完全挿入で 3 端子とも正しい導体に CLOSED でつながるか */
function fullOk(m: TrsModel): boolean {
  const want: Record<string, string> = { JC_TIP: 'TIP', JC_RING: 'RING', JC_SLEEVE: 'SLEEVE' }
  return m
    .evaluate(m.fullDepthMm, F)
    .contacts.every(
      (c) => c.state === 'CLOSED' && c.connectedNets.length === 1 && c.connectedNets[0] === want[c.contactId],
    )
}

/**
 * 橋絡が「最初に」始まる深さ。
 *
 * 二分法だけでは駄目。橋絡は深さに対して単調ではなく (絶縁帯ごとに窓が開いて閉じる)、
 * いきなり二分法をかけると最初の立ち上がりではなく別の窓の縁を拾うことがある。
 * 粗い走査で最初の窓を挟み込んでから、その区間だけを二分法で詰める。
 * 走査刻みより狭い窓は取りこぼすので、刻みは十分細かくする。
 */
function firstBridgeDepth(m: TrsModel, contactId: string, coarse = 0.002): number | null {
  let prev = 0
  for (let d = 0; d <= m.fullDepthMm + 1e-9; d += coarse) {
    if (bridgingAt(m, contactId, Math.min(d, m.fullDepthMm)) !== null) {
      return bisect(prev, Math.min(d, m.fullDepthMm), (x) => bridgingAt(m, contactId, x) !== null)
    }
    prev = d
  }
  return null
}

/** 橋絡が終わる深さ (firstBridgeDepth の直後の窓の右端) */
function bridgeEndDepth(m: TrsModel, contactId: string, from: number, coarse = 0.002): number {
  let prev = from
  for (let d = from; d <= m.fullDepthMm + 1e-9; d += coarse) {
    const dd = Math.min(d, m.fullDepthMm)
    if (bridgingAt(m, contactId, dd) === null) return bisect(prev, dd, (x) => bridgingAt(m, contactId, x) === null)
    prev = dd
  }
  return m.fullDepthMm
}

/** ブレーク接点が「最初に」開く深さ。開いて閉じて再び開くので二分法単独では誤る */
function firstBreakOpen(m: TrsModel, contactId: string, coarse = 0.002): number | null {
  const opens = (d: number) =>
    m.evaluate(d, F).contacts.find((c) => c.contactId === contactId)?.breakState === 'BREAK_OPEN'
  let prev = 0
  for (let d = 0; d <= m.fullDepthMm + 1e-9; d += coarse) {
    const dd = Math.min(d, m.fullDepthMm)
    if (opens(dd)) return bisect(prev, dd, opens)
    prev = dd
  }
  return null
}

/** 同一半径プラトーの間隔。端点はセグメント境界へ吸着させる (走査粒度を持ち込まない) */
function plateauGaps(m: TrsModel): number[] {
  const rMax = Math.max(...m.plug.profile.map((p) => p.r))
  const runs: [number, number][] = []
  for (let s = 0; s <= m.plug.fingerLengthMm; s += 0.0005) {
    const hi = plugRadiusAt(m.plug.profile, s) >= rMax - 1e-9
    const last = runs[runs.length - 1]
    if (hi && last && Math.abs(last[1] - s) < 0.001) last[1] = s
    else if (hi) runs.push([s, s])
  }
  const snap = (x: number) => {
    let v = x
    let d = Infinity
    for (const sg of m.plug.segments) for (const e of [sg.startMm, sg.endMm]) {
      const dd = Math.abs(e - x)
      if (dd < d && dd < 0.01) { d = dd; v = e }
    }
    return v
  }
  return runs.slice(1).map((r, i) => +(snap(r[0]) - snap(runs[i][1])).toFixed(6))
}

// ---------------------------------------------------------------------------
// 1) 基準構成を正確に測る
// ---------------------------------------------------------------------------

const baselineFirst = firstBridgeDepth(base, 'JC_SLEEVE')!
const baselineEnd = bridgeEndDepth(base, 'JC_SLEEVE', baselineFirst)
console.log(
  `  基準の橋絡区間 (二分法): ${baselineFirst.toFixed(4)}〜${baselineEnd.toFixed(4)} mm (幅 ${(baselineEnd - baselineFirst).toFixed(4)})`,
)
const byScan = [0.02, 0.01, 0.005].map((st) => ({
  stepMm: st,
  firstBridgeMm: sweep(base, { stepMm: st }).find((r) => r.contacts.some((c) => c.connectedNets.length > 1))?.depthMm ?? null,
}))
console.log(`    走査だと: ${byScan.map((x) => `${x.stepMm}mm 刻み→${x.firstBridgeMm}`).join(' / ')}`)

// ---------------------------------------------------------------------------
// 2) Tip 橋絡のしきい値
// ---------------------------------------------------------------------------

const tipThreshold = bisect(0, 2 * STEP_HEIGHT, (c) =>
  anyTipBridge(buildModelWithOverrides(V3, { 'model.contact.complianceMm': c })),
)
console.log(`\n  Tip 橋絡が始まる compliance = ${tipThreshold.toFixed(6)} (段差 ${STEP_HEIGHT.toFixed(3)} の直上)`)

const tipByMinOverlap = [0.001, 0.005, 0.01, 0.02, 0.05].map((mo) => ({
  minOverlap: mo,
  threshold: +bisect(0, 2 * STEP_HEIGHT, (c) =>
    anyTipBridge(buildModelWithOverrides(V3, { 'model.contact.complianceMm': c, 'model.conduction.minOverlap': mo })),
  ).toFixed(6),
}))
console.log(`  minOverlap 依存: ${tipByMinOverlap.map((x) => `${x.minOverlap}→${x.threshold}`).join(' / ')}`)

// ---------------------------------------------------------------------------
// 3) 段差未満の compliance を「内側」で埋める (初版は 0 の 1 点だけで退化していた)
// ---------------------------------------------------------------------------

const INSIDE = [0.001, 0.01, 0.03, 0.05, 0.08, 0.11, 0.14, 0.1499]
let insideTried = 0
let insideTip = 0
const insideViolations: Record<string, number>[] = []
for (const comp of INSIDE)
  for (const ta of [9.5, 11.4, 13.2])
    for (const ra of [6.0, 7.1, 8.2])
      for (const sa of [0.5, 3.2, 4.5])
        for (const pw of [0.1, 0.55, 1.5, 2.5]) {
          const cfg = {
            'model.contact.complianceMm': comp,
            'jack.contact.tip.axialCenter': ta,
            'jack.contact.ring.axialCenter': ra,
            'jack.contact.sleeve.axialCenter': sa,
            'jack.contact.sleeve.padWidth': pw,
          }
          insideTried++
          try {
            if (anyTipBridge(buildModelWithOverrides(V3, cfg), 0.01)) {
              insideTip++
              if (insideViolations.length < 5) insideViolations.push(cfg)
            }
          } catch {
            /* 組めない構成は数えない */
          }
        }
console.log(`\n  段差未満の内側 ${insideTried} 通り (compliance 0.001〜0.1499): Tip 橋絡 ${insideTip} 件`)

// ---------------------------------------------------------------------------
// 4) 図面公差の内側で FACT を振る (初版がやっていなかった方向)
// ---------------------------------------------------------------------------

const tolExcursion = [1.725, 1.7375, 1.75, 1.7625, 1.775].map((r) => ({
  bodyRadius: r,
  diameter: +(2 * r).toFixed(3),
  tipThreshold: +bisect(0, 2 * STEP_HEIGHT, (c) =>
    anyTipBridge(buildModelWithOverrides(V3, { 'plug.bodyRadius': r, 'model.contact.complianceMm': c })),
  ).toFixed(6),
}))
console.log('\n  プラグ外径を図面公差 φ3.5±0.05 の内側で振ると Tip 橋絡のしきい値:')
for (const t of tolExcursion)
  console.log(`    φ${t.diameter} → ${t.tipThreshold}${t.tipThreshold < 0.15 ? '  ← 段差 0.15 を割る' : ''}`)

// ---------------------------------------------------------------------------
// 5) 帰線接点の 2 パラメータを「同時に」振る (初版は片振りの合併を幅としていた)
// ---------------------------------------------------------------------------

const sjFirst: number[] = []
let sjConfigs = 0
for (let i = 0; i <= 30; i++) {
  const a = +(0.45 + (4.55 - 0.45) * (i / 30)).toFixed(4)
  for (let j = 0; j <= 30; j++) {
    const w = +(0.01 + (5.0 - 0.01) * (j / 30)).toFixed(4)
    let m: TrsModel
    try {
      m = buildModelWithOverrides(V3, { 'jack.contact.sleeve.axialCenter': a, 'jack.contact.sleeve.padWidth': w })
    } catch {
      continue
    }
    if (!fullOk(m)) continue
    sjConfigs++
    const f = firstBridgeDepth(m, 'JC_SLEEVE', 0.005)
    if (f !== null) sjFirst.push(f)
  }
}
console.log(
  `\n  帰線接点 2 パラメータ同時振り (完全挿入OK ${sjConfigs} 構成 / 橋絡 ${sjFirst.length}): ` +
    `橋絡開始 ${Math.min(...sjFirst).toFixed(3)}〜${Math.max(...sjFirst).toFixed(3)} mm`,
)

const oatFirst: number[] = []
for (const a of Array.from({ length: 41 }, (_, i) => +(0.45 + (4.55 - 0.45) * (i / 40)).toFixed(4))) {
  const m = buildModelWithOverrides(V3, { 'jack.contact.sleeve.axialCenter': a })
  if (!fullOk(m)) continue
  const f = firstBridgeDepth(m, 'JC_SLEEVE', 0.005)
  if (f !== null) oatFirst.push(f)
}
for (const w of Array.from({ length: 41 }, (_, i) => +(0.01 + (5.0 - 0.01) * (i / 40)).toFixed(4))) {
  const m = buildModelWithOverrides(V3, { 'jack.contact.sleeve.padWidth': w })
  if (!fullOk(m)) continue
  const f = firstBridgeDepth(m, 'JC_SLEEVE', 0.005)
  if (f !== null) oatFirst.push(f)
}
console.log(
  `  片方ずつ振ると (OAT): ${Math.min(...oatFirst).toFixed(3)}〜${Math.max(...oatFirst).toFixed(3)} mm ← 初版はこれを「幅」としていた`,
)

// ---------------------------------------------------------------------------
// 6) 振っていなかったパラメータ
// ---------------------------------------------------------------------------

const minOverlapEffect = [0.0001, 0.01, 0.05, 0.09, 0.1, 0.12].map((mo) => {
  const mm = buildModelWithOverrides(V3, { 'model.conduction.minOverlap': mo })
  const f = firstBridgeDepth(mm, 'JC_SLEEVE')
  const e = f === null ? null : bridgeEndDepth(mm, 'JC_SLEEVE', f)
  return { minOverlap: mo, first: f === null ? null : +f.toFixed(4), width: f === null ? 0 : +(e! - f).toFixed(4) }
})
console.log('\n  minOverlap を振ると Ring↔Sleeve 橋絡の窓:')
for (const x of minOverlapEffect)
  console.log(`    ${x.minOverlap} → ${x.first === null ? '橋絡しない' : `${x.first} (幅 ${x.width})`}`)

const breakEffect = [0.01, 0.03, 0.05, 0.1, 0.2, 0.35, 0.4].map((v) => {
  const m = buildModelWithOverrides(V3, { 'jack.break.ring.openDeflection': v })
  const d = firstBreakOpen(m, 'JC_RING')
  return { openDeflection: v, depth: d === null ? null : +d.toFixed(4) }
})
console.log('\n  Ring ブレーク接点のしきい値を振ると開く深さ:')
for (const x of breakEffect) console.log(`    ${x.openDeflection} → ${x.depth === null ? '開かない' : x.depth}`)

// ---------------------------------------------------------------------------
// 7) 4極: パッド幅のしきい値 (二分法 + 深さ clamp)
// ---------------------------------------------------------------------------

const m4 = getModel(V4)
const GAPS4 = plateauGaps(m4)
const GAP3 = plateauGaps(base)
console.log(`\n  プラトー間隔: 3極 ${GAP3.join(', ')} / 4極 ${GAPS4.join(', ')}`)

function padThreshold(axialKey: string, padKey: string, contactId: string, insC: number, axial: number) {
  const ideal = insC + axial
  const depth = Math.min(ideal, m4.fullDepthMm)
  return {
    axial,
    threshold: +bisect(0.01, 6.0, (w) => {
      try {
        return bridgingAt(buildModelWithOverrides(V4, { [axialKey]: axial, [padKey]: w }), contactId, depth) !== null
      } catch {
        return false
      }
    }).toFixed(6),
    evaluatedDepthMm: +depth.toFixed(3),
    idealDepthReachable: ideal <= m4.fullDepthMm,
  }
}

const padThresholds = {
  JC_RING2: [3.45, 4.0, 4.35, 5.25, 5.85, 6.0, 6.5].map((a) =>
    padThreshold('trrs.jack.contact.ring2.axialCenter', 'trrs.jack.contact.narrowPadWidth', 'JC_RING2', (7.8 + 8.5) / 2, a),
  ),
  JC_SLEEVE: [0.45, 1.25, 2.05, 2.85, 3.5].map((a) =>
    padThreshold('trrs.jack.contact.sleeve.axialCenter', 'jack.contact.sleeve.padWidth', 'JC_SLEEVE', (10.8 + 11.5) / 2, a),
  ),
}
for (const [cid, rows] of Object.entries(padThresholds)) {
  console.log(`  ${cid}:`)
  for (const r of rows)
    console.log(
      `    位置 ${r.axial} → ${r.threshold}${r.idealDepthReachable ? '' : '  ← 理想深さが完全挿入を超える (clamp)'}`,
    )
}

// ---------------------------------------------------------------------------
// 10) 公差の「箱」の隅で Tip 橋絡のしきい値を測る
//
// §6-1 で bodyRadius だけを振ったが、段差はもう一方の端 insulatorRadius にも依る。
// そちらは DERIVED で、注記自身が図面実測 φ3.20〜3.22 という幅を認めている。
// 2 つを同時に振って、いちばん薄くなる隅を出す。
// ---------------------------------------------------------------------------

const BODY_R = [1.725, 1.7375, 1.75, 1.7625, 1.775] // 図面公差 φ3.5±0.05
const INS_R = [1.6, 1.605, 1.61] // 図面実測 φ3.20〜3.22
const toleranceBox = BODY_R.flatMap((b) =>
  INS_R.map((i) => ({
    bodyDiameter: +(2 * b).toFixed(3),
    insulatorDiameter: +(2 * i).toFixed(3),
    stepHeight: +(b - i).toFixed(6),
    tipThreshold: +bisect(0, 2 * STEP_HEIGHT, (c) =>
      anyTipBridge(
        buildModelWithOverrides(V3, {
          'plug.bodyRadius': b,
          'plug.insulatorRadius': i,
          'model.contact.complianceMm': c,
        }),
      ),
    ).toFixed(6),
  })),
)
const worstCorner = toleranceBox.reduce((a, b) => (b.tipThreshold < a.tipThreshold ? b : a))
console.log('\n  公差の箱の隅で Tip 橋絡のしきい値:')
console.log(
  `    最悪 φ${worstCorner.bodyDiameter} × 絶縁 φ${worstCorner.insulatorDiameter} → ${worstCorner.tipThreshold}` +
    ` (採用 0.05 の ${(worstCorner.tipThreshold / 0.05).toFixed(2)} 倍 / 採用範囲上端 0.10 の ${(worstCorner.tipThreshold / 0.1).toFixed(2)} 倍)`,
)

// ---------------------------------------------------------------------------
// 11) 力のモデル (force.* 9 件)
//
// 初版は「対象外。calibrationScale 1 個で 3.6〜7.3 N に動く」とだけ書いていた。
// 校正係数は純粋な倍率なので、それを振っても「倍率を振れば倍率の分動く」以上の
// ことが言えない。校正係数を固定したまま、物理的な意味のある 8 件を振る。
// ---------------------------------------------------------------------------

function peakForce(ov: Record<string, number>, stepMm = 0.02) {
  const mm = buildModelWithOverrides(V3, ov)
  const curve = computeForceCurve(mm.jack, mm.plug, F, mm.contactCfg, mm.forceCfg, stepMm, -2)
  let insertion = 0
  let withdrawal = 0
  let atMm = 0
  for (const p of curve) {
    if (p.insertionN > insertion) {
      insertion = p.insertionN
      atMm = p.depthMm
    }
    if (p.withdrawalN > withdrawal) withdrawal = p.withdrawalN
  }
  return { insertion, withdrawal, atMm }
}

/** 各パラメータの「物理的に成立しうる」幅。根拠は ASSUMPTIONS D / UNKNOWNS §3-7 */
const FORCE_RANGES: Record<string, [number, number]> = {
  'force.frictionInsert': [0.2, 0.6],
  'force.frictionWithdraw': [0.2, 0.6],
  'force.entryFrictionPerMm': [0.0, 0.2],
  'force.entryFrictionMax': [0.5, 2.5],
  'force.detentPeak': [0.0, 3.0],
  'force.detentSigma': [0.2, 1.5],
  'force.differentiationStep': [0.001, 0.02],
  'force.maxRampSlope': [0.285, 0.775], // ドーム半径 1.0〜0.2mm に対応
}

const forceBaseline = peakForce({})
const forceOat = Object.entries(FORCE_RANGES).map(([key, [lo, hi]]) => ({
  key,
  lo,
  hi,
  peakAtLo: +peakForce({ [key]: lo }).insertion.toFixed(3),
  peakAtHi: +peakForce({ [key]: hi }).insertion.toFixed(3),
}))

const forceKeys = Object.keys(FORCE_RANGES)
let fLo = Infinity
let fHi = -Infinity
let belowSpec = 0
let aboveSpec = 0
let detentDominated = 0
for (let mask = 0; mask < 1 << forceKeys.length; mask++) {
  const ov: Record<string, number> = {}
  forceKeys.forEach((k, i) => {
    ov[k] = FORCE_RANGES[k][(mask >> i) & 1]
  })
  const p = peakForce(ov)
  if (p.insertion < fLo) fLo = p.insertion
  if (p.insertion > fHi) fHi = p.insertion
  if (p.insertion < 3) belowSpec++
  if (p.insertion > 20) aboveSpec++
  if (Math.abs(p.atMm - base.fullDepthMm) < 0.5) detentDominated++
}
const calibrationLinear = [1.0, 1.45, 2.0].map((s) => ({
  scale: s,
  peakN: +peakForce({ 'force.calibrationScale': s }).insertion.toFixed(3),
}))
console.log('\n  力のモデル (校正係数を固定して物理 8 件を同時に振る):')
console.log(`    既定 ${forceBaseline.insertion.toFixed(2)} N (深さ ${forceBaseline.atMm.toFixed(2)} mm)`)
console.log(`    256 通り → ${fLo.toFixed(2)} 〜 ${fHi.toFixed(2)} N`)
console.log(`    3 N 未満 ${belowSpec} / 20 N 超 ${aboveSpec} / ピークがデテント支配 ${detentDominated}`)
console.log(`    校正係数は純粋な倍率: ${calibrationLinear.map((x) => `${x.scale}→${x.peakN}`).join(' / ')}`)

// ---------------------------------------------------------------------------

const out = {
  schemaVersion: 3,
  generatedBy: 'npm run sensitivity',
  note:
    'しきい値は走査ではなく二分法で求めている (走査刻みが答えを変えるため)。乱数は使っていないので何度実行しても同じ結果になる。' +
    '初版 (schemaVersion 1) には手法上の欠陥が 4 つあり作り直した。scripts/sensitivity.ts の冒頭を参照。',
  stepHeightMm: +STEP_HEIGHT.toFixed(6),
  baseline: {
    firstBridgeMm: +baselineFirst.toFixed(4),
    bridgeEndMm: +baselineEnd.toFixed(4),
    widthMm: +(baselineEnd - baselineFirst).toFixed(4),
    byScanStep: byScan,
  },
  tipBridge: {
    complianceThreshold: +tipThreshold.toFixed(6),
    byMinOverlap: tipByMinOverlap,
    insideStepHeight: { tried: insideTried, tipBridgeCount: insideTip, violations: insideViolations },
    factToleranceExcursion: tolExcursion,
    toleranceBox: {
      note: 'bodyRadius (FACT 公差 φ3.5±0.05) と insulatorRadius (DERIVED 図面実測 φ3.20〜3.22) を同時に振る',
      grid: toleranceBox,
      worstCorner,
      marginVsAdopted: +(worstCorner.tipThreshold / 0.05).toFixed(3),
      marginVsAdoptedRangeTop: +(worstCorner.tipThreshold / 0.1).toFixed(3),
    },
  },
  bridgeDepthRange: {
    joint: { configs: sjConfigs, minMm: +Math.min(...sjFirst).toFixed(4), maxMm: +Math.max(...sjFirst).toFixed(4) },
    oneAtATime: { minMm: +Math.min(...oatFirst).toFixed(4), maxMm: +Math.max(...oatFirst).toFixed(4) },
  },
  previouslyUnswept: { minOverlap: minOverlapEffect, ringBreakOpenDeflection: breakEffect },
  plateauGaps: { threePole: GAP3, fourPole: GAPS4 },
  padThresholds,
  forceModel: {
    note:
      'calibrationScale は純粋な倍率で独立した根拠を持たないため、同時振りからは外して固定した。' +
      '振ったのは物理的な意味のある 8 件。',
    baseline: {
      peakInsertionN: +forceBaseline.insertion.toFixed(3),
      peakWithdrawalN: +forceBaseline.withdrawal.toFixed(3),
      peakAtMm: +forceBaseline.atMm.toFixed(3),
    },
    ranges: FORCE_RANGES,
    oneAtATime: forceOat,
    joint: {
      configs: 1 << forceKeys.length,
      minN: +fLo.toFixed(3),
      maxN: +fHi.toFixed(3),
      belowSpec3N: belowSpec,
      aboveSpec20N: aboveSpec,
      detentDominated,
    },
    calibrationScaleIsPureMultiplier: calibrationLinear,
  },
}

const OUT = resolve(process.cwd(), 'artifacts')
mkdirSync(OUT, { recursive: true })
writeFileSync(resolve(OUT, 'sensitivity.json'), JSON.stringify(out, null, 1) + '\n')
console.log('\n  artifacts/sensitivity.json を書き出した')
