/**
 * 目標トポロジー `ground-open-differential` の頑健性。
 * 非阻害フォローアップオーダー（2026-08-03）P1-4 に対応する。
 *
 * ## 何が足りなかったか
 *
 * `artifacts/sensitivity.*.json` が測っているのは**イベントが起きる深さの幅**で、
 * 帰線接点の軸位置とパッド幅の 2 軸しか振っていない。
 * Half-Plug Lab が知りたいのは「**目標がそもそも存在するか**」で、これは別の量である。
 * 深さの幅が安定していても、Tip 接点位置を動かしたら区間ごと消えるなら頑健とは言えない。
 *
 * ## この試験の主眼は「空振りの検出」
 *
 * 動かないキーを「振った」と数えると、同じ構成を何百回も繰り返すだけの空振りになり、
 * **「その仮定は結論に影響しない」という誤った結論が出る。**
 * artifact に記録された軸を**そのまま読んで**、実際にモデルが変わることを毎回確かめる。
 *
 * `beamOffset` は実際にこの罠だった（下の「単独キーでは効かない」試験）。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildModelWithOverrides, getModel } from '../src/data'
import { DEFAULT_FAULTS } from '../src/model/contact'
import { sweep } from '../src/model/sweep'
import { classifyFromEvaluation } from '../src/model/topology'
import type { TrsModel } from '../src/model/engine'
import { mustBeNonEmpty, mustFind } from './_must'

const ROOT = resolve(__dirname, '..')
const J = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))

const rob = J('artifacts/topology-robustness.trs_jack_trrs.json')
const sens = J('artifacts/sensitivity.trs_jack_trrs.json')
const profile = J('artifacts/half_plug_topology_profile.v2.trs_jack_trrs.json')
const V = 'TRS|JACK-TRRS' as const

/** 走査は 0.05 で足りる。存否ではなく「列が変わるか」を見るため */
const topologySequence = (m: TrsModel) =>
  sweep(m, { stepMm: 0.05 })
    .filter((r) => r.depthMm >= 0)
    .map((r) => classifyFromEvaluation(m.jack.terminals, m.plug.netFunctions, m.evaluate(r.depthMm, DEFAULT_FAULTS)).topologyClass)
    .join(',')

const TERMINAL: Record<string, number> = { tip: 11.3, ring1: 7.5, ring2: 4.74 }

/** artifact に記録された軸定義から、その水準の上書きを組み立てる */
function overridesFor(name: string, level: number): Record<string, number> {
  const r = rob.parameterRanges[name]
  if (name === 'beamOffset')
    return Object.fromEntries(r.keys.map((k: string) => {
      const id = mustFind(Object.keys(TERMINAL), (x) => k.includes(`.${x}.`), `${k} の接点 ID`)
      return [k, +(TERMINAL[id] - level).toFixed(4)]
    }))
  if (name.endsWith('.axialCenterDelta')) {
    const id = mustFind(Object.keys(TERMINAL), (x) => name.includes(`.${x}.`), `${name} の接点 ID`)
    return { [r.keys[0]]: +(TERMINAL[id] + level).toFixed(4) }
  }
  if (name === 'plug.ringBandShift')
    return {
      'plug.ins1.end': +(5.5 + level).toFixed(4),
      'plug.ring.start': +(5.5 + level).toFixed(4),
      'plug.ring.end': +(8.3 + level).toFixed(4),
      'plug.ins2.start': +(8.3 + level).toFixed(4),
    }
  return { [r.keys[0]]: level }
}

