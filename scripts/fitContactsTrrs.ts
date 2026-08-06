/**
 * 4極ジャックの接点位置を、実測した「肩すき間」から逆算する。
 *
 *   npx vite-node scripts/fitContactsTrrs.ts             # 自己検査（モデル自身の予測を入力）
 *   npx vite-node scripts/fitContactsTrrs.ts 0.72        # 実測のすき間 (mm) を入れて逆算
 *
 * `scripts/fitContacts.ts` の 4極版。あちらは 3極ジャックのブレーク接点を扱う。
 *
 * 考え方は同じで、**軸位置を 1 つだけ動かして観測点が合う値を探す。**
 * 合わせるのは 1 点だけにする。全部合わせにいくと「合って当然」になり、
 * モデルを検証したことにならない。
 *
 * 観測点: **4極ジャックの L（Tip）端子が、プラグ Tip 導体と最初に導通するときの肩すき間**
 *   すき間 = 完全挿入深度 − 深さ  （docs/VERIFICATION_PLAN.md §2-2）
 */

import { getModel } from '../src/data'
import { DEFAULT_FAULTS, evaluateContact } from '../src/model/contact'
import type { ResolvedJackContact } from '../src/model/resolve'

const VARIANT = 'TRRS-CTIA|JACK-TRRS' as const
const model = getModel(VARIANT)
const FULL = model.fullDepthMm
const STEP = 0.005
const CONTACT_ID = 'JC_TIP'

/** 軸位置だけ差し替えた接点を作る（fitContacts.ts と同じ扱い） */
function withAxialCenter(c: ResolvedJackContact, xj: number): ResolvedJackContact {
  return { ...c, axialCenterMm: xj, rootAxialMm: c.rootAxialMm + (xj - c.axialCenterMm) }
}

/**
 * その軸位置での「最初に TIP 導体へ導通する肩すき間」。到達しなければ null。
 *
 * **モデルごと差し替えず、接点 1 個だけを評価する**（`fitContacts.ts` と同じ扱い）。
 * `{...model}` で作り直すと、モデルが持つメソッドが落ちる。
 */
function firstTipShoulderGap(xj: number): number | null {
  const base = model.jack.contacts.find((c) => c.id === CONTACT_ID)
  if (!base) throw new Error(`接点 ${CONTACT_ID} が ${VARIANT} に無い`)
  const moved = withAxialCenter(base, xj)
  for (let d = 0; d <= FULL + 1e-9; d += STEP) {
    const r = evaluateContact(moved, model.plug, d, DEFAULT_FAULTS, model.contactCfg)
    if (r.connectedNets.includes('TIP')) return +(FULL - d).toFixed(4)
  }
  return null
}

/** 観測されたすき間になる軸位置を探す。粗く走査してから詰める */
interface Fit { xj: number; errMm: number }

function scanRange(observedGapMm: number, lo: number, hi: number, st: number, seed: Fit | null): Fit | null {
  let best: Fit | null = seed
  for (let xj = lo; xj <= hi; xj += st) {
    if (xj <= 0.2 || xj >= FULL) continue
    const g = firstTipShoulderGap(xj)
    if (g === null) continue
    const errMm = +Math.abs(g - observedGapMm).toFixed(4)
    if (best === null || errMm < best.errMm) best = { xj: +xj.toFixed(4), errMm }
  }
  return best
}

function fit(observedGapMm: number): Fit | null {
  const base = model.jack.contacts.find((c) => c.id === CONTACT_ID)
  if (!base) return null
  const coarse = scanRange(observedGapMm, base.axialCenterMm - 4, base.axialCenterMm + 4, 0.05, null)
  if (coarse === null) return null
  return scanRange(observedGapMm, coarse.xj - 0.06, coarse.xj + 0.06, 0.005, coarse)
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2).map(Number).filter((n) => !Number.isNaN(n))
const selfCheck = args.length === 0
const base = model.jack.contacts.find((c) => c.id === CONTACT_ID)
if (!base) throw new Error(`接点 ${CONTACT_ID} が ${VARIANT} に無い`)

const predictedGap = firstTipShoulderGap(base.axialCenterMm)
console.log(
  selfCheck
    ? '=== 自己検査: モデル自身の予測を入力して、元の軸位置を復元できるか ===\n'
    : '=== 実測の肩すき間から軸位置を逆算 ===\n',
)
console.log(`## ${VARIANT} の ${CONTACT_ID}（L 端子）`)
console.log(`  現モデルの軸位置 : ${base.axialCenterMm} mm`)
console.log(`  現モデルの予測   : 肩すき間 ${predictedGap ?? '—'} mm`)

const observed = selfCheck ? predictedGap : args[0]
if (observed === null || observed === undefined) {
  console.log('\n  予測が出せないので終わる')
  process.exit(1)
}
console.log(`  入力             : 肩すき間 ${observed} mm`)

const r = fit(observed)
if (!r) {
  console.log('\n  合う軸位置が見つからなかった')
  process.exit(1)
}
console.log(`\n  逆算した軸位置   : ${r.xj} mm （残差 ${r.errMm} mm）`)

if (selfCheck) {
  const back = +Math.abs(r.xj - base.axialCenterMm).toFixed(4)
  console.log(`  往復誤差         : ${back} mm`)
  // **自己検査は「元に戻れること」まで見る。**残差が小さいだけでは、
  // 別の軸位置でも同じすき間になる（＝一意でない）場合を見逃す
  if (back > 0.05) {
    console.log('\n  **元の軸位置へ戻れていない。**逆算が一意でない可能性がある')
    process.exit(1)
  }
  console.log('\n  自己検査 OK')
} else {
  console.log(`\n  現モデルとの差   : ${(r.xj - base.axialCenterMm).toFixed(4)} mm`)
  console.log('  **この値をそのまま採用しないこと。**1 点を合わせただけで、他の観測点は合わせていない。')
  console.log('  記録は docs/measurements/measurement-records.v1.json へ入れること（npm run measure:check で判定）。')
}
