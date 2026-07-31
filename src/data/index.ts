/**
 * データ層の入口。JSON から型付きモデルを組み立て、組み合わせごとにキャッシュする。
 *
 * 3D 表示・UI・接点計算はここから得たモデルだけを見る。JSON を直接読まない。
 *
 * プラグ (3極 TRS / 4極 CTIA / 4極 OMTP) × ジャック (3極 / 4極) の全組み合わせを扱う。
 * 混挿 (例: 4極プラグを3極ジャックへ) の結果は、物語ではなく各接点の幾何位置から計算される。
 */

import dimensionsJson from './dimensions.json'
import plugTrsJson from './plugSegments.json'
import plugTrrsJson from './plugSegments.trrs.json'
import jackTrsJson from './jackContacts.json'
import jackTrrsJson from './jackContacts.trrs.json'
import materialsJson from './materials.json'
import sourcesJson from './sourceReferences.json'
import faultPresetsJson from './faultPresets.json'
import { TrsModel, type ModelBundle } from '../model/engine'
import type {
  DimensionTable,
  FaultPreset,
  JackModelDef,
  MaterialDef,
  PlugModelDef,
  SourceReference,
} from '../model/types'

export type PlugVariantId = 'TRS' | 'TRRS-CTIA' | 'TRRS-OMTP'
export type JackVariantId = 'JACK-TRS' | 'JACK-TRRS'
/** モデルの識別子。プラグとジャックの組み合わせ。 */
export type VariantId = `${PlugVariantId}|${JackVariantId}`

export interface VariantInfo<T extends string> {
  id: T
  label: string
  description: string
  /** この構成が実在部品の実測に基づくか、構成モデルか */
  basis: 'measured-part' | 'constructed'
}

const PLUG_VARIANTS: VariantInfo<PlugVariantId>[] = [
  {
    id: 'TRS',
    label: '3極 TRS (Lumberg 1532 10)',
    description: 'データシート図面を実測した実在部品。Tip=左 / Ring=右 / Sleeve=共通帰線。',
    basis: 'measured-part',
  },
  {
    id: 'TRRS-CTIA',
    label: '4極 TRRS / CTIA (代表形状)',
    description:
      'Tip=左, Ring1=右, Ring2=帰線, Sleeve=マイク。配列は Android の一次仕様。形状は 2 社の図面で一致する共通寸法から構成。Ring1/Ring2 の境界は仮定。',
    basis: 'constructed',
  },
  {
    id: 'TRRS-OMTP',
    label: '4極 TRRS / OMTP (代表形状)',
    description:
      'Tip=左, Ring1=右, Ring2=マイク, Sleeve=帰線。配列は OMTP 一次仕様。CTIA とは Ring2 と Sleeve の機能だけが入れ替わる (形状は同一)。',
    basis: 'constructed',
  },
]

const JACK_VARIANTS: VariantInfo<JackVariantId>[] = [
  {
    id: 'JACK-TRS',
    label: '3極ジャック (Lumberg 1503 09)',
    description: 'データシートを実測した実在部品。ブレーク接点 2 個つき。',
    basis: 'measured-part',
  },
  {
    id: 'JACK-TRRS',
    label: '4極ジャック (代表構成)',
    description:
      '端子番号は Same Sky SJ3-35074A に準拠。内部接点の位置は一次図面が無いため仮定。3極プラグを挿したときの挙動を見るための構成モデル。',
    basis: 'constructed',
  },
]

export function listPlugVariants(): VariantInfo<PlugVariantId>[] {
  return PLUG_VARIANTS
}
export function listJackVariants(): VariantInfo<JackVariantId>[] {
  return JACK_VARIANTS
}
export function plugInfo(id: PlugVariantId) {
  return PLUG_VARIANTS.find((v) => v.id === id) ?? PLUG_VARIANTS[0]
}
export function jackInfo(id: JackVariantId) {
  return JACK_VARIANTS.find((v) => v.id === id) ?? JACK_VARIANTS[0]
}
export function makeVariantId(plug: PlugVariantId, jack: JackVariantId): VariantId {
  return `${plug}|${jack}`
}
export function splitVariantId(id: VariantId): [PlugVariantId, JackVariantId] {
  const [p, j] = id.split('|')
  return [p as PlugVariantId, j as JackVariantId]
}

const dimensions = (dimensionsJson as { entries: DimensionTable }).entries
const materials = (materialsJson as { materials: MaterialDef[] }).materials
const sources = (sourcesJson as { sources: SourceReference[] }).sources
const faultPresets = (faultPresetsJson as { presets: FaultPreset[] }).presets

type TrrsFile = {
  common: Omit<PlugModelDef, 'schemaVersion' | 'variant' | 'poleCount' | 'partNumber' | 'manufacturer' | 'netFunctions' | 'netFunctionsGrade'> & {
    poleCount: number
  }
  variants: Record<string, Partial<PlugModelDef>>
}

function plugFor(id: PlugVariantId): PlugModelDef {
  if (id === 'TRS') return plugTrsJson as unknown as PlugModelDef
  const file = plugTrrsJson as unknown as TrrsFile
  const v = file.variants[id === 'TRRS-CTIA' ? 'ctia' : 'omtp']
  return { schemaVersion: 1, ...file.common, ...v } as PlugModelDef
}

function jackFor(id: JackVariantId): JackModelDef {
  return (id === 'JACK-TRS' ? jackTrsJson : jackTrrsJson) as unknown as JackModelDef
}

function buildBundle(id: VariantId): ModelBundle {
  const [p, j] = splitVariantId(id)
  return {
    dimensions,
    plug: plugFor(p),
    jack: jackFor(j),
    materials,
    sources,
    faultPresets,
  }
}

/**
 * 寸法を差し替えたモデルを組む。感度解析 (scripts/sensitivity.ts) 用。
 *
 * 既定のモデルはキャッシュされるが、こちらは毎回新しく組む。呼び出し側が
 * 何千通りも試すので、キャッシュに載せると際限なく太るため。
 */
export function buildModelWithOverrides(
  id: VariantId,
  overrides: Record<string, number>,
): TrsModel {
  const base = buildBundle(id)
  const entries: typeof base.dimensions = { ...base.dimensions }
  for (const [key, value] of Object.entries(overrides)) {
    const cur = entries[key]
    if (!cur) throw new Error(`未知の寸法キー: ${key}`)
    entries[key] = { ...cur, value }
  }
  return new TrsModel({ ...base, dimensions: entries })
}

const cache = new Map<VariantId, TrsModel>()

export function getModel(id: VariantId = 'TRS|JACK-TRS'): TrsModel {
  let m = cache.get(id)
  if (!m) {
    m = new TrsModel(buildBundle(id))
    cache.set(id, m)
  }
  return m
}

/** 全ての組み合わせ (テストとスイープ生成で使う) */
export function allVariantIds(): VariantId[] {
  const out: VariantId[] = []
  for (const p of PLUG_VARIANTS) for (const j of JACK_VARIANTS) out.push(makeVariantId(p.id, j.id))
  return out
}

export { dimensions as rawDimensions, sources as rawSources }
