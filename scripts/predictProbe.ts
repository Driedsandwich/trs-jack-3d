/**
 * テスターで実際に測れる「端子間の導通」に変換した予測を出す。
 *   npx vite-node scripts/predictProbe.ts
 *
 * 接点の内部状態 (CLOSED / WRONG_SEGMENT ...) はテスターでは見えない。
 * 見えるのは「ジャックのこのピンと、プラグのこの電極が導通しているか」だけである。
 * 実物と突き合わせるには、モデルの出力をその形に落とす必要がある。
 */

import { getModel } from '../src/data'
import { DEFAULT_FAULTS } from '../src/model/contact'
import type { PlugNet } from '../src/model/types'

const model = getModel('TRS|JACK-TRS')
const STEP = 0.01
const FULL = model.fullDepthMm

/** 測定できるチャンネル: [表示名, 判定関数] */
type Channel = { name: string; probe: string; read: (d: number) => string }

const netsOf = (d: number, termId: string): PlugNet[] =>
  model.evaluate(d, DEFAULT_FAULTS).circuit.terminalToPlugNet[termId] ?? []

const breakOf = (d: number, contactId: string): string => {
  const c = model.evaluate(d, DEFAULT_FAULTS).contacts.find((x) => x.contactId === contactId)!
  return c.breakState === 'BREAK_OPEN' ? '開' : '閉'
}

const channels: Channel[] = [
  {
    name: 'Ring ブレーク接点',
    probe: 'ピン2 ↔ ピン4',
    read: (d) => breakOf(d, 'JC_RING'),
  },
  {
    name: 'Tip ブレーク接点',
    probe: 'ピン3 ↔ ピン5',
    read: (d) => breakOf(d, 'JC_TIP'),
  },
  {
    name: 'Sleeve 接点の行き先',
    probe: 'ピン1 ↔ プラグ各電極',
    read: (d) => netsOf(d, 'T1').join('+') || '—',
  },
  {
    name: 'Ring 接点の行き先',
    probe: 'ピン2 ↔ プラグ各電極',
    read: (d) => netsOf(d, 'T2').join('+') || '—',
  },
  {
    name: 'Tip 接点の行き先',
    probe: 'ピン3 ↔ プラグ各電極',
    read: (d) => netsOf(d, 'T3').join('+') || '—',
  },
]

console.log('# テスターで測れる予測（完全挿入 = 14.00 mm）\n')

for (const ch of channels) {
  console.log(`## ${ch.name}  （${ch.probe}）`)
  let prev: string | null = null
  const rows: { d: number; from: string; to: string }[] = []
  for (let i = 0; i * STEP <= FULL + 1e-9; i++) {
    const d = Number((i * STEP).toFixed(4))
    const v = ch.read(d)
    if (prev !== null && v !== prev) rows.push({ d, from: prev, to: v })
    prev = v
  }
  if (rows.length === 0) {
    console.log(`  変化なし（全域で ${prev}）\n`)
    continue
  }
  console.log('  | 深さ | すき間 | 変化 |')
  console.log('  |---:|---:|---|')
  for (const r of rows) {
    console.log(
      `  | ${r.d.toFixed(2)} mm | ${(FULL - r.d).toFixed(2)} mm | ${r.from} → ${r.to} |`,
    )
  }
  console.log('')
}

console.log('※ 「すき間」= プラグの肩とジャック前面のあいだの距離。')
console.log('   完全に挿すとゼロになるので、深さより測りやすい。深さ = 14.00 − すき間。')
