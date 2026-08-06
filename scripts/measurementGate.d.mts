export declare const GATE_VERSION: number
export declare const GATE_DOCUMENT: string
export declare const LEDGER_PATH: string
export declare const CLAIM_SCOPE: string
export declare const CLAIM_SCOPES_NOT_COVERED: string[]
export declare const RESOLUTION_DIVISOR: number

export interface Observation {
  variantId: string
  label: string
  unit: string
  toleranceMm: number
  discriminatesMm: number
  /** 許容から導く（条文 v2 第5条）。**手で書かない** */
  maxResolutionMm: number
  why: string
  procedure: string
}

export declare const OBSERVATIONS: Record<string, Observation>
export declare const REQUIRED_FOR_PROFILE: Record<string, string[]>

export interface RecordCheck {
  /** 記録として読めるか */
  valid: boolean
  /** 読めたうえで、**認定に足りるか**（分解能・目盛） */
  certifiable: boolean
  retracted: boolean
  reasons: string[]
  notCertifiableReasons: string[]
  rangeMm: number | null
  meanMm: number | null
  resolutionMm: number | null
}

export declare function checkRecord(rec: unknown): RecordCheck

export type GateVerdict = 'VERIFIED' | 'AMBIGUOUS' | 'UNVERIFIED' | 'INVALID_LEDGER'

export interface GateResult {
  verified: boolean
  verdict: GateVerdict
  gateVersion: number
  /** この判定が主張する範囲。**接点トポロジーも音響も含まない** */
  claimScope: string
  notCoveredByThisClaim: string[]
  required: string[]
  satisfied: {
    observation: string
    recordId: string
    recordIds?: string[]
    measuredMm: number
    predictedMm: number
    deltaMm: number
    rangeMm: number | null
  }[]
  missing: string[]
  /** 一致する記録と矛盾する記録が併存している観測点 */
  ambiguous: string[]
  rejected: { recordId: string, observation: string, reasons: string[] }[]
  conflicting: {
    recordId: string
    observation: string
    measuredMm: number
    predictedMm: number
    deltaMm: number
    reasons: string[]
  }[]
  retracted: { recordId: string, observation: string, reason: string | null }[]
  notCertified: { recordId: string, observation: string, reasons: string[] }[]
  duplicateRecordIds: string[]
  decidedBy: string[]
}

export declare function evaluateGate(o: {
  ledger: unknown
  profileVariantId: string
  predictions?: Record<string, number>
}): GateResult

export declare function predictionsFromEvents(
  events: unknown,
  fullDepthMm?: number,
): Record<string, number>

/** `physicalVerificationRef` の `predicted=` を読む（v0.6.3） */
export declare function recordedPredictions(ref: unknown): Record<string, number>

/**
 * 配布 profile だけから、判定に使う予測を組み直す（validator 用・v0.6.3）。
 * event 列から計算し直せるものは記録値との一致を要求する。
 * **`problems` が空でなければ検証は不合格**
 */
export declare function predictionsForValidation(profile: unknown): {
  predictions: Record<string, number>
  problems: string[]
}