describe('走査軸が空振りしていない', () => {
  const baseSeq = topologySequence(getModel(V))

  for (const name of rob.sweptParameters as string[]) {
    it(`${name}: 動かすとモデルが実際に変わる`, () => {
      const r = rob.parameterRanges[name]
      const alts = mustBeNonEmpty(
        (r.levels as number[]).filter((lv) => lv !== r.shipped),
        `${name} の既定値以外の水準`,
      )
      const changed = alts.some((lv) => {
        try {
          return topologySequence(buildModelWithOverrides(V, overridesFor(name, lv))) !== baseSeq
        } catch {
          return false
        }
      })
      expect(changed, `${name} はどの水準でもトポロジー列を変えない（空振りの軸）`).toBe(true)
    })

    it(`${name}: 既定値が水準に入っている`, () => {
      // 入っていないと「無改造で成立するか」を一度も評価しないまま報告してしまう
      expect(rob.parameterRanges[name].levels).toContain(rob.parameterRanges[name].shipped)
    })
  }

  it('**`beamOffset` は単独キーでは効かない**（複合軸にしている理由）', () => {
    // 接点位置は「端子位置 − beamOffset」を計算済みの別項目として持っており、
    // beamOffset 自身はどこからも読まれていない。
    // 素直にキーを振ると「beamOffset は結論に影響しない」と出てしまう。
    const base = topologySequence(getModel(V))
    for (const b of [0.65, 1.3])
      expect(topologySequence(buildModelWithOverrides(V, { 'trrs.jack.contact.beamOffset': b }))).toBe(base)
    // 一方、3 接点を連動させれば動く
    expect(topologySequence(buildModelWithOverrides(V, overridesFor('beamOffset', 1.3)))).not.toBe(base)
    expect(rob.parameterRanges.beamOffset.compound).toBe(true)
    expect(rob.parameterRanges.beamOffset.keys).toHaveLength(3)
  })
})

describe('オーダーが要求した項目が揃っている', () => {
  for (const k of [
    'variantId', 'targetTopologyClass', 'basis', 'sweptParameters', 'parameterRanges',
    'configurationsTotal', 'configurationsUsable', 'configurationsWithTarget',
    'presenceFractionWithinConstructedSweep', 'intervalWidthMm',
    'counterExamples', 'necessaryConditions', 'sourceEvidenceBoundary', 'physicalProbabilityClaim',
  ])
    it(`${k} がある`, () => expect(rob[k]).toBeDefined())

  it('Tip 位置・beam offset・主要接点位置がすべて軸に入っている', () => {
    const axes = rob.sweptParameters as string[]
    expect(axes).toContain('beamOffset')
    expect(axes).toContain('trrs.jack.contact.tip.axialCenterDelta')
    expect(axes).toContain('trrs.jack.contact.ring1.axialCenterDelta')
    expect(axes).toContain('trrs.jack.contact.ring2.axialCenterDelta')
    expect(axes).toContain('trrs.jack.contact.sleeve.axialCenter')
  })

  it('走査範囲の根拠と任意性が書いてある', () => {
    const basis = (rob.searchRangeBasis as string[]).join('\n')
    expect(basis).toContain('任意')
  })
})

describe('主張の境界を越えていない', () => {
  it('**実物の確率を主張していない**', () => {
    expect(rob.physicalProbabilityClaim).toBe(false)
    expect(rob.basis).toBe('MODEL_PARAMETER_SWEEP')
    const notes = (rob.notes as string[]).join('\n')
    expect(notes).toContain('実物の確率ではない')
  })

  it('実測はまだ入っていない（model sweep と混ぜない）', () => {
    expect(rob.empiricalEvidence).toBeNull()
    expect(profile.modelLimitations.verifiedPhysical).toBe(false)
  })

  it('**イベント深さの幅とは別物として保持されている**', () => {
    // 同じ軸を振っただけの焼き直しなら、別の artifact にする意味が無い
    const robAxes = new Set(rob.sweptParameters as string[])
    const sensAxes = sens.sweptParameters as string[]
    expect(sensAxes.every((a) => robAxes.has(a))).toBe(true)
    expect(robAxes.size).toBeGreaterThan(sensAxes.length)
    expect((rob.notes as string[]).join('\n')).toContain('別の量')
  })
})

describe('反対証拠を落としていない', () => {
  it('**PS000001 の図面値では目標が消える**', () => {
    const ce = mustFind(
      rob.counterExamples as { kind: string; targetPresent: boolean; overrides: Record<string, number> }[],
      (c) => c.kind === 'REAL_PART_DRAWING',
      '実在部品の図面による反対証拠',
    )
    expect(ce.targetPresent).toBe(false)
    // artifact の記録を信じず、その場で再現する
    const m = buildModelWithOverrides(V, ce.overrides)
    const rows = sweep(m, { stepMm: rob.stepMm }).filter((r) => r.depthMm >= 0)
    const hit = rows.filter(
      (r) => classifyFromEvaluation(m.jack.terminals, m.plug.netFunctions, m.evaluate(r.depthMm, DEFAULT_FAULTS)).topologyClass === rob.targetTopologyClass,
    )
    expect(hit).toHaveLength(0)
  })

  it('切り捨てた件数を黙っていない', () => {
    const s = rob.counterExampleSampling
    expect(s.modelSweepSamplesListed + s.omitted).toBe(s.absentConfigurationsTotal)
    expect(s.absentConfigurationsTotal).toBe(rob.configurationsUsable - rob.configurationsWithTarget)
  })
})

