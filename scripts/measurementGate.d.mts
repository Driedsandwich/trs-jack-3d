export declare const GATE_VERSION: number
export declare const GATE_DOCUMENT: string
export declare const LEDGER_PATH: string

export interface Observation {
  variantId: string
  label: string
  unit: string
  toleranceMm: number
  discriminatesMm: number
  why: string
  procedure: string
}

export declare const OBSERVATIONS: Record<string, Observation>
export declare const REQUIRED_FOR_PROFILE: Record<string, string[]>

export interface RecordCheck {
  valid: boolean
  reasons: string[]
  rangeMm: number | null
  meanMm: number | null
}

export declare function checkRecord(rec: unknown): RecordCheck

export interface GateResult {
  verified: boolean
  gateVersion: number
  required: string[]
  satisfied: {
    observation: string
    recordId: string
    measuredMm: number
    predictedMm: number
    deltaMm: number
    rangeMm: number | null
  }[]
  missing: string[]
  rejected: { recordId: string, observation: string, reasons: string[] }[]
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
