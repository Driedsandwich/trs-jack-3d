/**
 * 寸法テーブル (dimensions.json) と各モデル定義 (plugSegments / jackContacts) を
 * 「数値 + 根拠区分」に解決するレイヤ。
 *
 * ここを通さずに生の数値を使う実装を書かないこと。根拠追跡が切れる。
 */

import type {
  DimensionEntry,
  DimensionTable,
  DimRef,
  Grade,
  JackContactDef,
  JackModelDef,
  JackTerminalDef,
  PlugModelDef,
  PlugNet,
  PlugSegmentDef,
  SegmentKind,
  SignalFunction,
} from './types'
import { GRADE_ORDER } from './types'

/** 2 つの根拠区分のうち「弱い方」を返す。判定結果のグレード伝播に使う。 */
export function weakerGrade(a: Grade, b: Grade): Grade {
  return GRADE_ORDER.indexOf(a) >= GRADE_ORDER.indexOf(b) ? a : b
}

export function weakestGrade(grades: Grade[]): Grade {
  return grades.reduce<Grade>((acc, g) => weakerGrade(acc, g), 'FACT')
}

export class DimensionResolutionError extends Error {}

/** 解決済みの寸法値。値と根拠がセットで動く。 */
export interface ResolvedValue {
  key: string | null
  value: number
  grade: Grade
  unit: string
  tolerance?: number
  sources: string[]
  note?: string
}

export class Dimensions {
  private readonly table: DimensionTable

  constructor(table: DimensionTable) {
    this.table = table
  }

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.table, key)
  }

  entry(key: string): DimensionEntry {
    const e = this.table[key]
    if (!e) throw new DimensionResolutionError(`未定義の寸法キー: ${key}`)
    return e
  }

  /** DimRef (キー文字列 or 直値) を解決する。直値は ASSUMPTION 扱い。 */
  resolve(ref: DimRef, contextForLiteral = 'inline literal'): ResolvedValue {
    if (typeof ref === 'number') {
      return {
        key: null,
        value: ref,
        grade: 'ASSUMPTION',
        unit: 'mm',
        sources: [],
        note: `JSON に直接書かれた値 (${contextForLiteral})`,
      }
    }
    const e = this.entry(ref)
    return {
      key: ref,
      value: e.value,
      grade: e.grade,
      unit: e.unit ?? 'mm',
      tolerance: e.tolerance,
      sources: e.sources ?? [],
      note: e.note,
    }
  }

  /** 値だけ欲しい場合 */
  num(ref: DimRef): number {
    return this.resolve(ref).value
  }

  keys(): string[] {
    return Object.keys(this.table).sort()
  }

  all(): DimensionTable {
    return this.table
  }
}

// ---------------------------------------------------------------------------
// プラグ
// ---------------------------------------------------------------------------

export interface ResolvedPlugSegment {
  id: string
  label: string
  kind: SegmentKind
  net?: PlugNet
  /** プラグ先端を 0 とした軸方向開始 [mm] */
  startMm: number
  endMm: number
  material: string
  grade: Grade
  sources: string[]
  def: PlugSegmentDef
}

export interface ResolvedPlug {
  variant: PlugModelDef['variant']
  poleCount: number
  partNumber: string
  manufacturer: string
  netFunctions: Partial<Record<PlugNet, SignalFunction>>
  netFunctionsGrade: Grade
  fingerLengthMm: number
  bodyDiameterMm: number
  bodyRadiusMm: number
  /** s 昇順の外形プロファイル */
  profile: { s: number; r: number }[]
  segments: ResolvedPlugSegment[]
  handle: {
    shoulderDiameterMm: number
    shoulderLengthMm: number
    bodyDiameterMm: number
    bodyLengthMm: number
    strainReliefLengthMm: number
    strainReliefDiameterMm: number
    cableDiameterMm: number
    cableLengthMm: number
  }
  grade: Grade
}

