/**
 * モデルの挙動を素早く確認するための開発用スクリプト。
 *   npx vite-node scripts/inspect.ts
 */
import { getModel } from '../src/data'
import { sweep, extractEvents } from '../src/model/sweep'
import { computeForceCurve } from '../src/model/force'
import { DEFAULT_FAULTS } from '../src/model/contact'

const model = getModel('TRS|JACK-TRS')

console.log('=== モデル基本 ===')
console.log('完全挿入深度:', model.fullDepthMm, 'mm')
console.log('プラグ指部長:', model.plug.fingerLengthMm, 'mm')
console.log(
  'セグメント:',
  model.plug.segments.map((s) => `${s.id} ${s.startMm.toFixed(3)}-${s.endMm.toFixed(3)}`).join(' | '),
)
console.log(
  '接点:',
  model.jack.contacts
    .map((c) => `${c.id} @${c.axialCenterMm} w${c.padWidthMm} r${c.freeRadiusMm}`)
    .join(' | '),
)

console.log('\n=== 主要深度での状態 ===')
for (const d of [0, 3, 4.5, 6, 8.1, 8.35, 9.8, 11.4, 11.85, 12.5, 13.5, 14]) {
  const ev = model.evaluate(d, DEFAULT_FAULTS)
  const parts = ev.contacts.map(
    (c) =>
      `${c.contactId.replace('JC_', '')}:${c.state}${c.connectedNets.length ? '(' + c.connectedNets.join('+') + ')' : ''}${c.breakState ? '/' + (c.breakState === 'BREAK_OPEN' ? 'SW-OPEN' : 'SW-CL') : ''}`,
  )
  console.log(
    `d=${d.toFixed(2).padStart(5)}  ${parts.join('  ')}  => ${ev.acoustic.code}  F=${ev.estimatedForceN.toFixed(2)}N`,
  )
}

console.log('\n=== イベント (主要のみ) ===')
const rows = sweep(model, { stepMm: 0.01 })
const events = extractEvents(model, rows).filter((e) => e.kind !== 'STATE_CHANGE')
for (const e of events) console.log(`${e.depthMm.toFixed(2).padStart(6)} mm  ${e.kind}  ${e.label}`)

console.log('\n=== 状態変化 (接点ごと) ===')
const changes = extractEvents(model, rows).filter((e) => e.kind === 'STATE_CHANGE')
for (const e of changes) console.log(`${e.depthMm.toFixed(2).padStart(6)} mm  ${e.label}`)

console.log('\n=== 力 ===')
const curve = computeForceCurve(model.jack, model.plug, DEFAULT_FAULTS, model.contactCfg, model.forceCfg, 0.05, -1)
const peakIns = Math.max(...curve.map((c) => c.insertionN))
const peakWd = Math.max(...curve.map((c) => c.withdrawalN))
const atFull = curve[curve.length - 1]
console.log('挿入ピーク:', peakIns.toFixed(2), 'N  抜去ピーク:', peakWd.toFixed(2), 'N')
console.log('完全挿入位置:', atFull.insertionN.toFixed(2), '/', atFull.withdrawalN.toFixed(2), 'N')
console.log('公称レンジ:', model.dims.num('jack.spec.insertionForceMin'), '-', model.dims.num('jack.spec.insertionForceMax'), 'N')
console.log(
  '完全挿入時の押付力/接点:',
  model
    .evaluate(14, DEFAULT_FAULTS)
    .contacts.map((c) => `${c.contactId}=${c.normalForceN.toFixed(2)}N (δ=${c.deflectionMm.toFixed(3)})`)
    .join(', '),
)
