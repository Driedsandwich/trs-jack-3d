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
  CLAIM_SCOPE, GATE_VERSION, LEDGER_PATH, OBSERVATIONS, REQUIRED_FOR_PROFILE, RESOLUTION_DIVISOR,
  checkRecord, evaluateGate, predictionsForValidation, predictionsFromEvents,
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

/**
 * **条文 v2（2026-08-06）。外部監査が出した反例を、こちらで再現してから直した分。**
 *
 * v1 は一致する記録を 1 件見つけた時点で `break` していたので、
 * ①矛盾する記録があっても `true` ②同じ台帳でも並び順で `rejected` の中身が変わる
 * ③分解能 1.0 mm の測定器が許容 0.29 mm の判定を通る、の 3 つが起きていた。
 *
 * **材料は「壊れた記録」ではなく「読めるが認定してはいけない記録」である。**
 * 壊れた記録で試すと、v1 でも弾けたものしか試さないことになる。
 */
describe('verifiedPhysical のゲート ⑤ 条文 v2 — 相反・分解能・主張の範囲', () => {
  const runL = (records: unknown[]) => evaluateGate({
    ledger: ledgerOf(records), profileVariantId: 'TRS|JACK-TRRS', predictions: { [L]: PRED_L },
  })
  /** モデルの予測と合う記録 */
  const agrees = { ...goodRecord(L, [2.13, 2.15, 2.14]), recordId: 'MR0001' }
  /** **読める記録なのに**モデルと 1.45 mm 食い違う（実在部品 PS000001 由来の予測と同じ値） */
  const disagrees = { ...goodRecord(L, [0.68, 0.70, 0.69]), recordId: 'MR0002' }

  it('対照 — 一致する記録だけなら、v1 と同じく true になる', () => {
    expect(checkRecord(agrees).valid, '材料の記録がそもそも無効').toBe(true)
    expect(checkRecord(disagrees).valid, '**矛盾する記録も「読める記録」でなければ反例にならない**').toBe(true)
    expect(runL([agrees]).verified).toBe(true)
  })

  it('**一致と矛盾が併存したら true にしない**（v1 は true だった）', () => {
    for (const order of [[agrees, disagrees], [disagrees, agrees]]) {
      const g = runL(order)
      expect(g.verified, '矛盾する記録があるのに検証済みを名乗っている').toBe(false)
      expect(g.verdict).toBe('AMBIGUOUS')
      expect(g.ambiguous).toContain(L)
    }
  })

  it('**並び順で結果が変わらない**（v1 は rejected の中身が変わった）', () => {
    expect(runL([agrees, disagrees])).toEqual(runL([disagrees, agrees]))
    // 3 件でも同じ。**全順列で同一**
    const third = { ...goodRecord(L, [2.14, 2.14, 2.14]), recordId: 'MR0003' }
    const perms = [
      [agrees, disagrees, third], [agrees, third, disagrees], [disagrees, agrees, third],
      [disagrees, third, agrees], [third, agrees, disagrees], [third, disagrees, agrees],
    ]
    const first = JSON.stringify(runL(perms[0]))
    for (const p of perms) expect(JSON.stringify(runL(p)), '並び順で結果が変わった').toBe(first)
  })

  it('**取り下げれば矛盾は数えない**（消さずに残したまま決着できる）', () => {
    const withdrawn = { ...disagrees, retracted: true, retractedReason: '別個体と取り違えた' }
    const g = runL([agrees, withdrawn])
    expect(g.verified).toBe(true)
    expect(g.retracted.map((r) => r.recordId)).toEqual(['MR0002'])
    // **取り下げは「壊れた記録」ではない。**理由つきで残る
    expect(g.rejected.map((r) => r.recordId)).not.toContain('MR0002')
    expect(g.retracted[0].reason).toContain('取り違えた')
  })

  it('**分解能が許容に対して粗い記録では認定しない**（v1 は 1.0 mm が通った）', () => {
    const coarse = { ...goodRecord(L, [2, 2, 2]), instrument: { kind: 'ものさし', resolutionMm: 1 } }
    expect(checkRecord(coarse).valid, '記録としては読める').toBe(true)
    expect(checkRecord(coarse).certifiable, '認定してはいけない').toBe(false)
    const g = runL([coarse])
    expect(g.verified).toBe(false)
    expect(g.notCertified).toHaveLength(1)
    // **矛盾扱いにはしない。**1 mm の目盛で 2.0 と読めたことは 2.14 と矛盾しない
    expect(g.conflicting).toHaveLength(0)
  })

  it('必要な分解能は許容から導く（手で書いた値ではない）', () => {
    for (const [id, o] of Object.entries(OBSERVATIONS)) {
      expect(o.maxResolutionMm, `${id}: 許容の 1/${RESOLUTION_DIVISOR} を超えている`)
        .toBeLessThanOrEqual(o.toleranceMm / RESOLUTION_DIVISOR + 1e-12)
      expect(o.maxResolutionMm, `${id}: 分解能の要求が 0 以下`).toBeGreaterThan(0)
    }
    // **募集している道具が弾かれないこと。**デジタルノギス 0.01 mm は全観測点で通る
    for (const [id, o] of Object.entries(OBSERVATIONS)) {
      expect(0.01, `${id}: デジタルノギスが弾かれる`).toBeLessThanOrEqual(o.maxResolutionMm)
    }
  })

  it('**分解能の目盛に乗っていない生値は認定しない**（その測定器では読めない値）', () => {
    const offGrid = { ...goodRecord(L, [2.143, 2.14, 2.14]) }
    expect(checkRecord(offGrid).certifiable).toBe(false)
    expect(checkRecord(offGrid).notCertifiableReasons.join(' ')).toContain('目盛に乗っていない')
    expect(runL([offGrid]).verified).toBe(false)
    // 対照: 目盛に乗っている値なら通る
    expect(checkRecord(goodRecord(L, [2.13, 2.15, 2.14])).certifiable).toBe(true)
  })

  it('**粗い測定器でもモデルとの食い違いは検出する**（認定できないことと矛盾を見逃すことは別）', () => {
    const coarseAndWrong = { ...goodRecord(L, [0.7, 0.7, 0.7]), instrument: { kind: 'ものさし', resolutionMm: 0.1 } }
    const g = runL([coarseAndWrong])
    expect(g.verified).toBe(false)
    expect(g.conflicting, '粗い測定器だからと矛盾を捨てている').toHaveLength(1)
    expect(g.conflicting[0].reasons.join(' ')).toContain('モデルのほうを直すこと')
  })

  it('食い違いの判定には測定器の不確かさを足す（粗いだけでモデルが誤りにならない）', () => {
    // 分解能 0.5 mm で 2.5 と読めた。予測 2.14 との差 0.36 は許容 0.29 を超えるが、
    // 目盛の量子化 ±0.25 を足した 0.54 の内側なので**矛盾とは言わない**
    const coarseNear = { ...goodRecord(L, [2.5, 2.5, 2.5]), instrument: { kind: 'ものさし', resolutionMm: 0.5 } }
    const g = runL([coarseNear])
    expect(g.conflicting, '測定器の粗さでモデルを誤りにしている').toHaveLength(0)
    expect(g.verified, 'それでも認定はしない').toBe(false)
  })

  it('**recordId が重複した台帳は判定ごと拒む**（根拠が一意に指せない）', () => {
    const g = runL([agrees, { ...agrees, valuesMm: [2.14, 2.14, 2.14] }])
    expect(g.verdict).toBe('INVALID_LEDGER')
    expect(g.verified).toBe(false)
    expect(g.duplicateRecordIds).toEqual(['MR0001'])
    // 対照: ID を分ければ通る
    expect(runL([agrees, { ...agrees, recordId: 'MR0009' }]).verified).toBe(true)
  })

  it('**何を主張しているかを出力に持つ**（接点トポロジーも音響も含まない）', () => {
    const g = runL([agrees])
    expect(g.verified).toBe(true)
    expect(g.claimScope).toBe(CLAIM_SCOPE)
    expect(CLAIM_SCOPE).toBe('geometry-only')
    for (const notCovered of ['target-topology', 'acoustic', 'lot-variation']) {
      expect(g.notCoveredByThisClaim, `${notCovered} が「含まない」側に無い`).toContain(notCovered)
    }
    // **判定に使った記録を指せる**
    expect(g.decidedBy).toEqual(['MR0001'])
  })

  it('主張の範囲は配布 profile にも書いてある', () => {
    for (const f of [
      'artifacts/half_plug_topology_profile.v3.trs_jack_trs.json',
      'artifacts/half_plug_topology_profile.v3.trs_jack_trrs.json',
    ]) {
      expect(read(f).modelLimitations.physicalVerificationRef, f).toContain(`scope=${CLAIM_SCOPE}`)
    }
  })

  it('**L の必須観測点は配布 profile とは別 variant である**ことが条文に書いてある', () => {
    // 監査が「claim scope が広い」と言った実体。**書いてあることを機械で固定する**
    expect(OBSERVATIONS[L].variantId).toBe('TRRS-CTIA|JACK-TRRS')
    expect(REQUIRED_FOR_PROFILE['TRS|JACK-TRRS']).toEqual([L])
    expect(OBSERVATIONS[L].variantId, '同じ variant なら claim scope の断りは要らない')
      .not.toBe('TRS|JACK-TRRS')
    const doc = readFileSync(resolve(ROOT, 'docs/VERIFIED_PHYSICAL_GATE.md'), 'utf8')
    expect(doc).toContain('TRRS-CTIA|JACK-TRRS')
    expect(doc, '条文が主張の範囲を書いていない').toContain('geometry-only')
  })

  it('条文の版が実装・台帳・生成物で揃っている', () => {
    expect(GATE_VERSION).toBe(2)
    expect(read(LEDGER_PATH).gateVersion, '台帳の gateVersion が実装とずれている').toBe(GATE_VERSION)
    for (const f of [
      'artifacts/half_plug_topology_profile.v3.trs_jack_trs.json',
      'artifacts/half_plug_topology_profile.v3.trs_jack_trrs.json',
    ]) {
      expect(read(f).modelLimitations.physicalVerificationRef, f).toContain(`@v${GATE_VERSION}`)
    }
  })
})