export function resolvePlug(def: PlugModelDef, dims: Dimensions): ResolvedPlug {
  const fingerLength = dims.resolve(def.fingerLength)
  const bodyDiameter = dims.resolve(def.bodyDiameter)

  const profile = def.radiusProfile
    .map((p) => ({ s: dims.num(p.s), r: dims.num(p.r) }))
    .sort((a, b) => a.s - b.s)

  if (profile.length < 2) {
    throw new DimensionResolutionError('プラグ外形プロファイルは 2 点以上必要')
  }

  const segments: ResolvedPlugSegment[] = def.segments.map((s) => {
    const start = dims.resolve(s.start, `${s.id}.start`)
    const end = dims.resolve(s.end, `${s.id}.end`)
    if (end.value <= start.value) {
      throw new DimensionResolutionError(
        `セグメント ${s.id} の幅が 0 以下 (${start.value} → ${end.value})。` +
          '絶縁帯を幅ゼロの境界として扱ってはならない (仕様 §4.2)。',
      )
    }
    return {
      id: s.id,
      label: s.label,
      kind: s.kind,
      net: s.net,
      startMm: start.value,
      endMm: end.value,
      material: s.material,
      grade: weakerGrade(start.grade, end.grade),
      sources: [...new Set([...start.sources, ...end.sources])],
      def: s,
    }
  })

  segments.sort((a, b) => a.startMm - b.startMm)

  // 連続性チェック: 隙間や重なりがあると接触判定が破綻する
  for (let i = 1; i < segments.length; i++) {
    const gap = segments[i].startMm - segments[i - 1].endMm
    if (Math.abs(gap) > 1e-9) {
      throw new DimensionResolutionError(
        `セグメント ${segments[i - 1].id} と ${segments[i].id} の間に ${gap.toFixed(4)}mm の` +
          '不整合がある。区間は隙間なく連続していなければならない。',
      )
    }
  }
  if (Math.abs(segments[0].startMm) > 1e-9) {
    throw new DimensionResolutionError('最初のセグメントは s=0 (プラグ先端) から始まる必要がある')
  }
  const last = segments[segments.length - 1]
  if (Math.abs(last.endMm - fingerLength.value) > 1e-6) {
    throw new DimensionResolutionError(
      `最後のセグメント末端 (${last.endMm}) が指部長 (${fingerLength.value}) と一致しない`,
    )
  }

  const h = def.handle
  return {
    variant: def.variant,
    poleCount: def.poleCount,
    partNumber: def.partNumber,
    manufacturer: def.manufacturer,
    netFunctions: def.netFunctions,
    netFunctionsGrade: def.netFunctionsGrade,
    fingerLengthMm: fingerLength.value,
    bodyDiameterMm: bodyDiameter.value,
    bodyRadiusMm: bodyDiameter.value / 2,
    profile,
    segments,
    handle: {
      shoulderDiameterMm: dims.num(h.shoulderDiameter),
      shoulderLengthMm: dims.num(h.shoulderLength),
      bodyDiameterMm: dims.num(h.bodyDiameter),
      bodyLengthMm: dims.num(h.bodyLength),
      strainReliefLengthMm: dims.num(h.strainReliefLength),
      strainReliefDiameterMm: dims.num(h.strainReliefDiameter),
      cableDiameterMm: dims.num(h.cableDiameter),
      cableLengthMm: dims.num(h.cableLength),
    },
    grade: weakestGrade([fingerLength.grade, bodyDiameter.grade, ...segments.map((s) => s.grade)]),
  }
}

// ---------------------------------------------------------------------------
// ジャック
// ---------------------------------------------------------------------------

export interface ResolvedBreakContact {
  id: string
  label: string
  terminalId: string
  normalState: 'closed' | 'open'
  openDeflectionMm: number
  grade: Grade
}

export interface ResolvedJackContact {
  id: string
  label: string
  expectedSegment: string
  terminalId: string
  axialCenterMm: number
  padWidthMm: number
  freeRadiusMm: number
  nominalDeflectionMm: number
  maxDeflectionMm: number
  springRateNPerMm: number
  angularPositionDeg: number
  rootAxialMm: number
  breakContact: ResolvedBreakContact | null
  grade: Grade
  sources: string[]
  note?: string
  def: JackContactDef
}

