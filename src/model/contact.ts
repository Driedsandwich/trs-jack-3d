/**
 * 決定論的な接触判定エンジン。仕様 §6 / §7 / §19。
 *
 * 設計上の約束:
 *  - 3D メッシュ名・画面座標・物理エンジンの衝突イベントを一切参照しない。
 *  - 入力 (深度・故障パラメータ・モデル) が同じなら出力は必ず同じ。
 *  - 乱数は「深度と接点 ID とシードのハッシュ」からのみ生成する (時刻を使わない)。
 *
 * 座標系 (仕様 §5):
 *  - d = 挿入深度 [mm]。プラグ先端がジャック前面基準面より内側に入った距離。
 *    d < 0  : 未挿入 (プラグ先端は前面より外)
 *    d = 0  : プラグ先端がジャック前面基準面に到達
 *    d = xFull : 停止面に当たる完全挿入
 *  - xj = ジャック前面から奥への距離 [mm] (接点の軸位置)
 *  - s  = プラグ先端から肩に向かう距離 [mm] (セグメント境界)
 *  - 対応関係: s = d - xj
 */

import type {
  ContactResult,
  ContactState,
  FaultParams,
  Grade,
  PlugNet,
  SegmentOverlap,
} from './types'
import {
  Dimensions,
  intersectIntervals,
  intervalsWidth,
  plugRadiusAt,
  radiusAtLeastIntervals,
  weakerGrade,
  weakestGrade,
  type Interval,
  type ResolvedJack,
  type ResolvedJackContact,
  type ResolvedPlug,
} from './resolve'

// ---------------------------------------------------------------------------
// 判定パラメータ (全て contactModel.json 由来。ハードコードしない)
// ---------------------------------------------------------------------------

export interface ContactModelConfig {
  /** 品質スコアの重み: 有効接触幅の寄与 */
  qualityWeightOverlap: number
  /** 品質スコアの重み: 押付量の寄与 */
  qualityWeightForce: number
  /** これ以上で CLOSED、未満で TOUCH_UNSTABLE */
  closedQualityThreshold: number
  /** これ未満の重なり幅は導通とみなさない [mm] */
  minConductionOverlapMm: number
  /** 摩耗 1.0 のとき接触パッド自由半径がどれだけ広がるか [mm] */
  wearRadiusGainMm: number
  /** 摩耗 1.0 のときの品質低下率 0-1 */
  wearQualityLoss: number
  /** 汚れの円周方向の広がり (半値半幅) [deg] */
  contaminationSpanDeg: number
  /** 汚れパッチのプラグ側方位角 [deg] */
  contaminationAzimuthDeg: number
  /** 断続接触のノイズ量子化幅 [mm] */
  intermittentStepMm: number
  /** 軸ずれ・傾きが起きる円周方向 [deg]。0deg = +Y */
  misalignDirectionDeg: number
  /**
   * 接触ドームが、押し出された位置よりどれだけ低い面まで追従できるか [mm]。
   *
   * 接点はパッド範囲内で一番高い面に乗って押し開かれる。その状態では、
   * それより低い面には本来届かない。ただし実物のドームは点ではなく有限の
   * 曲率を持ち、梁もねじれるので、わずかに低い面へは追従しうる。その許容量。
   *
   * 0 にすると完全剛体になり、完全挿入時に Tip 接点が導通しなくなる。
   * 傾いた面 (Tip 後端の逆テーパ) の上では導通帯の幅が compliance/傾き に
   * なり、これが minConductionOverlapMm を割るため。
   * 逆に 0.15mm (Tip と Ring の半径差) を超えると、その段差を無視した
   * 誤った同時接触が復活する。実測した破綻点は 0.0008 と 0.1538。
   */
  contactComplianceMm: number
}

export const DEFAULT_FAULTS: FaultParams = {
  contamination: 0,
  wear: 0,
  lateralOffsetMm: 0,
  tiltDeg: 0,
  springForceScale: 1,
  intermittent: false,
  seed: 1,
  intermittentAmplitude: 0.6,
  rotationDeg: 0,
}

export function loadContactConfig(dims: Dimensions): ContactModelConfig {
  return {
    qualityWeightOverlap: dims.num('model.quality.weightOverlap'),
    qualityWeightForce: dims.num('model.quality.weightForce'),
    closedQualityThreshold: dims.num('model.quality.closedThreshold'),
    minConductionOverlapMm: dims.num('model.conduction.minOverlap'),
    wearRadiusGainMm: dims.num('model.wear.radiusGain'),
    wearQualityLoss: dims.num('model.wear.qualityLoss'),
    contaminationSpanDeg: dims.num('model.contamination.spanDeg'),
    contaminationAzimuthDeg: dims.num('model.contamination.azimuthDeg'),
    intermittentStepMm: dims.num('model.intermittent.stepMm'),
    misalignDirectionDeg: dims.num('model.misalign.directionDeg'),
    contactComplianceMm: dims.num('model.contact.complianceMm'),
  }
}

