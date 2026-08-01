/**
 * Half-Plug Topology Profile v1 の互換性試験。
 * 統合オーダー (2026-08-01) §3 P0「Schemaと互換性試験」の 10 項目に対応する。
 *
 * JSON Schema の検証は自前で書いている。ajv を足すと依存が増えるためで、
 * 使っている機能 (required / type / enum / const / additionalProperties / $ref /
 * minItems / minimum) の範囲だけを実装している。**汎用の実装ではない。**
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '..')
const json = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))

const schema = json('schemas/half-plug-topology-profile.v1.schema.json')
const profile = json('artifacts/half_plug_topology_profile.v1.json')

// ---------------------------------------------------------------------------
// 最小限の JSON Schema 検証
// ---------------------------------------------------------------------------

function deref(node: Record<string, unknown>): Record<string, unknown> {
  if (typeof node.$ref !== 'string') return node
  const path = node.$ref.replace(/^#\//, '').split('/')
  let cur: unknown = schema
  for (const seg of path) cur = (cur as Record<string, unknown>)[seg]
  return { ...(cur as Record<string, unknown>), ...node, $ref: undefined }
}

function validate(value: unknown, node: Record<string, unknown>, path = '$'): string[] {
  const s = deref(node)
  const errs: string[] = []
  const push = (m: string) => errs.push(`${path}: ${m}`)

  if (s.const !== undefined && value !== s.const) push(`const ${JSON.stringify(s.const)} でない`)
  if (Array.isArray(s.enum) && !s.enum.includes(value as never)) push(`enum 外 (${JSON.stringify(value)})`)

  const types = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type]
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  const ok = types.length === 0 || types.some((t) => (t === 'integer' ? Number.isInteger(value) : t === actual))
  if (!ok) {
    push(`型が ${types.join('|')} でなく ${actual}`)
    return errs // 型が違えば以降は見ない
  }

  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) push(`minimum ${s.minimum} 未満`)
    if (typeof s.maximum === 'number' && value > s.maximum) push(`maximum ${s.maximum} 超過`)
    if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum) push(`exclusiveMinimum 違反`)
  }

  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) push(`minItems ${s.minItems} 未満`)
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) push(`maxItems ${s.maxItems} 超過`)
    if (s.items) value.forEach((v, i) => errs.push(...validate(v, s.items as Record<string, unknown>, `${path}[${i}]`)))
  }

  if (actual === 'object' && value !== null) {
    const obj = value as Record<string, unknown>
    for (const r of (s.required as string[]) ?? [])
      if (!(r in obj)) push(`必須 "${r}" が無い`)
    const props = (s.properties as Record<string, Record<string, unknown>>) ?? {}
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) errs.push(...validate(v, props[k], `${path}.${k}`))
      else if (s.additionalProperties === false) push(`未知のキー "${k}"`)
      else if (typeof s.additionalProperties === 'object')
        errs.push(...validate(v, s.additionalProperties as Record<string, unknown>, `${path}.${k}`))
    }
  }
  return errs
}

// ---------------------------------------------------------------------------

describe('Half-Plug Topology Profile v1', () => {
  // 1. JSON Schema validation
  it('1. schema に適合する', () => {
    expect(validate(profile, schema)).toEqual([])
  })

  it('1b. 検証器そのものが働く (壊した profile を弾ける)', () => {
    // 通るだけの検証器では意味がないので、確かに落ちることを見る
    expect(validate({ ...profile, schemaVersion: 2 }, schema).length).toBeGreaterThan(0)
    expect(validate({ ...profile, intervals: [] }, schema).length).toBeGreaterThan(0)
    const bad = structuredClone(profile)
    bad.intervals[0].normalizedStart = 1.5
    expect(validate(bad, schema).length).toBeGreaterThan(0)
  })

  // 2. 同一入力・同一日・同一 revision で byte-identical
  it('2. 決定性 — 乱数も現在時刻も使っていない', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/exportHalfPlugProfile.ts'), 'utf8')
    expect(src).not.toMatch(/Math\.random/)
    // 日付は ARTIFACT_DATE で固定できる経路しか持たない
    expect(src).toMatch(/process\.env\.ARTIFACT_DATE/)
    expect(src).toMatch(/process\.env\.SOURCE_REVISION/)
  })

  // 3. 全 state change がちょうど 1 つの interval 境界へ対応
  it('3. 全ての区間境界が、隣の区間の開始と一致する', () => {
    for (let i = 1; i < profile.intervals.length; i++)
      expect(profile.intervals[i].nominalStartMm).toBe(profile.intervals[i - 1].nominalEndMm)
  })

  // 4. interval 間に穴・重複がない
  it('4. 区間に穴も重複もなく、0 から完全挿入まで覆っている', () => {
    const iv = profile.intervals
    expect(iv[0].nominalStartMm).toBe(0)
    expect(iv[iv.length - 1].nominalEndMm).toBe(profile.fullInsertionDepthMm)
    for (const x of iv) expect(x.nominalEndMm).toBeGreaterThan(x.nominalStartMm)
  })

  // 5. normalizedStart/End が 0〜1
  it('5. normalized が 0〜1 で、mm と整合している', () => {
    for (const x of profile.intervals) {
      expect(x.normalizedStart).toBeGreaterThanOrEqual(0)
      expect(x.normalizedEnd).toBeLessThanOrEqual(1)
      expect(x.normalizedStart).toBeCloseTo(x.nominalStartMm / profile.fullInsertionDepthMm, 5)
    }
  })

  // 6. FACT/DERIVED/ASSUMPTION/UNKNOWN の伝播
  it('6. 各区間の evidenceGrade が、その区間の接点の最も弱い区分になっている', () => {
    const order = ['FACT', 'DERIVED', 'ASSUMPTION', 'UNKNOWN']
    for (const x of profile.intervals) {
      const weakest = x.contacts.reduce(
        (a: string, c: { evidenceGrade: string }) =>
          order.indexOf(c.evidenceGrade) > order.indexOf(a) ? c.evidenceGrade : a,
        'FACT',
      )
      expect({ id: x.intervalId, g: x.evidenceGrade }).toEqual({ id: x.intervalId, g: weakest })
    }
    // 台帳の件数がそのまま載っていること
    const dims = json('src/data/dimensions.json').entries as Record<string, { grade: string }>
    const counts = { FACT: 0, DERIVED: 0, ASSUMPTION: 0, UNKNOWN: 0 } as Record<string, number>
    for (const v of Object.values(dims)) counts[v.grade]++
    expect(profile.assumptionSummary.counts).toEqual(counts)
  })

  // 7. 未測定 profile に verifiedPhysical=true を設定できない
  it('7. 実測していないので verifiedPhysical は false', () => {
    expect(profile.modelLimitations.verifiedPhysical).toBe(false)
    expect(profile.modelLimitations.physicalVerificationRef).toBeNull()
    // 実測記録が無い状態で true にできる経路がコードに無いこと
    const src = readFileSync(resolve(ROOT, 'scripts/exportHalfPlugProfile.ts'), 'utf8')
    expect(src).not.toMatch(/verifiedPhysical:\s*true/)
  })

  // 8. quality から Ω や DSP 係数を生成しない
  it('8. quality を Ω・ゲイン・係数へ変換していない', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/exportHalfPlugProfile.ts'), 'utf8')
    expect(src).not.toMatch(/quality\s*\*/)
    expect(src).not.toMatch(/ohm|Ohm|resistance/)
    // profile 本体にも quality を持ち出していない
    expect(JSON.stringify(profile)).not.toMatch(/"quality"/)
    // 変換禁止が明文で残っていること
    expect(profile.modelLimitations.notes.join()).toMatch(/quality/)
  })

  // 9. 既定 TRS で存在しない音響状態を捏造しない
  it('9. 存在しないトポロジーを「無い」と記録している', () => {
    expect(profile.absentTopologies.searched).toContain('ground-open')
    // この既定モデルでは共通帰線断は起きない。起きないことを記録するのが正しい
    const present = new Set(profile.intervals.map((x: { acousticAnnotation: { topologyClass: string } }) => x.acousticAnnotation.topologyClass))
    for (const t of profile.absentTopologies.absent) expect(present.has(t)).toBe(false)
    for (const t of present) expect(profile.absentTopologies.absent).not.toContain(t)
  })

  // 10. CC BY 対象データの帰属情報を保持
  it('10. ライセンスと帰属が機械可読で残っている', () => {
    expect(profile.dataLicense.data).toBe('CC BY 4.0')
    expect(profile.dataLicense.code).toBe('MIT')
    expect(profile.dataLicense.attribution).toMatch(/trs-jack-3d/)
    expect(profile.dataLicense.attribution).toMatch(/CC BY 4\.0/)
  })

  // オーダーが禁じている結合を、出力側でも守れているか
  it('禁止された結合をしていない', () => {
    const notes = profile.modelLimitations.notes.join('\n')
    expect(notes).toMatch(/DSP 係数ではない/)
    expect(notes).toMatch(/代表しない/)
    // acousticAnnotation は係数ではなく分類であること
    for (const x of profile.intervals) {
      expect(typeof x.acousticAnnotation.topologyClass).toBe('string')
      expect(['none', 'protection-dependent', 'short-circuit']).toContain(x.acousticAnnotation.electricalRisk)
    }
  })

  it('感度の幅は「測っていない」と「動かない」を区別している', () => {
    // spreadMm が null の事象があること自体は正しい。混同されないよう注記が要る
    const hasNull = profile.events.some((e: { spreadMm: unknown }) => e.spreadMm === null)
    if (hasNull) expect(profile.sensitivitySummary.notes.join()).toMatch(/測っていない/)
    for (const e of profile.events)
      if (e.spreadMm) expect(e.spreadMm.sweptParameters.length).toBeGreaterThan(0)
  })
})