describe('数と主張が食い違わない', () => {
  it('構成の内訳が走査総数と合う', () => {
    expect(rob.configurationsUsable + rob.configurationsBuildFailed + rob.configurationsFullInsertionNotOk)
      .toBe(rob.configurationsTotal)
  })

  it('水準ごとの内訳が全体と合う', () => {
    for (const [name, levels] of Object.entries(rob.presenceByLevel as Record<string, { configurationsUsable: number; configurationsWithTarget: number }[]>)) {
      expect(levels.reduce((s, x) => s + x.configurationsUsable, 0), `${name} の成立数`).toBe(rob.configurationsUsable)
      expect(levels.reduce((s, x) => s + x.configurationsWithTarget, 0), `${name} の目標あり`).toBe(rob.configurationsWithTarget)
    }
  })

  it('**necessaryConditions が内訳と矛盾しない**', () => {
    for (const c of rob.necessaryConditions as { parameter: string; levelsWhereTargetNeverAppears: number[] }[])
      for (const lv of c.levelsWhereTargetNeverAppears) {
        const row = mustFind(
          rob.presenceByLevel[c.parameter] as { level: number; configurationsWithTarget: number }[],
          (x) => x.level === lv,
          `${c.parameter} の水準 ${lv}`,
        )
        expect(row.configurationsWithTarget).toBe(0)
      }
  })

  it('0 件の水準を条件として書き落としていない', () => {
    for (const [name, levels] of Object.entries(rob.presenceByLevel as Record<string, { level: number; configurationsUsable: number; configurationsWithTarget: number }[]>))
      for (const x of levels)
        if (x.configurationsUsable > 0 && x.configurationsWithTarget === 0) {
          const listed = (rob.necessaryConditions as { parameter: string; levelsWhereTargetNeverAppears: number[] }[])
            .some((c) => c.parameter === name && c.levelsWhereTargetNeverAppears.includes(x.level))
          expect(listed, `${name} の水準 ${x.level} は目標 0 件なのに necessaryConditions に無い`).toBe(true)
        }
  })
})

describe('profile と食い違わない', () => {
  it('無改造の区間が profile の該当区間と一致する', () => {
    // ここがずれていたら、頑健性 artifact は別のモデルの話をしている
    const iv = mustFind(
      profile.intervals as { intervalId: string; nominalStartMm: number; nominalEndMm: number; electricalTopology: { topologyClass: string } }[],
      (x) => x.electricalTopology.topologyClass === rob.targetTopologyClass,
      `profile の ${rob.targetTopologyClass} 区間`,
    )
    const w = mustBeNonEmpty(rob.nominalConfiguration.windows as { fromMm: number; toMm: number }[], '無改造の区間')
    expect(rob.nominalConfiguration.targetPresent).toBe(true)
    expect(w[0].fromMm).toBeCloseTo(iv.nominalStartMm, 4)
    // 走査は最後に当たった標本を持つので、区間の終わりは 1 刻み先
    expect(+(w[0].toMm + rob.stepMm).toFixed(4)).toBeCloseTo(iv.nominalEndMm, 4)
  })

  it('区間の evidenceGrade は上がっていない', () => {
    // 頑健性を測ったからといって、仮定が事実になるわけではない
    const iv = mustFind(
      profile.intervals as { evidenceGrade: string; electricalTopology: { topologyClass: string } }[],
      (x) => x.electricalTopology.topologyClass === rob.targetTopologyClass,
      `profile の ${rob.targetTopologyClass} 区間`,
    )
    expect(iv.evidenceGrade).toBe('ASSUMPTION')
  })
})
