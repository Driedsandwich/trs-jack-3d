/**
 * `verifiedPhysical` の判定器を、**合成の記録**で試す。
 *
 * 実測が 1 件も来ていなくても、ここは全部確かめられる。
 * 止まるのは「本物の記録が入る」ところだけで、それは台帳へ 1 件足す差分でしかない。
 *
 * **変異は検査の外側から入れる。**判定器の内部定数をいじると、
 * 「その定数を読んでいること」しか確かめられない。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  GATE_VERSION, LEDGER_PATH, OBSERVATIONS, REQUIRED_FOR_PROFILE,
  checkRecord, evaluateGate, predictionsFromEvents,
} from '../scripts/measurementGate.mjs'

const ROOT = resolve(__dirname, '..')
const read = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))

/** 合成の記録。**通る形**を 1 つ作り、ここから 1 か所ずつ壊す */
function goodRecord(observation: string, valuesMm: number[]) {
  return {
    recordId: 'MR0001',
    observation,
    variantId: OBSERVATIONS[observation].variantId,
    measuredBy: 'synthetic-tester',
    measuredOn: '2026-08-06',
    instrument: { kind: 'digital-caliper', resolutionMm: 0.01 },
    parts: { jack: 'SYNTH-JACK', plug: 'SYNTH-PLUG' },
    valuesMm,
  }
}

const L = 'L_FIRST_CONTACT_SHOULDER_GAP_MM'
const PRED_L = 2.14
const ledgerOf = (records: unknown[]) => ({ schemaVersion: 1, gateVersion: GATE_VERSION, records })

describe('verifiedPhysical のゲート ① 記録が無ければ true にできない', () => {
  it('空の台帳では false（配布 profile 2 本とも）', () => {
    for (const v of ['TRS|JACK-TRS', 'TRS|JACK-TRRS']) {
      const g = evaluateGate({ ledger: ledgerOf([]), profileVariantId: v, predictions: {} })
      expect(g.verified, v).toBe(false)
      expect(g.missing.length, `${v}: 欠けている観測点が出ていない`).toBeGreaterThan(0)
    }
  })

  it('**実際の台帳も 0 件で false**（募集中で必須にしていないので、これが正しい状態）', () => {
    const ledger = read(LEDGER_PATH)
    expect(ledger.records, '台帳に記録が入ったらこのテストを書き換えること').toEqual([])
    expect(evaluateGate({ ledger, profileVariantId: 'TRS|JACK-TRRS', predictions: { [L]: PRED_L } }).verified).toBe(false)
  })

  it('必須観測点が定義されていない profile は false（空集合を合格にしない）', () => {
    const g = evaluateGate({ ledger: ledgerOf([]), profileVariantId: 'TRRS-CTIA|JACK-TRRS', predictions: {} })
    expect(g.verified).toBe(false)
    expect(g.missing.join(' ')).toContain('条文に無い')
  })
})

describe('verifiedPhysical のゲート ② 記録が揃えば true になる', () => {
  it('有効な記録 1 件で、TRRS profile が true になる', () => {
    const g = evaluateGate({
      ledger: ledgerOf([goodRecord(L, [2.13, 2.15, 2.14])]),
      profileVariantId: 'TRS|JACK-TRRS',
      predictions: { [L]: PRED_L },
    })
    expect(g.verified).toBe(true)
    expect(g.satisfied).toHaveLength(1)
    expect(g.satisfied[0].deltaMm).toBeLessThanOrEqual(OBSERVATIONS[L].toleranceMm)
  })

  it('TRS profile は 2 点そろって初めて true（1 点では false）', () => {
    const ring = goodRecord('RING_BREAK_OPEN_DEPTH_MM', [8.05, 8.07, 8.06])
    const tip = { ...goodRecord('TIP_BREAK_OPEN_DEPTH_MM', [12.01, 12.03, 12.02]), recordId: 'MR0002' }
    const pred = { RING_BREAK_OPEN_DEPTH_MM: 8.06, TIP_BREAK_OPEN_DEPTH_MM: 12.02 }
    expect(evaluateGate({ ledger: ledgerOf([ring]), profileVariantId: 'TRS|JACK-TRS', predictions: pred }).verified).toBe(false)
    expect(evaluateGate({ ledger: ledgerOf([ring, tip]), profileVariantId: 'TRS|JACK-TRS', predictions: pred }).verified).toBe(true)
  })

  it('**記録を 1 件消したら false へ落ちる**', () => {
    const ring = goodRecord('RING_BREAK_OPEN_DEPTH_MM', [8.05, 8.07, 8.06])
    const tip = { ...goodRecord('TIP_BREAK_OPEN_DEPTH_MM', [12.01, 12.03, 12.02]), recordId: 'MR0002' }
    const pred = { RING_BREAK_OPEN_DEPTH_MM: 8.06, TIP_BREAK_OPEN_DEPTH_MM: 12.02 }
    const full = [ring, tip]
    expect(evaluateGate({ ledger: ledgerOf(full), profileVariantId: 'TRS|JACK-TRS', predictions: pred }).verified).toBe(true)
    for (let i = 0; i < full.length; i++) {
      const cut = full.filter((_, j) => j !== i)
      const g = evaluateGate({ ledger: ledgerOf(cut), profileVariantId: 'TRS|JACK-TRS', predictions: pred })
      expect(g.verified, `${i} 件目を消しても true のまま`).toBe(false)
    }
  })
})

