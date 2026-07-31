/**
 * モデル全体のファサード。UI と 3D 表示はここだけを見る。
 * 接触判定・回路・力・イベントを 1 つの決定論的な評価にまとめる。
 */

import { evaluateAllContacts, loadContactConfig, DEFAULT_FAULTS, type ContactModelConfig } from './contact'
import { buildCircuit, predictAcoustic } from './circuit'
import { computeForce, loadForceConfig, type ForceModelConfig, type ForceBreakdown } from './force'
import {
  Dimensions,
  resolveJack,
  resolvePlug,
  type ResolvedJack,
  type ResolvedPlug,
} from './resolve'
import type {
  DimensionTable,
  EvaluationResult,
  FaultParams,
  FaultPreset,
  Grade,
  JackModelDef,
  MaterialDef,
  PlugModelDef,
  SourceReference,
} from './types'

export interface ModelBundle {
  dimensions: DimensionTable
  plug: PlugModelDef
  jack: JackModelDef
  materials: MaterialDef[]
  sources: SourceReference[]
  faultPresets: FaultPreset[]
}

export class TrsModel {
  readonly dims: Dimensions
  readonly plug: ResolvedPlug
  readonly jack: ResolvedJack
  readonly contactCfg: ContactModelConfig
  readonly forceCfg: ForceModelConfig
  readonly materials: Map<string, MaterialDef>
  readonly sources: Map<string, SourceReference>
  readonly faultPresets: FaultPreset[]

  constructor(bundle: ModelBundle) {
    this.dims = new Dimensions(bundle.dimensions)
    this.plug = resolvePlug(bundle.plug, this.dims)
    this.jack = resolveJack(bundle.jack, this.dims)
    this.contactCfg = loadContactConfig(this.dims)
    this.forceCfg = loadForceConfig(this.dims)
    this.materials = new Map(bundle.materials.map((m) => [m.id, m]))
    this.sources = new Map(bundle.sources.map((s) => [s.id, s]))
    this.faultPresets = bundle.faultPresets

    // 極数の違う組み合わせでは、ジャック側の接点に対応する導体がプラグに無いことがある
    // (例: 4極ジャックの Ring2 接点 × 3極プラグ)。これはエラーではなく、
    // まさに計算して見せるべき状態なので、記録だけして続行する。
    this.unmatchedContacts = this.jack.contacts
      .filter((c) => !this.plug.segments.some((s) => s.id === c.expectedSegment))
      .map((c) => c.id)
  }

  /** プラグ側に対応する導体が存在しないジャック接点の id */
  readonly unmatchedContacts: string[]

  /** 完全挿入深度 [mm] */
  get fullDepthMm(): number {
    return this.jack.fullInsertionDepthMm
  }

  /** 深度を百分率に変換 */
  toPercent(depthMm: number): number {
    return (depthMm / this.fullDepthMm) * 100
  }

  fromPercent(percent: number): number {
    return (percent / 100) * this.fullDepthMm
  }

  clampDepth(depthMm: number, minMm = -this.plug.fingerLengthMm - 2): number {
    return Math.max(minMm, Math.min(this.fullDepthMm, depthMm))
  }

  evaluate(depthMm: number, faults: FaultParams = DEFAULT_FAULTS): EvaluationResult {
    const contacts = evaluateAllContacts(this.jack, this.plug, depthMm, faults, this.contactCfg)
    const circuit = buildCircuit(this.jack, contacts)
    const acoustic = predictAcoustic(this.jack, this.plug, contacts, circuit)
    const force = computeForce(this.jack, this.plug, depthMm, faults, this.contactCfg, this.forceCfg)
    return {
      depthMm,
      depthPercent: this.toPercent(depthMm),
      contacts,
      circuit,
      acoustic,
      estimatedForceN: force.insertionN,
      anyBridged: contacts.some((c) => c.state === 'BRIDGED'),
      anyWrongSegment: contacts.some((c) => c.state === 'WRONG_SEGMENT'),
      anyUnstable: contacts.some((c) => c.state === 'TOUCH_UNSTABLE'),
    }
  }

  force(depthMm: number, faults: FaultParams = DEFAULT_FAULTS): ForceBreakdown {
    return computeForce(this.jack, this.plug, depthMm, faults, this.contactCfg, this.forceCfg)
  }

  /** 全モデルの最弱グレード。「この画面のどこまでが確実か」の表示に使う。 */
  overallGrade(): Grade {
    return this.plug.grade === 'FACT' && this.jack.grade === 'FACT' ? 'FACT' : 'ASSUMPTION'
  }

  materialOf(id: string): MaterialDef | undefined {
    return this.materials.get(id)
  }
}
