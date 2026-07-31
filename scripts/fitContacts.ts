/**
 * 実測した「切り替わりの深さ」から、ジャック内部接点の軸位置を逆算する。
 *
 *   npx vite-node scripts/fitContacts.ts                    # 自己検査 (モデル自身の予測を入力)
 *   npx vite-node scripts/fitContacts.ts 8.4 12.3 4.1       # 実測値を入れて逆算
 *      引数の順: Ringブレーク開放 / Tipブレーク開放 / Sleeve接点がTipに触れ始める
 *
 * 考え方:
 *   接点の軸位置 xj を 1 つだけ動かして、その接点の「最初の切り替わり深さ」が
 *   実測と一致する値を探す。合わせるのは 1 点だけにする。
 *   残りの切り替わり (再閉など) は合わせずに予測として出し、実測と比べる。
 *   全部合わせにいくと「合って当然」になり、モデルを検証したことにならない。
 */

import { getModel } from '../src/data'
import { DEFAULT_FAULTS, evaluateContact } from '../src/model/contact'
import type { ResolvedJackContact } from '../src/model/resolve'

const model = getModel('TRS|JACK-TRS')
const FULL = model.fullDepthMm
const STEP = 0.005
const F = DEFAULT_FAULTS

/** 軸位置だけ差し替えた接点を作る */
function withAxialCenter(c: ResolvedJackContact, xj: number): ResolvedJackContact {
  return { ...c, axialCenterMm: xj, rootAxialMm: c.rootAxialMm + (xj - c.axialCenterMm) }
}

/** ブレーク接点が開閉する深さを全部拾う */
function breakTransitions(c: ResolvedJackContact): { depth: number; to: string }[] {
  const out: { depth: number; to: string }[] = []
  let prev: string | null = null
  for (let d = 0; d <= FULL + 1e-9; d += STEP) {
    const r = evaluateContact(c, model.plug, d, F, model.contactCfg)
    const v = r.breakState === 'BREAK_OPEN' ? '開' : '閉'
    if (prev !== null && v !== prev) out.push({ depth: Number(d.toFixed(3)), to: v })
    prev = v
  }
  return out
}

/** その接点がどのプラグ導体に導通しているかが変わる深さを拾う */
function netTransitions(c: ResolvedJackContact): { depth: number; to: string }[] {
  const out: { depth: number; to: string }[] = []
  let prev: string | null = null
  for (let d = 0; d <= FULL + 1e-9; d += STEP) {
    const r = evaluateContact(c, model.plug, d, F, model.contactCfg)
    // 並び順で見かけ上の変化が出ないよう揃える
    const v = r.connectedNets.slice().sort().join('+') || '—'
    if (prev !== null && v !== prev) out.push({ depth: Number(d.toFixed(3)), to: v })
    prev = v
  }
  return out
}

/** 最初の切り替わりが observed になる軸位置を探す */
function fitFirstTransition(
  base: ResolvedJackContact,
  observed: number,
  kind: 'break' | 'net',
): { xj: number; err: number } | null {
  let best: { xj: number; err: number } | null = null
  // 粗く走査してから細かく詰める
  for (const [lo, hi, st] of [
    [base.axialCenterMm - 4, base.axialCenterMm + 4, 0.02],
    [0, 0, 0], // 2 周目は下で入れ替える
  ] as [number, number, number][]) {
    if (st === 0) continue
    for (let xj = lo; xj <= hi; xj += st) {
      if (xj <= 0.2 || xj >= FULL) continue
      const c = withAxialCenter(base, xj)
      const t = kind === 'break' ? breakTransitions(c) : netTransitions(c)
      if (t.length === 0) continue
      const err = Math.abs(t[0].depth - observed)
      if (!best || err < best.err) best = { xj: Number(xj.toFixed(4)), err }
    }
  }
  if (!best) return null
  // 細かく詰める
  for (let xj = best.xj - 0.03; xj <= best.xj + 0.03; xj += 0.002) {
    if (xj <= 0.2 || xj >= FULL) continue
    const c = withAxialCenter(base, xj)
    const t = kind === 'break' ? breakTransitions(c) : netTransitions(c)
    if (t.length === 0) continue
    const err = Math.abs(t[0].depth - observed)
    if (err < best.err) best = { xj: Number(xj.toFixed(4)), err }
  }
  return best
}