export interface ResolvedJack {
  partNumber: string
  manufacturer: string
  fullInsertionDepthMm: number
  entryBoreDiameterMm: number
  entryBushingLengthMm: number
  noseLengthMm: number
  nutDiameterMm: number
  housing: {
    widthMm: number
    heightMm: number
    depthMm: number
    axisHeightFromPcbMm: number
  }
  contacts: ResolvedJackContact[]
  terminals: ResolvedJackTerminal[]
  grade: Grade
}

/** 端子定義に、図面記載の実装位置を載せたもの */
export type ResolvedJackTerminal = JackTerminalDef & {
  /** 前面基準面からの軸位置 [mm]。読めなければ null */
  axialMm: number | null
  /** 軸中心からの横位置 [mm]。読めなければ null */
  lateralMm: number | null
}

export function resolveJack(def: JackModelDef, dims: Dimensions): ResolvedJack {
  const fullDepth = dims.resolve(def.fullInsertionDepth)

  const contacts: ResolvedJackContact[] = def.contacts.map((c) => {
    const axial = dims.resolve(c.axialCenter, `${c.id}.axialCenter`)
    const pad = dims.resolve(c.padWidth, `${c.id}.padWidth`)
    const free = dims.resolve(c.freeRadius, `${c.id}.freeRadius`)
    const nomDef = dims.resolve(c.nominalDeflection, `${c.id}.nominalDeflection`)
    const maxDef = dims.resolve(c.maxDeflection, `${c.id}.maxDeflection`)
    const rate = dims.resolve(c.springRate, `${c.id}.springRate`)

    if (pad.value <= 0) {
      throw new DimensionResolutionError(`接点 ${c.id} のパッド幅が 0 以下。幅を持つ接点として扱う必要がある。`)
    }

    let brk: ResolvedBreakContact | null = null
    if (c.breakContact) {
      const od = dims.resolve(c.breakContact.openDeflection, `${c.breakContact.id}.openDeflection`)
      brk = {
        id: c.breakContact.id,
        label: c.breakContact.label,
        terminalId: c.breakContact.terminalId,
        normalState: c.breakContact.normalState,
        openDeflectionMm: od.value,
        grade: od.grade,
      }
    }

    return {
      id: c.id,
      label: c.label,
      expectedSegment: c.expectedSegment,
      terminalId: c.terminalId,
      axialCenterMm: axial.value,
      padWidthMm: pad.value,
      freeRadiusMm: free.value,
      nominalDeflectionMm: nomDef.value,
      maxDeflectionMm: maxDef.value,
      springRateNPerMm: rate.value,
      angularPositionDeg: dims.num(c.angularPosition),
      rootAxialMm: dims.num(c.rootAxial),
      breakContact: brk,
      grade: weakestGrade([
        c.grade,
        axial.grade,
        pad.grade,
        free.grade,
        nomDef.grade,
        maxDef.grade,
        rate.grade,
        ...(brk ? [brk.grade] : []),
      ]),
      sources: [
        ...new Set([
          ...(c.sources ?? []),
          ...axial.sources,
          ...pad.sources,
          ...free.sources,
          ...rate.sources,
        ]),
      ],
      note: c.note,
      def: c,
    }
  })

  // 端子参照の整合性
  const terminalIds = new Set(def.terminals.map((t) => t.id))
  for (const c of contacts) {
    if (!terminalIds.has(c.terminalId)) {
      throw new DimensionResolutionError(`接点 ${c.id} が未定義の端子 ${c.terminalId} を参照している`)
    }
    if (c.breakContact && !terminalIds.has(c.breakContact.terminalId)) {
      throw new DimensionResolutionError(
        `ブレーク接点 ${c.breakContact.id} が未定義の端子 ${c.breakContact.terminalId} を参照している`,
      )
    }
  }

  const h = def.housing
  return {
    partNumber: def.partNumber,
    manufacturer: def.manufacturer,
    fullInsertionDepthMm: fullDepth.value,
    entryBoreDiameterMm: dims.num(def.entryBoreDiameter),
    entryBushingLengthMm: dims.num(def.entryBushingLength),
    noseLengthMm: dims.num(def.noseLength),
    nutDiameterMm: dims.num(def.nutDiameter),
    housing: {
      widthMm: dims.num(h.width),
      heightMm: dims.num(h.height),
      depthMm: dims.num(h.depth),
      axisHeightFromPcbMm: dims.num(h.axisHeightFromPcb),
    },
    contacts,
    // 端子の実位置 (jack.pinN.axial / .lateral) を載せる。
    // これが無いと 3D 表示が等間隔の合成位置になり、「端子3 が軸の左だから
    // Tip 接点は 270deg」という角度導出を画面で確かめられない。
    terminals: def.terminals.map((t) => {
      const num = t.pin
      const get = (suffix: string): number | null => {
        if (!num) return null
        try {
          return dims.num(`jack.pin${num}.${suffix}`)
        } catch {
          return null
        }
      }
      return { ...t, axialMm: get('axial'), lateralMm: get('lateral') }
    }),
    grade: weakestGrade([fullDepth.grade, ...contacts.map((c) => c.grade)]),
  }
}