describe('verifiedPhysical のゲート ③ 変異を 1 か所ずつ入れて、1 件ずつ鳴ることを見る', () => {
  /**
   * **変異は記録側（検査の外側）から入れる。**
   * 判定器の中の定数を書き換えると「その定数を読んでいること」しか言えない。
   */
  const MUTATIONS: [string, (r: Record<string, unknown>) => void, string][] = [
    ['生値が 2 回しかない', (r) => { r.valuesMm = [2.13, 2.15] }, '3 回に満たない'],
    ['分解能が無い', (r) => { r.instrument = { kind: 'digital-caliper' } }, '分解能'],
    ['測った人が無い', (r) => { delete r.measuredBy }, 'measuredBy'],
    ['測定日の形が違う', (r) => { r.measuredOn = '2026/08/06' }, 'YYYY-MM-DD'],
    ['ジャックの型番が無い', (r) => { r.parts = { plug: 'SYNTH-PLUG' } }, 'parts.jack'],
    ['取り下げられている', (r) => { r.retracted = true }, '取り下げ'],
    ['variantId が観測点と違う', (r) => { r.variantId = 'TRS|JACK-TRS' }, 'variantId'],
    ['観測点が定義に無い', (r) => { r.observation = 'NOT_DEFINED' }, '定義されていない'],
    ['ばらつきが許容を超える', (r) => { r.valuesMm = [2.13, 2.15, 2.90] }, 'ばらつき'],
  ]

  it.each(MUTATIONS.map(([name, mutate, needle]) => [name, mutate, needle] as const))(
    '%s → 弾かれる',
    (_name, mutate, needle) => {
      const rec = goodRecord(L, [2.13, 2.15, 2.14]) as unknown as Record<string, unknown>
      // **変異前が通ることを、同じテストで確かめる**（もともと落ちる形を変異させても意味がない）
      expect(checkRecord(structuredClone(rec)).valid, '変異前の記録が既に無効').toBe(true)
      mutate(rec)
      const c = checkRecord(rec)
      expect(c.valid, '変異させたのに通っている').toBe(false)
      expect(c.reasons.join(' / '), '鳴った理由が違う').toContain(needle)
      expect(
        evaluateGate({ ledger: ledgerOf([rec]), profileVariantId: 'TRS|JACK-TRRS', predictions: { [L]: PRED_L } }).verified,
      ).toBe(false)
    },
  )

  it('予測から離れた実測は弾き、**モデルを直せと言う**', () => {
    const g = evaluateGate({
      ledger: ledgerOf([goodRecord(L, [0.68, 0.70, 0.69])]),
      profileVariantId: 'TRS|JACK-TRRS',
      predictions: { [L]: PRED_L },
    })
    expect(g.verified).toBe(false)
    expect(g.rejected[0].reasons.join(' ')).toContain('モデルのほうを直すこと')
  })

  it('現行モデルの予測が渡されないと満たせない（fail closed）', () => {
    const g = evaluateGate({
      ledger: ledgerOf([goodRecord(L, [2.13, 2.15, 2.14])]),
      profileVariantId: 'TRS|JACK-TRRS',
      predictions: {},
    })
    expect(g.verified).toBe(false)
    expect(g.rejected[0].reasons.join(' ')).toContain('予測が渡されていない')
  })
})

describe('verifiedPhysical のゲート ④ 配布物とつながっている', () => {
  it('配布 profile の verifiedPhysical が、いまの台帳の判定と一致する', () => {
    const ledger = read(LEDGER_PATH)
    for (const f of [
      'artifacts/half_plug_topology_profile.v3.trs_jack_trs.json',
      'artifacts/half_plug_topology_profile.v3.trs_jack_trrs.json',
    ]) {
      const p = read(f)
      const g = evaluateGate({ ledger, profileVariantId: p.variantId, predictions: {} })
      expect(p.modelLimitations.verifiedPhysical, f).toBe(g.verified)
      expect(p.modelLimitations.physicalVerificationRef, `${f}: 判定の根拠が書かれていない`).toContain(LEDGER_PATH)
      expect(p.modelLimitations.physicalVerificationRef).toContain(`required=${REQUIRED_FOR_PROFILE[p.variantId].join(',')}`)
    }
  })

  it('**リテラルの false ではない**（生成器が条文を読んでいる）', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/exportHalfPlugProfile.ts'), 'utf8')
    expect(src, 'リテラルへ戻っている').not.toMatch(/verifiedPhysical:\s*false/)
    expect(src).toContain('evaluateGate')
  })

  it('予測は event の identity から引く（label の文字列で引かない）', () => {
    const p = read('artifacts/half_plug_topology_profile.v3.trs_jack_trs.json')
    const pred = predictionsFromEvents(p.events, p.fullInsertionDepthMm)
    expect(pred.RING_BREAK_OPEN_DEPTH_MM).toBeTypeOf('number')
    expect(pred.TIP_BREAK_OPEN_DEPTH_MM).toBeTypeOf('number')
    // **label を変えても壊れないこと。**文字列で引いていたらここで落ちる
    const renamed = p.events.map((e: Record<string, unknown>) => ({ ...e, label: 'ラベルを変えた' }))
    expect(predictionsFromEvents(renamed, p.fullInsertionDepthMm)).toEqual(pred)
  })

  it('L の観測点は profile の event 列からは出せない（別 variant なので）', () => {
    const p = read('artifacts/half_plug_topology_profile.v3.trs_jack_trrs.json')
    expect(predictionsFromEvents(p.events, p.fullInsertionDepthMm)[L]).toBeUndefined()
  })
})