// ---------------------------------------------------------------------------
// 決定論的ノイズ
// ---------------------------------------------------------------------------

/** 文字列 + 整数 から 32bit ハッシュ。時刻に依存しない。 */
function hash32(str: string, a: number, b: number): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  h ^= a | 0
  h = Math.imul(h, 16777619) >>> 0
  h ^= b | 0
  h = Math.imul(h, 16777619) >>> 0
  h ^= h >>> 15
  h = Math.imul(h, 2246822507) >>> 0
  h ^= h >>> 13
  return h >>> 0
}

/** 0..1 の決定論的ノイズ。同じ (接点, シード, 量子化深度) なら必ず同じ値。 */
export function deterministicNoise(contactId: string, seed: number, depthMm: number, stepMm: number): number {
  const q = Math.round(depthMm / Math.max(stepMm, 1e-6))
  return hash32(contactId, seed, q) / 0xffffffff
}

// ---------------------------------------------------------------------------
// 個々の接点の評価
// ---------------------------------------------------------------------------

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
const deg2rad = (d: number) => (d * Math.PI) / 180

/**
 * 接点 1 本の評価。
 *
 * 幾何:
 *   接触パッドは軸方向に padWidth の幅を持つ。パッドの軸方向範囲を
 *   プラグ座標に写し、「半径方向に届いている区間」と交差させ、
 *   その区間が導体セグメント / 絶縁セグメントとどれだけ重なるかを厳密に求める。
 */