// ---------------------------------------------------------------------------

type Target = {
  id: string
  label: string
  probe: string
  kind: 'break' | 'net'
  firstLabel: string
}

const TARGETS: Target[] = [
  { id: 'JC_RING', label: 'Ring 接点ばね', probe: 'ピン2 ↔ ピン4', kind: 'break', firstLabel: 'ブレーク接点が最初に開く' },
  { id: 'JC_TIP', label: 'Tip 接点ばね', probe: 'ピン3 ↔ ピン5', kind: 'break', firstLabel: 'ブレーク接点が開く' },
  { id: 'JC_SLEEVE', label: 'Sleeve 接点', probe: 'ピン1 ↔ プラグ Tip', kind: 'net', firstLabel: 'Tip 導体に触れ始める' },
]

const args = process.argv.slice(2).map(Number).filter((n) => !Number.isNaN(n))
const selfCheck = args.length === 0

console.log(
  selfCheck
    ? '=== 自己検査: モデル自身の予測を入力して、元の軸位置を復元できるか ===\n'
    : '=== 実測値から軸位置を逆算 ===\n',
)

let maxRoundTripErr = 0

TARGETS.forEach((t, i) => {
  const base = model.jack.contacts.find((c) => c.id === t.id)!
  const baseTrans = t.kind === 'break' ? breakTransitions(base) : netTransitions(base)
  const predictedFirst = baseTrans[0]?.depth ?? NaN
  const observed = selfCheck ? predictedFirst : args[i]

  console.log(`## ${t.label}  （${t.probe}）`)
  if (observed === undefined || Number.isNaN(observed)) {
    console.log('  実測値が渡されていないので飛ばす\n')
    return
  }
  console.log(`  合わせる観測点: ${t.firstLabel}`)
  console.log(`    現モデルの予測 : ${predictedFirst.toFixed(2)} mm （すき間 ${(FULL - predictedFirst).toFixed(2)} mm）`)
  console.log(`    実測           : ${observed.toFixed(2)} mm （すき間 ${(FULL - observed).toFixed(2)} mm）`)

  const fit = fitFirstTransition(base, observed, t.kind)
  if (!fit) {
    console.log('  → その深さで切り替わる軸位置が見つからない。構造の仮定を疑うこと\n')
    return
  }
  const shift = fit.xj - base.axialCenterMm
  console.log(`  逆算した軸位置   : ${fit.xj.toFixed(3)} mm  （現モデル ${base.axialCenterMm.toFixed(3)} mm / ずれ ${shift >= 0 ? '+' : ''}${shift.toFixed(3)} mm）`)
  console.log(`  残差             : ${fit.err.toFixed(4)} mm`)

  if (selfCheck) maxRoundTripErr = Math.max(maxRoundTripErr, Math.abs(shift))

  // 合わせていない残りの切り替わりを、独立した予測として出す
  const fitted = withAxialCenter(base, fit.xj)
  const rest = (t.kind === 'break' ? breakTransitions(fitted) : netTransitions(fitted)).slice(1)
  if (rest.length) {
    console.log('  この軸位置なら、続く切り替わりはこうなる（合わせていない＝検証に使える）:')
    for (const r of rest) {
      console.log(`    ${r.depth.toFixed(2)} mm （すき間 ${(FULL - r.depth).toFixed(2)} mm） → ${r.to}`)
    }
  }
  console.log('')
})

if (selfCheck) {
  const ok = maxRoundTripErr < 0.02
  console.log(`自己検査: 軸位置の復元誤差 最大 ${maxRoundTripErr.toFixed(4)} mm → ${ok ? '合格' : '不合格'}`)
  if (!ok) process.exitCode = 1
} else {
  console.log('次の手順:')
  console.log('  1. ずれが 0.3mm 以内なら、モデルは実測と整合。dimensions.json の note に実測日と値を追記する')
  console.log('  2. 0.3〜1.0mm なら、逆算した軸位置へ dimensions.json を更新し、grade を ASSUMPTION から DERIVED へ上げる')
  console.log('  3. 1.0mm 超、または「続く切り替わり」が実測と質的に違うなら、')
  console.log('     軸位置だけの問題ではない。パッド幅・自由半径・プラグ外形のどれが効いているか切り分ける')
}
