/**
 * 挿抜力の近似モデル。仕様 §8。
 *
 * 重要: 有限要素解析はしていない。実物と同一のばね力を再現したとは主張しない。
 * ここで出す値は「推定挿抜力」であり、実測値ではない。
 *
 * 手法 (エネルギー法):
 *   接点ばね 1 本が半径方向に δ たわみ、押付力 N = k·δ を出しているとき、
 *   プラグを軸方向に dd 進めるのに必要な仕事は
 *       F·dd = μ·N·dd  (摩擦)  +  dU  (ばねに蓄えるエネルギーの増分)
 *   U = ½k·δ² より dU/dd = k·δ·(dδ/dd) = N·(dδ/dd) なので
 *       F = N·(μ + dδ/dd)
 *   dδ/dd はプラグ外形の傾きそのもの。テーパを登るときに局所ピークが出る。
 *   抜去時は運動方向が逆なので F = N·(μ_w − dδ/dd) となり、
 *   摩擦の符号が変わらない分ヒステリシスが生じる。
 */

import { evaluateContact, type ContactModelConfig } from './contact'
import type { Dimensions, ResolvedJack, ResolvedPlug } from './resolve'
import type { FaultParams } from './types'

export interface ForceModelConfig {
  /** 挿入時の摩擦係数 (ニッケルめっき CuZn / 銀めっき銅合金) */
  frictionInsert: number
  /** 抜去時の摩擦係数 */
  frictionWithdraw: number
  /** 入口ブッシング/絶縁ボアの摩擦 [N/mm of engaged length] */
  entryFrictionPerMm: number
  /** 入口摩擦の上限 [N] */
  entryFrictionMax: number
  /** 完全挿入付近の保持 (デテント) のピーク [N] */
  detentPeak: number
  /** デテントの軸方向の広がり (標準偏差) [mm] */
  detentSigma: number
  /** 全体スケール。公称 3〜20N レンジに合わせるための校正係数 */
  calibrationScale: number
  /** 数値微分の刻み [mm] */
  differentiationStep: number
  /**
   * ランプ項 dδ/dd の絶対値の上限。
   *
   * 導体と絶縁帯の境界は幅ゼロの垂直な段なので、そこでは たわみ δ が不連続に
   * なり dδ/dd が発散する。上限を置かないと、微分の刻みを変えるだけで
   * ピーク挿入力が 17N にも 28N にもなってしまい、物理量にならない。
   *
   * 実物の接触ドームは点ではなく有限の曲率を持つので、段を一定の距離をかけて
   * 登る。その分だけ傾きが頭打ちになる。値の根拠は dimensions.json を参照。
   */
  maxRampSlope: number
}

export function loadForceConfig(dims: Dimensions): ForceModelConfig {
  return {
    frictionInsert: dims.num('force.frictionInsert'),
    frictionWithdraw: dims.num('force.frictionWithdraw'),
    entryFrictionPerMm: dims.num('force.entryFrictionPerMm'),
    entryFrictionMax: dims.num('force.entryFrictionMax'),
    detentPeak: dims.num('force.detentPeak'),
    detentSigma: dims.num('force.detentSigma'),
    calibrationScale: dims.num('force.calibrationScale'),
    differentiationStep: dims.num('force.differentiationStep'),
    maxRampSlope: dims.num('force.maxRampSlope'),
  }
}

export interface ForceBreakdown {
  depthMm: number
  /** 挿入方向に押すのに必要な力 [N] */
  insertionN: number
  /** 引き抜くのに必要な力 [N] */
  withdrawalN: number
  /** 内訳 */
  parts: {
    entryFrictionN: number
    detentN: number
    perContact: { contactId: string; normalForceN: number; slope: number; insertionN: number; withdrawalN: number }[]
  }
}

function deflectionAt(
  contactIdx: number,
  jack: ResolvedJack,
  plug: ResolvedPlug,
  depth: number,
  faults: FaultParams,
  cfg: ContactModelConfig,
): number {
  return evaluateContact(jack.contacts[contactIdx], plug, depth, faults, cfg).deflectionMm
}

export function computeForce(
  jack: ResolvedJack,
  plug: ResolvedPlug,
  depthMm: number,
  faults: FaultParams,
  cfg: ContactModelConfig,
  fcfg: ForceModelConfig,
): ForceBreakdown {
  const h = fcfg.differentiationStep
  const perContact: ForceBreakdown['parts']['perContact'] = []
  let insertion = 0
  let withdrawal = 0

  for (let i = 0; i < jack.contacts.length; i++) {
    const c = jack.contacts[i]
    const res = evaluateContact(c, plug, depthMm, faults, cfg)
    const N = res.normalForceN
    // dδ/dd を中心差分で求める (プロファイルの区分線形性をそのまま反映する)
    const dPlus = deflectionAt(i, jack, plug, depthMm + h, faults, cfg)
    const dMinus = deflectionAt(i, jack, plug, depthMm - h, faults, cfg)
    // 垂直な段の上では δ が不連続で、この差分は h を変えるだけで値が変わる。
    // 接触ドームが有限の大きさを持つことを、傾きの頭打ちとして表す。
    const raw = (dPlus - dMinus) / (2 * h)
    const slope = Math.min(fcfg.maxRampSlope, Math.max(-fcfg.maxRampSlope, raw))

    const fi = Math.max(0, N * (fcfg.frictionInsert + slope))
    const fw = Math.max(0, N * (fcfg.frictionWithdraw - slope))
    insertion += fi
    withdrawal += fw
    perContact.push({ contactId: c.id, normalForceN: N, slope, insertionN: fi, withdrawalN: fw })
  }

  // 入口ブッシング/ボアの摩擦。噛み合い長さに比例し、上限で頭打ち。
  const engaged = Math.max(0, Math.min(depthMm, plug.fingerLengthMm))
  const entry = Math.min(fcfg.entryFrictionMax, fcfg.entryFrictionPerMm * engaged)

  // 完全挿入位置の保持 (デテント)。プロファイルに溝が無い部品のための明示項。
  const dz = depthMm - jack.fullInsertionDepthMm
  const detent = fcfg.detentPeak * Math.exp(-(dz * dz) / (2 * fcfg.detentSigma * fcfg.detentSigma))

  const scale = fcfg.calibrationScale
  const outsideBore = depthMm <= 0
  return {
    depthMm,
    insertionN: outsideBore ? 0 : (insertion + entry + detent) * scale,
    withdrawalN: outsideBore ? 0 : (withdrawal + entry + detent) * scale,
    parts: { entryFrictionN: entry * scale, detentN: detent * scale, perContact },
  }
}

/** 力曲線を一括で計算する (force_curve.json 用) */
export function computeForceCurve(
  jack: ResolvedJack,
  plug: ResolvedPlug,
  faults: FaultParams,
  cfg: ContactModelConfig,
  fcfg: ForceModelConfig,
  stepMm = 0.05,
  startMm = -2,
): ForceBreakdown[] {
  const out: ForceBreakdown[] = []
  const n = Math.round((jack.fullInsertionDepthMm - startMm) / stepMm)
  for (let i = 0; i <= n; i++) {
    const d = startMm + i * stepMm
    out.push(computeForce(jack, plug, Math.min(d, jack.fullInsertionDepthMm), faults, cfg, fcfg))
  }
  return out
}