export function evaluateContact(
  contact: ResolvedJackContact,
  plug: ResolvedPlug,
  depthMm: number,
  faults: FaultParams,
  cfg: ContactModelConfig,
): ContactResult {
  const expectedSeg = plug.segments.find((s) => s.id === contact.expectedSegment)
  const expectedNet = expectedSeg?.net
  // 極数の違うプラグでは、この接点が本来触れるべき導体そのものが存在しないことがある
  const expectedSegmentMissing = !expectedSeg

  // --- 1. 位置ずれを織り込んだ実効自由半径 -------------------------------
  // 摩耗すると接触ドームが減り、自由半径が広がる (= 押付が落ちる)
  const wornFreeRadius = contact.freeRadiusMm + cfg.wearRadiusGainMm * faults.wear

  // 傾き + 横ずれ。ジャック前面 (xj=0) を支点とした 1 次近似。
  const lateralAtContact =
    faults.lateralOffsetMm + contact.axialCenterMm * Math.tan(deg2rad(faults.tiltDeg))
  const angleDelta = deg2rad(contact.angularPositionDeg - cfg.misalignDirectionDeg)
  const effFreeRadius = wornFreeRadius - lateralAtContact * Math.cos(angleDelta)

  // --- 2. パッドの軸方向範囲をプラグ座標に写す ---------------------------
  const sCenter = depthMm - contact.axialCenterMm
  const padLo = sCenter - contact.padWidthMm / 2
  const padHi = sCenter + contact.padWidthMm / 2
  const padWindow: Interval[] = [{ lo: padLo, hi: padHi }]

  // プラグ指部の存在範囲
  const fingerWindow: Interval[] = [{ lo: 0, hi: plug.fingerLengthMm }]

  /** しきい値 r 以上の面と、パッド窓・指部との共通区間 */
  const touchingAt = (r: number): Interval[] =>
    intersectIntervals(
      intersectIntervals(padWindow, fingerWindow),
      r <= 0 ? fingerWindow : radiusAtLeastIntervals(plug.profile, r),
    )

  /** 区間内のプラグ最大半径 (区分線形なので端点と内部ブレークポイントだけ見れば足りる) */
  const maxRadiusIn = (ivs: Interval[]): number => {
    let m = 0
    for (const iv of ivs) {
      const candidates = [iv.lo, iv.hi, ...plug.profile.map((p) => p.s).filter((s) => s > iv.lo && s < iv.hi)]
      for (const s of candidates) m = Math.max(m, plugRadiusAt(plug.profile, s))
    }
    return m
  }

  // パッドがプラグに噛み合っている区間 (= プラグ外半径 >= 実効自由半径)。
  // たわみ量・押付力・品質スコア・画面表示はこちらを使う。
  const engaged = touchingAt(effFreeRadius)
  const maxPlugRadius = intervalsWidth(engaged) > 0 ? maxRadiusIn(engaged) : 0

  // --- 3. たわみ後の位置で「どの導体に導通するか」を判定し直す -----------
  //
  // 接点はパッド範囲内で一番高い面に乗って maxPlugRadius まで押し開かれる。
  // その状態では、それより低い面には本来届かない。噛み合い区間をそのまま
  // 導通判定に使うと、半径の段差をまたいだ「ありえない同時接触」ができてしまう
  // (プラグの Tip 導体は Ring/Sleeve より 0.15mm 細いため、ここが効く)。
  //
  // ドームの追従量 contactComplianceMm だけは低い面も拾う。
  // しきい値が自由半径を下回ることはない (それ以下は元々噛み合っていない)。
  //
  // 1 回で足りる: 新しい区間は元の区間の部分集合で、かつ最高点を必ず含むので、
  // その中の最大半径は maxPlugRadius のまま変わらない。だから 2 回目は同じ結果になる。
  const touching =
    maxPlugRadius > 0
      ? touchingAt(Math.max(effFreeRadius, maxPlugRadius - cfg.contactComplianceMm))
      : engaged

  const physicallyTouching = intervalsWidth(engaged) > 0
  const deflection = physicallyTouching ? Math.max(0, maxPlugRadius - effFreeRadius) : 0
  const overDeflected = deflection > contact.maxDeflectionMm + 1e-9
  const normalForce = deflection * contact.springRateNPerMm * faults.springForceScale

  // --- 4. 各セグメントとの重なり ----------------------------------------
  // 導通判定は「押し開かれた位置から届く帯」で、品質と表示は「パッドの噛み合い」で見る。
  // 傾斜面の上ではこの 2 つは一致しない。混ぜると品質スコアが compliance の値に
  // 引きずられてしまうので、分けて持つ。
  const overlaps: SegmentOverlap[] = []
  for (const seg of plug.segments) {
    const segWindow: Interval[] = [{ lo: seg.startMm, hi: seg.endMm }]
    const w = intervalsWidth(intersectIntervals(touching, segWindow))
    if (w > 1e-9) {
      overlaps.push({
        segmentId: seg.id,
        segmentLabel: seg.label,
        kind: seg.kind,
        net: seg.net,
        widthMm: w,
        engagedWidthMm: intervalsWidth(intersectIntervals(engaged, segWindow)),
        fraction: clamp01(intervalsWidth(intersectIntervals(engaged, segWindow)) / contact.padWidthMm),
      })
    }
  }
  overlaps.sort((a, b) => b.widthMm - a.widthMm)

  const conductorOverlaps = overlaps.filter(
    (o) => o.kind === 'conductor' && o.widthMm >= cfg.minConductionOverlapMm,
  )
  const insulatorOverlaps = overlaps.filter((o) => o.kind === 'insulator')

  // --- 5. 汚れ (回転角依存) ---------------------------------------------
  // 理想的な同心接点では軸回転で接続は変わらない。汚れパッチがある場合のみ、
  // パッチの方位と接点の方位の関係で効き方が変わる。仕様 §5。
  let contaminationApplied = 0
  if (faults.contamination > 0) {
    const patchAzimuth = cfg.contaminationAzimuthDeg + faults.rotationDeg
    let delta = ((contact.angularPositionDeg - patchAzimuth) % 360 + 540) % 360 - 180
    delta = Math.abs(delta)
    const span = Math.max(cfg.contaminationSpanDeg, 1e-6)
    // 半値半幅 span の raised-cosine 窓。span を超えると 0。
    const window = delta >= span ? 0 : 0.5 * (1 + Math.cos((Math.PI * delta) / span))
    contaminationApplied = faults.contamination * window
  }

  // --- 6. 品質スコア (仕様 §7) ------------------------------------------
  const bestConductor = conductorOverlaps[0]
  // 品質は「パッドがどれだけ噛み合っているか」で見る。導通判定用の帯幅を使うと、
  // 一次資料の無い contactComplianceMm が品質スコアと CLOSED/TOUCH_UNSTABLE の
  // 境界まで決めてしまう。
  const fOverlap = bestConductor ? clamp01(bestConductor.engagedWidthMm / contact.padWidthMm) : 0
  // 押付の寄与は「実際の押付力 / 公称押付力」で見る。ばねがへたれば (springForceScale が
  // 小さければ) たわみが同じでも接触は悪くなるので、ここに倍率を掛ける必要がある。
  const fForce = clamp01(
    (deflection * faults.springForceScale) / Math.max(contact.nominalDeflectionMm, 1e-9),
  )
  let quality =
    cfg.qualityWeightOverlap * fOverlap + cfg.qualityWeightForce * fForce
  quality *= 1 - contaminationApplied
  quality *= 1 - cfg.wearQualityLoss * faults.wear
  if (faults.intermittent) {
    const n = deterministicNoise(contact.id, faults.seed, depthMm, cfg.intermittentStepMm)
    quality *= 1 - faults.intermittentAmplitude * n
  }
  if (deflection <= 0 || !bestConductor) quality = 0
  quality = clamp01(quality)

  // --- 7. 状態判定 -------------------------------------------------------
  const connectedNets: PlugNet[] = []
  if (quality > 0) {
    for (const o of conductorOverlaps) {
      if (o.net && !connectedNets.includes(o.net)) connectedNets.push(o.net)
    }
  }

  let state: ContactState
  let reason: string
  if (!physicallyTouching) {
    state = 'OPEN'
    reason =
      sCenter < 0
        ? 'プラグ先端がまだこの接点まで届いていない'
        : 'プラグ表面に届いていない (半径不足または通過済み)'
  } else if (conductorOverlaps.length === 0) {
    state = 'INSULATED'
    const on = insulatorOverlaps[0]?.segmentLabel ?? '絶縁部'
    reason = `接点が${on}の上に乗っており、回路は開いている`
  } else if (quality <= 0) {
    state = 'OPEN'
    reason =
      contaminationApplied >= 1
        ? '導体には接しているが、絶縁性の汚れ膜で導通していない'
        : '接触しているが押付が無く導通していない'
  } else if (connectedNets.length >= 2) {
    state = 'BRIDGED'
    reason = `1 本の接点が ${connectedNets.join(' と ')} をまたいで短絡させている`
  } else if (expectedSegmentMissing) {
    state = 'WRONG_SEGMENT'
    reason =
      `このプラグには ${contact.expectedSegment} 導体が存在しない。` +
      `代わりに ${connectedNets[0]} に触れている`
  } else if (expectedNet && connectedNets[0] !== expectedNet) {
    state = 'WRONG_SEGMENT'
    reason = `本来 ${expectedNet} に触れるべき接点が ${connectedNets[0]} に触れている`
  } else if (quality < cfg.closedQualityThreshold) {
    state = 'TOUCH_UNSTABLE'
    reason =
      fOverlap < 0.5
        ? `接触幅が狭い (パッドの ${(fOverlap * 100).toFixed(0)}% のみ導体上)`
        : `押付が不足している (公称の ${(fForce * 100).toFixed(0)}%)`
  } else {
    state = 'CLOSED'
    reason = '正常接触'
  }
  if (overDeflected) {
    reason += ' / 許容たわみ超過'
  }

  // --- 8. ブレーク接点 ---------------------------------------------------
  let breakState: ContactResult['breakState'] = null
  let breakContactId: string | null = null
  if (contact.breakContact) {
    breakContactId = contact.breakContact.id
    const opened = deflection >= contact.breakContact.openDeflectionMm
    if (contact.breakContact.normalState === 'closed') {
      breakState = opened ? 'BREAK_OPEN' : 'BREAK_CLOSED'
    } else {
      breakState = opened ? 'BREAK_CLOSED' : 'BREAK_OPEN'
    }
  }

  // --- 9. 根拠区分の伝播 --------------------------------------------------
  const grade: Grade = weakestGrade([
    contact.grade,
    ...overlaps
      .map((o) => plug.segments.find((s) => s.id === o.segmentId)?.grade)
      .filter((g): g is Grade => !!g),
  ])

  return {
    contactId: contact.id,
    label: contact.label,
    terminalId: contact.terminalId,
    expectedSegment: contact.expectedSegment,
    state,
    physicallyTouching,
    deflectionMm: deflection,
    normalForceN: normalForce,
    overlaps,
    connectedNets,
    quality,
    breakState,
    breakContactId,
    overDeflected,
    contaminationApplied,
    padCenterSMm: sCenter,
    grade: weakerGrade(grade, faults.contamination > 0 || faults.wear > 0 ? 'ASSUMPTION' : grade),
    reason,
  }
}

/** 全接点をまとめて評価する。 */
export function evaluateAllContacts(
  jack: ResolvedJack,
  plug: ResolvedPlug,
  depthMm: number,
  faults: FaultParams,
  cfg: ContactModelConfig,
): ContactResult[] {
  return jack.contacts.map((c) => evaluateContact(c, plug, depthMm, faults, cfg))
}