/**
 * **v0.6.2（外部監査 2026-08-06 の P0-3）。**
 *
 * `validateProfiles` は plain node なのでモデル（TypeScript）を読めない。
 * v0.6.1 まではそのため `predictions: {}` で判定を呼び、
 * **「予測が渡されていない」を「まだ true を名乗ってよい」と読み替えていた。**
 *
 * 実測: モデルの予測 2.14 mm と 1.45 mm 食い違う記録が台帳にあっても
 * `couldBeVerified = true` になり、手で `verifiedPhysical: true` にした profile を
 * この規則では拒めなかった。
 */
describe('verifiedPhysical のゲート ⑥ 配布 profile だけから予測を作り直す', () => {
  const trrs = read('artifacts/half_plug_topology_profile.v3.trs_jack_trrs.json')
  const trs = read('artifacts/half_plug_topology_profile.v3.trs_jack_trs.json')

  it('配布 profile だけで、必須観測点の予測が全部そろう', () => {
    for (const p of [trs, trrs]) {
      const { predictions, problems } = predictionsForValidation(p)
      expect(problems, `${p.variantId}: 問題が出ている`).toEqual([])
      for (const id of REQUIRED_FOR_PROFILE[p.variantId]) {
        expect(predictions[id], `${p.variantId}: ${id} の予測を作り直せない`).toBeTypeOf('number')
      }
    }
  })

  it('**event 列から計算し直せるものは、記録値との一致を要求する**', () => {
    const tampered = structuredClone(trrs)
    const ref = tampered.modelLimitations.physicalVerificationRef as string
    const m = /RING_BREAK_OPEN_DEPTH_MM:([0-9.]+)/.exec(ref)
    expect(m, '記録された予測が見つからない').toBeTruthy()
    tampered.modelLimitations.physicalVerificationRef = ref.replace(m![0], 'RING_BREAK_OPEN_DEPTH_MM:9.99')
    const { problems } = predictionsForValidation(tampered)
    expect(problems.join(' '), '記録の書き換えを検出できていない').toContain('計算し直した')
  })

  it('**記録が無ければ満たせない**（旧形式の profile を検証済みにしない）', () => {
    const old = structuredClone(trrs)
    old.modelLimitations.physicalVerificationRef =
      (old.modelLimitations.physicalVerificationRef as string).replace(/ predicted=[^ ]*/, '')
    const { problems } = predictionsForValidation(old)
    expect(problems.length, '記録が無いのに問題が出ていない').toBeGreaterThan(0)
    expect(problems.join(' ')).toContain('記録されていない')
  })

  it('**矛盾する記録があれば true を拒める**（v0.6.1 は拒めなかった）', () => {
    const { predictions } = predictionsForValidation(trrs)
    const bad = ledgerOf([{ ...goodRecord(L, [0.68, 0.70, 0.69]), recordId: 'MR9001' }])
    const g = evaluateGate({ ledger: bad, profileVariantId: trrs.variantId, predictions })
    expect(g.verified).toBe(false)
    expect(g.conflicting).toHaveLength(1)
    const couldBeVerified = g.verified || g.rejected.some((r) => r.reasons.some((x) => x.includes('予測が渡されていない')))
    expect(couldBeVerified, '「予測が無いから true でよい」に戻っている').toBe(false)
  })

  it('対照 — 一致する記録なら、これまでどおり true になる', () => {
    const { predictions } = predictionsForValidation(trrs)
    const ok = ledgerOf([{ ...goodRecord(L, [2.13, 2.15, 2.14]), recordId: 'MR9002' }])
    const g = evaluateGate({ ledger: ok, profileVariantId: trrs.variantId, predictions })
    expect(g.verified).toBe(true)
    expect(g.verdict).toBe('VERIFIED')
  })

  it('**生成器は宣言外のファイルを読まない**（v0.6.2 の依存を外した）', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/exportHalfPlugProfile.ts'), 'utf8')
    // **コメントは除いて、実際に読んでいる箇所だけを見る**（説明文に名前が出るのは構わない）
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
    expect(code, '宣言外の artifact を直接読んでいる')
      .not.toMatch(/readFileSync\([^)]*real_jack_comparison/)
    expect(code, '判定に使った予測を記録していない').toContain('predicted=')
  })

  it('validator が空の予測で判定を呼んでいない（読み替えの経路が残っていない）', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/validateProfiles.mjs'), 'utf8')
    expect(src, '空の予測で呼ぶ経路が残っている').not.toMatch(/evaluateGate\(\{[^}]*predictions:\s*\{\}/)
    expect(src).toContain('predictionsForValidation')
  })
})
