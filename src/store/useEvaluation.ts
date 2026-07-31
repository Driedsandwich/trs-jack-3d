import { useMemo } from 'react'
import { useAppStore, useModel } from './useAppStore'
import { extractEvents, sweep, type SweepRow } from '../model/sweep'
import type { EvaluationResult, InsertionEvent } from '../model/types'

/** 現在の深度・故障パラメータでの評価結果 */
export function useEvaluation(): EvaluationResult {
  const model = useModel()
  const depthMm = useAppStore((s) => s.depthMm)
  const faults = useAppStore((s) => s.faults)
  return useMemo(() => model.evaluate(depthMm, faults), [model, depthMm, faults])
}

/** イベントマーカー用のスイープ。故障パラメータが変わったときだけ再計算する。 */
export function useSweep(stepMm = 0.05): { rows: SweepRow[]; events: InsertionEvent[] } {
  const model = useModel()
  const faults = useAppStore((s) => s.faults)
  return useMemo(() => {
    const rows = sweep(model, { stepMm, faults })
    return { rows, events: extractEvents(model, rows) }
  }, [model, faults, stepMm])
}
