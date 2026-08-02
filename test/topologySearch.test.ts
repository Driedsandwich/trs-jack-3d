/**
 * 目標トポロジー探索の結果に対する検査。統合オーダー §3 P1。
 *
 * ここで一番気にしているのは **「探した」と言えているか** である。
 * 2026-08-02 に、4極ジャックへ 3極用のキーを渡していて override が効かず、
 * 2 variant ぶんが既定値のまま数百回繰り返されるだけの空振りになっていた。
 * それでも「3 variant を探索した」と報告できてしまう状態だった。
 * 網羅性の主張は、主張そのものを検査しないと簡単に嘘になる。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildModelWithOverrides, getModel } from '../src/data'

const ROOT = resolve(__dirname, '..')
const PATH = resolve(ROOT, 'artifacts/topology_search_ground_open.json')

// artifact は npm run search:topology で作る。無い環境ではこの検査を飛ばす
const present = existsSync(PATH)
const search = present ? JSON.parse(readFileSync(PATH, 'utf8')) : null

describe.skipIf(!present)('目標トポロジー探索 (GROUND_OPEN)', () => {
  it('目標と探索空間が記録されている', () => {
    expect(search.targetCode).toBe('GROUND_OPEN')
    expect(search.searchSpace.configurationsTried).toBeGreaterThan(100)
    expect(search.searchSpace.variants.length).toBeGreaterThanOrEqual(2)
  })

  it('**各 variant で振った軸が、その variant に実際に効く**', () => {
    // 空振りの再発防止。効かないキーで「振った」と数えていないことを実測で確かめる
    for (const [variantId, keys] of Object.entries(search.searchSpace.axesUsedPerVariant as Record<string, string[]>)) {
      const before = JSON.stringify(
        getModel(variantId as never).jack.contacts.map((c) => [c.axialCenterMm, c.padWidthMm]),
      )
      for (const key of keys) {
        if (key.includes('complianceMm')) continue // 接点寸法を変えない軸
        const axis = (Object.values(search.searchSpace.axesByJack) as { key: string; levels: number[]; shipped: number }[][])
          .flat()
          .find((a) => a.key === key)!
        const alt = axis.levels.find((v) => v !== axis.shipped)!
        const after = JSON.stringify(
          buildModelWithOverrides(variantId as never, { [key]: alt }).jack.contacts.map((c) => [
            c.axialCenterMm,
            c.padWidthMm,
          ]),
        )
        expect({ variantId, key, changed: before !== after }).toEqual({ variantId, key, changed: true })
      }
    }
  })

  it('4極 variant には 4極用のキーを使っている', () => {
    const used = search.searchSpace.axesUsedPerVariant as Record<string, string[]>
    for (const [variantId, keys] of Object.entries(used)) {
      const isTrrsJack = variantId.endsWith('JACK-TRRS')
      const contactKeys = keys.filter((k) => k.includes('contact') && !k.includes('complianceMm'))
      for (const k of contactKeys)
        expect({ variantId, k, ok: isTrrsJack ? k.startsWith('trrs.') : !k.startsWith('trrs.') }).toEqual({
          variantId,
          k,
          ok: true,
        })
    }
  })

  it('見つからなくても理由が残っている（正常終了して反証を保存する）', () => {
    if (!search.found || !search.foundWithWorkingJack) {
      expect(search.notFoundReason).toBeTruthy()
      expect(String(search.notFoundReason).length).toBeGreaterThan(20)
    }
    // found と件数が食い違っていないこと
    expect(search.found).toBe(search.witnessCount > 0)
    expect(search.foundWithWorkingJack).toBe(search.usableWitnessCount > 0)
  })

  /** 3 分類の標本をすべて集める */
  const allSamples = () => [
    ...search.usableWitnesses.samples,
    ...search.strictDifferenceSignal.samples,
    ...search.brokenJackWitnesses.samples,
  ]

  it('実在部品と架空の構成を混同していない', () => {
    for (const w of allSamples()) {
      expect(w.evidenceGrade).toBe('ASSUMPTION')
      // 既定値から 1 つでも動いていれば constructed
      const axes = (Object.values(search.searchSpace.axesByJack) as { key: string; shipped: number }[][]).flat()
      const moved = Object.entries(w.overrides as Record<string, number>).some(([k, v]) => {
        const a = axes.find((x) => x.key === k)
        return a && v !== a.shipped
      })
      expect({ id: JSON.stringify(w.overrides).slice(0, 40), constructed: w.constructed }).toEqual({
        id: JSON.stringify(w.overrides).slice(0, 40),
        constructed: moved,
      })
    }
  })

  it('「一般的な 3.5mm ジャック」の代表性を主張していない', () => {
    expect(search.representativenessDisclaimer).toMatch(/代表するものではない/)
    expect(search.representativenessDisclaimer).toMatch(/実在部品ではない/)
  })

  it('**件数を出した分類は、必ず標本も出している**', () => {
    // 2026-08-02: 「318 件ある」と書きながら 1 件も収録していない artifact を作った。
    // 種類を混ぜて幅の広い順に上位を取ったせいで、上位が全部別種で占められていた。
    for (const [name, cat] of Object.entries({
      usable: search.usableWitnesses,
      strict: search.strictDifferenceSignal,
      broken: search.brokenJackWitnesses,
    }) as [string, { total: number; samples: unknown[]; droppedFromListing: number }][]) {
      if (cat.total > 0) expect({ name, shown: cat.samples.length > 0 }).toEqual({ name, shown: true })
      // 切り捨て件数が合っていること (黙って捨てない)
      expect({ name, d: cat.droppedFromListing }).toEqual({ name, d: cat.total - cat.samples.length })
    }
  })

  it('**成立した variant が標本から消えていない**', () => {
    // 幅の広い順に取ると 3極が上位を占め、4極が 1 件も載らないまま
    // 「240 件成立」とだけ書かれた artifact ができた (同日・2 度目の同型)
    for (const [name, cat] of Object.entries({
      usable: search.usableWitnesses,
      strict: search.strictDifferenceSignal,
    }) as [string, { byVariant: Record<string, number>; samples: { variantId: string }[] }][]) {
      const shown = new Set(cat.samples.map((w) => w.variantId))
      for (const [variantId, n] of Object.entries(cat.byVariant))
        if (n > 0) expect({ name, variantId, shown: shown.has(variantId) }).toEqual({ name, variantId, shown: true })
    }
  })

  it('variant 別の内訳が合計と一致する', () => {
    const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0)
    expect(sum(search.witnessCountByVariant)).toBe(search.witnessCount)
    expect(sum(search.usableWitnesses.byVariant)).toBe(search.usableWitnesses.total)
    expect(sum(search.strictDifferenceSignal.byVariant)).toBe(search.strictDifferenceSignal.total)
  })

  it('厳密な差分信号は usable の部分集合である', () => {
    expect(search.strictDifferenceSignal.total).toBeLessThanOrEqual(search.usableWitnesses.total)
    for (const w of search.strictDifferenceSignal.samples) {
      expect(w.fullInsertionOk).toBe(true)
      expect(w.strictDifferenceSignal).toBe(true)
    }
  })

  it('走査刻みの限界を明記している（取りこぼしうることを隠さない）', () => {
    expect(search.searchSpace.coarseStepMm).toBeGreaterThan(0)
    if (!search.found) expect(String(search.notFoundReason)).toMatch(/刻み/)
  })

  it('witness があるなら、窓の幅が刻み以上で整合している', () => {
    for (const w of allSamples()) {
      expect(w.windows.length).toBeGreaterThan(0)
      for (const win of w.windows) expect(win.toMm).toBeGreaterThanOrEqual(win.fromMm)
      expect(w.robustIntervalWidthMm).toBeGreaterThanOrEqual(search.searchSpace.coarseStepMm)
    }
  })
})
