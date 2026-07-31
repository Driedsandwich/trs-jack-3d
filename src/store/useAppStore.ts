/**
 * アプリ状態。3D 表示・接点計算・UI を分離するため、
 * ここには「操作の状態」だけを置き、計算結果は持たない (毎回モデルから導出する)。
 */

import { create } from 'zustand'
import { DEFAULT_FAULTS } from '../model/contact'
import type { FaultParams } from '../model/types'
import { getModel, makeVariantId, splitVariantId, type JackVariantId, type PlugVariantId, type VariantId } from '../data'

export type ViewMode =
  | 'normal'
  | 'translucent'
  | 'transparent'
  | 'section'
  | 'section-drag'
  | 'exploded'
  | 'contacts-only'
  | 'wireframe'

export interface AppState {
  // --- 挿入 ---
  depthMm: number
  targetDepthMm: number | null
  animating: 'none' | 'inserting' | 'withdrawing'
  animationSpeedMmPerSec: number
  paused: boolean

  // --- 表示 ---
  viewMode: ViewMode
  glowContacts: boolean
  showDimensions: boolean
  showGrades: boolean
  showLabels: boolean
  explodeAmount: number
  clipPositionMm: number
  clipAxis: 'y' | 'z'
  lowQuality: boolean
  /** インクリメントすると 3D 側がカメラを既定位置へ戻す */
  cameraResetToken: number

  // --- モデル ---
  variantId: VariantId

  // --- 故障 ---
  faults: FaultParams
  activePresetId: string | null

  // --- 操作 ---
  setDepth: (mm: number) => void
  nudgeDepth: (deltaMm: number) => void
  setDepthPercent: (pct: number) => void
  reset: () => void
  autoInsert: () => void
  autoWithdraw: () => void
  togglePause: () => void
  stopAnimation: () => void
  tick: (dtSec: number) => void

  setViewMode: (m: ViewMode) => void
  patch: (p: Partial<AppState>) => void
  setFaults: (f: Partial<FaultParams>) => void
  applyPreset: (id: string) => void
  setVariant: (v: VariantId) => void
  setPlugVariant: (p: PlugVariantId) => void
  setJackVariant: (j: JackVariantId) => void
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export const useAppStore = create<AppState>((set, get) => ({
  depthMm: -3,
  targetDepthMm: null,
  animating: 'none',
  animationSpeedMmPerSec: 4,
  paused: false,

  viewMode: 'translucent',
  glowContacts: true,
  showDimensions: false,
  showGrades: false,
  showLabels: true,
  explodeAmount: 0,
  clipPositionMm: 0,
  clipAxis: 'z',
  lowQuality: false,
  cameraResetToken: 0,

  variantId: 'TRS|JACK-TRS' as VariantId,

  faults: { ...DEFAULT_FAULTS },
  activePresetId: 'normal',

  setDepth: (mm) => {
    const model = getModel(get().variantId)
    set({ depthMm: model.clampDepth(mm), animating: 'none' })
  },
  nudgeDepth: (delta) => {
    const model = getModel(get().variantId)
    set({ depthMm: model.clampDepth(get().depthMm + delta), animating: 'none' })
  },
  setDepthPercent: (pct) => {
    const model = getModel(get().variantId)
    set({ depthMm: model.clampDepth(model.fromPercent(pct)), animating: 'none' })
  },
  reset: () => set({ depthMm: -3, animating: 'none', paused: false, targetDepthMm: null }),
  autoInsert: () => set({ animating: 'inserting', paused: false }),
  autoWithdraw: () => set({ animating: 'withdrawing', paused: false }),
  togglePause: () => set({ paused: !get().paused }),
  stopAnimation: () => set({ animating: 'none' }),

  tick: (dt) => {
    const s = get()
    if (s.animating === 'none' || s.paused) return
    const model = getModel(s.variantId)
    const dir = s.animating === 'inserting' ? 1 : -1
    const next = s.depthMm + dir * s.animationSpeedMmPerSec * dt
    const minDepth = -(model.plug.fingerLengthMm + 2)
    if (dir > 0 && next >= model.fullDepthMm) {
      set({ depthMm: model.fullDepthMm, animating: 'none' })
    } else if (dir < 0 && next <= minDepth) {
      set({ depthMm: minDepth, animating: 'none' })
    } else {
      set({ depthMm: next })
    }
  },

  setViewMode: (m) => set({ viewMode: m }),
  patch: (p) => set(p as Partial<AppState>),
  setFaults: (f) => set({ faults: { ...get().faults, ...f }, activePresetId: null }),
  applyPreset: (id) => {
    const model = getModel(get().variantId)
    const preset = model.faultPresets.find((p) => p.id === id)
    if (!preset) return
    const next: FaultParams = { ...DEFAULT_FAULTS, ...preset.params }
    set({
      faults: next,
      activePresetId: id,
      animating: 'none',
      ...(preset.depthMm !== null ? { depthMm: clamp(preset.depthMm, -20, model.fullDepthMm) } : {}),
    })
  },
  setVariant: (v) => {
    const model = getModel(v)
    set({ variantId: v, depthMm: Math.min(get().depthMm, model.fullDepthMm) })
  },
  setPlugVariant: (p) => {
    const [, j] = splitVariantId(get().variantId)
    get().setVariant(makeVariantId(p, j))
  },
  setJackVariant: (j) => {
    const [p] = splitVariantId(get().variantId)
    get().setVariant(makeVariantId(p, j))
  },
}))

/** 現在のバリアントのモデル */
export function useModel() {
  const id = useAppStore((s) => s.variantId)
  return getModel(id)
}
