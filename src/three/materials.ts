/**
 * 表示モードに応じたマテリアル決定。
 * 色だけに依存しないよう、UI 側では文字・アイコン・線種も併用する (仕様 §9)。
 */

import type { ContactState, Grade, MaterialDef } from '../model/types'
import type { ViewMode } from '../store/useAppStore'

export interface MaterialProps {
  color: string
  metalness: number
  roughness: number
  transparent: boolean
  opacity: number
  wireframe: boolean
  emissive: string
  emissiveIntensity: number
  depthWrite: boolean
}

/** 接触状態の色。彩度ではなく明度も変えて、色覚差でも判別できるようにする。 */
export const STATE_COLOR: Record<ContactState, string> = {
  OPEN: '#6b7280',
  INSULATED: '#a855f7',
  TOUCH_UNSTABLE: '#f59e0b',
  CLOSED: '#22c55e',
  WRONG_SEGMENT: '#ef4444',
  BRIDGED: '#dc2626',
  UNKNOWN: '#94a3b8',
}

export const STATE_LABEL: Record<ContactState, string> = {
  OPEN: '非接触',
  INSULATED: '絶縁帯上',
  TOUCH_UNSTABLE: '不安定接触',
  CLOSED: '正常接触',
  WRONG_SEGMENT: '誤接触',
  BRIDGED: '橋絡',
  UNKNOWN: '不明',
}

/** 記号でも区別できるようにする (色覚に依存しない) */
export const STATE_SYMBOL: Record<ContactState, string> = {
  OPEN: '○',
  INSULATED: '▨',
  TOUCH_UNSTABLE: '△',
  CLOSED: '●',
  WRONG_SEGMENT: '✕',
  BRIDGED: '⇄',
  UNKNOWN: '?',
}

export const GRADE_COLOR: Record<Grade, string> = {
  FACT: '#22c55e',
  DERIVED: '#3b82f6',
  ASSUMPTION: '#f59e0b',
  UNKNOWN: '#ef4444',
}

export const GRADE_LABEL: Record<Grade, string> = {
  FACT: '一次資料に記載',
  DERIVED: '図面から導出',
  ASSUMPTION: '明示的な仮定',
  UNKNOWN: '未確認',
}

export interface MaterialContext {
  viewMode: ViewMode
  /** ジャック外装など「外側の殻」か */
  isShell: boolean
  /** ジャック側の接点部品か */
  isContact: boolean
  /** プラグ側の導体か (接点のみ表示では半透明にして接点を透かす) */
  isPlugConductor?: boolean
  /** 発光させるか */
  highlight?: { color: string; intensity: number }
  /** 根拠区分表示モードで使う色 */
  gradeColor?: string
}

export function materialPropsFor(def: MaterialDef | undefined, ctx: MaterialContext): MaterialProps {
  const base: MaterialProps = {
    color: def?.color ?? '#888888',
    metalness: def?.metalness ?? 0.2,
    roughness: def?.roughness ?? 0.6,
    transparent: false,
    opacity: 1,
    wireframe: false,
    emissive: '#000000',
    emissiveIntensity: 0,
    depthWrite: true,
  }

  if (ctx.gradeColor) {
    base.color = ctx.gradeColor
    base.metalness = 0.1
    base.roughness = 0.8
  }

  switch (ctx.viewMode) {
    case 'translucent':
      if (ctx.isShell) {
        base.transparent = true
        base.opacity = 0.28
        base.depthWrite = false
      }
      break
    case 'transparent':
      if (ctx.isShell) {
        base.transparent = true
        base.opacity = 0.06
        base.depthWrite = false
      }
      break
    case 'contacts-only':
      if (ctx.isPlugConductor) {
        // プラグ導体は「どの電極に触れているか」を見せるため薄く残す
        base.transparent = true
        base.opacity = 0.3
        base.depthWrite = false
      } else if (!ctx.isContact) {
        base.transparent = true
        base.opacity = 0.04
        base.depthWrite = false
      }
      break
    case 'wireframe':
      base.wireframe = true
      break
    case 'section':
    case 'section-drag':
      if (ctx.isShell) {
        base.transparent = true
        base.opacity = 0.85
      }
      break
    default:
      break
  }

  if (ctx.highlight) {
    base.emissive = ctx.highlight.color
    base.emissiveIntensity = ctx.highlight.intensity
  }
  return base
}
