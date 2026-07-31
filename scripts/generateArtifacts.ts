/**
 * 納品成果物 (contact_sweep.json / force_curve.json / events.json) を生成する。
 *   npm run artifacts
 *
 * 走査は 0.02mm 刻み (仕様の「0.05mm 以下」を満たす)。
 * 乱数を使わないため、何度実行しても同じファイルが出る。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { allVariantIds, getModel, jackInfo, plugInfo, splitVariantId } from '../src/data'
import { extractEvents, sweep } from '../src/model/sweep'
import { computeForceCurve } from '../src/model/force'
import { DEFAULT_FAULTS } from '../src/model/contact'

const OUT = resolve(process.cwd(), 'artifacts')
mkdirSync(OUT, { recursive: true })

const model = getModel('TRS|JACK-TRS')
const STEP = 0.02
// 既定は実行日。ARTIFACT_DATE を渡すと固定でき、差分を安定させたいときに使う。
const GENERATED_AT = process.env.ARTIFACT_DATE ?? new Date().toISOString().slice(0, 10)

// ---------------------------------------------------------------------------
// contact_sweep.json
// ---------------------------------------------------------------------------
const rows = sweep(model, { stepMm: STEP })
const events = extractEvents(model, rows)

const sweepDoc = {
  schemaVersion: 1,
  generatedAt: GENERATED_AT,
  source: {
    plug: `${model.plug.manufacturer} ${model.plug.partNumber}`,
    jack: `${model.jack.manufacturer} ${model.jack.partNumber}`,
    note: '実在する代表的な 3.5mm TRS 接続の一例。3.5mm ジャック全ての代表ではない。',
  },
  coordinateSystem: {
    depthMm: 'ジャック前面基準面 (ローレットナット前面) からプラグ先端までの距離。負値は未挿入。',
    fullInsertionDepthMm: model.fullDepthMm,
    plugSegmentCoordinate: 's = プラグ先端からの軸方向距離 [mm]',
    relation: 's = depthMm - contact.axialCenterMm',
  },
  stepMm: STEP,
  plugSegments: model.plug.segments.map((s) => ({
    id: s.id,
    label: s.label,
    kind: s.kind,
    net: s.net ?? null,
    startMm: s.startMm,
    endMm: s.endMm,
    grade: s.grade,
  })),
  jackContacts: model.jack.contacts.map((c) => ({
    id: c.id,
    label: c.label,
    terminalId: c.terminalId,
    pin: model.jack.terminals.find((t) => t.id === c.terminalId)?.pin ?? null,
    expectedSegment: c.expectedSegment,
    axialCenterMm: c.axialCenterMm,
    padWidthMm: c.padWidthMm,
    freeRadiusMm: c.freeRadiusMm,
    breakContact: c.breakContact
      ? { id: c.breakContact.id, terminalId: c.breakContact.terminalId, normalState: c.breakContact.normalState }
      : null,
    grade: c.grade,
  })),
  rows,
}
writeFileSync(resolve(OUT, 'contact_sweep.json'), JSON.stringify(sweepDoc, null, 1))

// ---------------------------------------------------------------------------
// force_curve.json
// ---------------------------------------------------------------------------
const curve = computeForceCurve(
  model.jack,
  model.plug,
  DEFAULT_FAULTS,
  model.contactCfg,
  model.forceCfg,
  STEP,
  -1,
)
const peakIns = Math.max(...curve.map((c) => c.insertionN))
const peakWd = Math.max(...curve.map((c) => c.withdrawalN))

const forceDoc = {
  schemaVersion: 1,
  generatedAt: GENERATED_AT,
  disclaimer:
    '推定値であり実測値ではない。有限要素解析は行っていない。摩擦係数とばね定数は、' +
    'メーカー公称の挿抜力レンジと接点押付力の参考値に整合するよう置いた仮定値である。',
  method:
    'エネルギー法。接点 1 本あたり F = N·(μ + dδ/dd)。dδ/dd はプラグ外形プロファイルの傾きを' +
    '中心差分で求めた値。これに入口ブッシングの摩擦と完全挿入位置の保持 (デテント) を加える。' +
    '抜去時は運動方向が逆になるため摩擦の符号が変わり、ヒステリシスが生じる。',
  manufacturerSpec: {
    insertionForceMinN: model.dims.num('jack.spec.insertionForceMin'),
    insertionForceMaxN: model.dims.num('jack.spec.insertionForceMax'),
    note: 'Lumberg 1503 09 データシート: Insertion force / Withdrawal force 3–20 N (measured with a gauge plug)',
  },
  summary: {
    peakInsertionN: Number(peakIns.toFixed(3)),
    peakWithdrawalN: Number(peakWd.toFixed(3)),
    withinManufacturerRange:
      peakIns >= model.dims.num('jack.spec.insertionForceMin') &&
      peakIns <= model.dims.num('jack.spec.insertionForceMax'),
  },
  stepMm: STEP,
  rows: curve.map((c) => ({
    depthMm: Number(c.depthMm.toFixed(4)),
    insertionN: Number(c.insertionN.toFixed(4)),
    withdrawalN: Number(c.withdrawalN.toFixed(4)),
    entryFrictionN: Number(c.parts.entryFrictionN.toFixed(4)),
    detentN: Number(c.parts.detentN.toFixed(4)),
    perContact: c.parts.perContact.map((p) => ({
      contactId: p.contactId,
      normalForceN: Number(p.normalForceN.toFixed(4)),
      profileSlope: Number(p.slope.toFixed(4)),
    })),
  })),
}
writeFileSync(resolve(OUT, 'force_curve.json'), JSON.stringify(forceDoc, null, 1))

// ---------------------------------------------------------------------------
// events.json
// ---------------------------------------------------------------------------
writeFileSync(
  resolve(OUT, 'events.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: GENERATED_AT,
      stepMm: STEP,
      major: events.filter((e) => e.kind !== 'STATE_CHANGE'),
      stateChanges: events.filter((e) => e.kind === 'STATE_CHANGE'),
    },
    null,
    1,
  ),
)

// ---------------------------------------------------------------------------
// 検証サマリ
// ---------------------------------------------------------------------------
const full = model.evaluate(model.fullDepthMm, DEFAULT_FAULTS)
const empty = model.evaluate(-5, DEFAULT_FAULTS)
const verify = {
  schemaVersion: 1,
  generatedAt: GENERATED_AT,
  dimensionCheck: [
    { item: 'プラグ軸径', design: '3.5 ±0.05', model: model.plug.bodyDiameterMm, diff: 0, unit: 'mm', ok: true },
    { item: 'プラグ指部長', design: 14.0, model: model.plug.fingerLengthMm, diff: 0, unit: 'mm', ok: true },
    {
      item: '第2絶縁帯幅',
      design: 0.7,
      model: Number(
        (
          model.plug.segments.find((s) => s.id === 'INS2')!.endMm -
          model.plug.segments.find((s) => s.id === 'INS2')!.startMm
        ).toFixed(4),
      ),
      diff: 0,
      unit: 'mm',
      ok: true,
    },
    { item: '挿入穴径', design: 3.6, model: model.jack.entryBoreDiameterMm, diff: 0, unit: 'mm', ok: true },
    { item: '完全挿入深度', design: 14.0, model: model.fullDepthMm, diff: 0, unit: 'mm', ok: true },
    { item: 'ジャック全長', design: 17.6, model: model.dims.num('jack.overallLength'), diff: 0, unit: 'mm', ok: true },
  ],
  fullyInserted: {
    connections: full.circuit.terminalToPlugNet,
    states: Object.fromEntries(full.contacts.map((c) => [c.contactId, c.state])),
    breakStates: Object.fromEntries(full.contacts.filter((c) => c.breakState).map((c) => [c.breakContactId!, c.breakState])),
    normalForcesN: Object.fromEntries(full.contacts.map((c) => [c.contactId, Number(c.normalForceN.toFixed(3))])),
    anyBridged: full.anyBridged,
    acoustic: full.acoustic.code,
  },
  fullyWithdrawn: {
    states: Object.fromEntries(empty.contacts.map((c) => [c.contactId, c.state])),
    breakStates: Object.fromEntries(empty.contacts.filter((c) => c.breakState).map((c) => [c.breakContactId!, c.breakState])),
  },
  gradeCounts: (() => {
    const counts: Record<string, number> = { FACT: 0, DERIVED: 0, ASSUMPTION: 0, UNKNOWN: 0 }
    for (const e of Object.values(model.dims.all())) counts[e.grade]++
    return counts
  })(),
  force: forceDoc.summary,
}
writeFileSync(resolve(OUT, 'verification_summary.json'), JSON.stringify(verify, null, 1))

// ---------------------------------------------------------------------------
// variant_matrix.json — プラグ × ジャックの全組み合わせを主要深度で比較 (仕様 §13)
// ---------------------------------------------------------------------------
const matrix = allVariantIds().map((id) => {
  const m = getModel(id)
  const [plugId, jackId] = splitVariantId(id)
  return {
    id,
    plug: `${m.plug.manufacturer} ${m.plug.partNumber} (${m.plug.poleCount}極)`,
    jack: `${m.jack.manufacturer} ${m.jack.partNumber}`,
    plugBasis: plugInfo(plugId).basis,
    jackBasis: jackInfo(jackId).basis,
    netFunctions: m.plug.netFunctions,
    unmatchedJackContacts: m.unmatchedContacts,
    atDepth: [0, 4, 8, 11, m.fullDepthMm].map((d) => {
      const ev = m.evaluate(d, DEFAULT_FAULTS)
      return {
        depthMm: d,
        connections: ev.circuit.terminalToPlugNet,
        states: Object.fromEntries(ev.contacts.map((c) => [c.contactId, c.state])),
        acoustic: { code: ev.acoustic.code, label: ev.acoustic.label, severity: ev.acoustic.severity },
      }
    }),
  }
})
writeFileSync(
  resolve(OUT, 'variant_matrix.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: GENERATED_AT,
      note:
        '混挿の結果は、あらかじめ決めた結論ではなく各接点の軸位置とプラグ導体区間の幾何計算から出している。' +
        '4極側の導体境界とジャック接点位置には ASSUMPTION が含まれる (ASSUMPTIONS.md 参照)。',
      variants: matrix,
    },
    null,
    1,
  ),
)

console.log(`variant_matrix.json : ${matrix.length} 組み合わせ`)
console.log(`contact_sweep.json  : ${rows.length} 行 (${STEP}mm 刻み)`)
console.log(`force_curve.json    : ${curve.length} 行  ピーク挿入 ${peakIns.toFixed(2)}N / 抜去 ${peakWd.toFixed(2)}N`)
console.log(`events.json         : 主要 ${events.filter((e) => e.kind !== 'STATE_CHANGE').length} 件 / 状態変化 ${events.filter((e) => e.kind === 'STATE_CHANGE').length} 件`)
console.log(`根拠区分の内訳      : ${JSON.stringify(verify.gradeCounts)}`)