// ---------------------------------------------------------------------------
// 幾何ユーティリティ
// ---------------------------------------------------------------------------

/** プラグ外形プロファイルから、先端距離 s における外半径を線形補間で求める。 */
export function plugRadiusAt(profile: { s: number; r: number }[], s: number): number {
  if (s <= profile[0].s) return profile[0].r
  const last = profile[profile.length - 1]
  if (s >= last.s) return last.r
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1]
    const b = profile[i]
    if (s <= b.s) {
      const t = b.s === a.s ? 0 : (s - a.s) / (b.s - a.s)
      return a.r + t * (b.r - a.r)
    }
  }
  return last.r
}

/** dr/ds (プロファイルの傾き)。挿抜力のランプ成分に使う。 */
export function plugSlopeAt(profile: { s: number; r: number }[], s: number): number {
  if (s < profile[0].s || s >= profile[profile.length - 1].s) return 0
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1]
    const b = profile[i]
    if (s <= b.s) {
      if (b.s === a.s) return 0
      return (b.r - a.r) / (b.s - a.s)
    }
  }
  return 0
}

export interface Interval {
  lo: number
  hi: number
}

/**
 * プロファイル上で r(s) >= rThreshold となる s の区間を厳密に求める。
 * (区分線形なので交点を解析的に解ける。サンプリング誤差を持ち込まない)
 */
export function radiusAtLeastIntervals(
  profile: { s: number; r: number }[],
  rThreshold: number,
): Interval[] {
  const out: Interval[] = []
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1]
    const b = profile[i]
    if (b.s <= a.s) continue
    const aIn = a.r >= rThreshold
    const bIn = b.r >= rThreshold
    if (aIn && bIn) {
      out.push({ lo: a.s, hi: b.s })
    } else if (!aIn && !bIn) {
      continue
    } else {
      // 1 回だけ交差する
      const t = (rThreshold - a.r) / (b.r - a.r)
      const sx = a.s + t * (b.s - a.s)
      if (aIn) out.push({ lo: a.s, hi: sx })
      else out.push({ lo: sx, hi: b.s })
    }
  }
  return mergeIntervals(out)
}

export function mergeIntervals(list: Interval[]): Interval[] {
  if (list.length === 0) return []
  const sorted = [...list].sort((x, y) => x.lo - y.lo)
  const out: Interval[] = [{ ...sorted[0] }]
  for (let i = 1; i < sorted.length; i++) {
    const cur = out[out.length - 1]
    const nxt = sorted[i]
    if (nxt.lo <= cur.hi + 1e-9) {
      cur.hi = Math.max(cur.hi, nxt.hi)
    } else {
      out.push({ ...nxt })
    }
  }
  return out.filter((iv) => iv.hi - iv.lo > 1e-12)
}

export function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = []
  for (const x of a) {
    for (const y of b) {
      const lo = Math.max(x.lo, y.lo)
      const hi = Math.min(x.hi, y.hi)
      if (hi - lo > 1e-12) out.push({ lo, hi })
    }
  }
  return mergeIntervals(out)
}

export function intervalsWidth(list: Interval[]): number {
  return list.reduce((sum, iv) => sum + (iv.hi - iv.lo), 0)
}
