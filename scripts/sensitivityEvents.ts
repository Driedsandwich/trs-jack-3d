/**
 * **variant ごとの**主要イベント深さの幅を測る。
 *   npm run sensitivity:events -- --variant "TRS|JACK-TRRS"
 *
 * ## なぜ分けたか（統合フォローアップ 2026-08-03 P0-1 / P0-2）
 *
 * `scripts/sensitivity.ts` は解析基準を `TRS|JACK-TRS` に固定している。
 * ところが exporter は variant を問わず単一の `artifacts/sensitivity.json` を読み、
 * その `eventSpread.byKind` を**どの profile へも配っていた。**
 *
 * 結果、TRS×TRRS profile の `FIRST_BREAK_OPEN` は
 * 名目 8.48mm なのに幅 8.06〜8.06mm（3極の値）が付いていた。
 * **名目値が自分の幅の外にある**という、あり得ない状態である。
 * Half-Plug Lab 側の fixture import で見つかった。
 *
 * `sensitivity.ts` の他の解析（プラトー間隔・Tip 橋絡しきい値・挿抜力）は
 * 3極の幾何に強く結びついており、variant 化すると差分が大きい。
 * **profile へ漏れていたのは `eventSpread` だけ**なので、そこだけを切り出した。
 *
 * ## 何を測るか
 *
 * 帰線接点の軸位置とパッド幅を**同時に**振り、成立する全構成にわたって
 * 主要イベントの深さの最小・最大を集める。**モデル内部の感度**であって、
 * 実物のばらつきでも製造公差でもない。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildProvenance, listSensitivityInputs } from './provenance'
import { buildModelWithOverrides, getModel, type VariantId } from '../src/data'
import { DEFAULT_FAULTS } from '../src/model/contact'
import { extractEvents, sweep } from '../src/model/sweep'
import type { TrsModel } from '../src/model/engine'

const ROOT = resolve(process.cwd())
const argv = process.argv.slice(2)
const argOf = (name: string, dflt: string): string => {
  const i = argv.indexOf(`--${name}`)
  const v = i >= 0 ? argv[i + 1] : undefined
  return v ?? dflt
}
// **`Parameters<typeof getModel>[0]` を使わない。** getModel は既定値を持つので
// その型は `VariantId | undefined` になり、buildModelWithOverrides へ渡すと型エラーになる
const VARIANT = argOf('variant', 'TRS|JACK-TRS') as VariantId
const slug = String(VARIANT).toLowerCase().replace(/[^a-z0-9]+/g, '_')
const RELEASE = argv.includes('--release')

/**
 * variant ごとの走査軸。**キーを取り違えると override が効かず、
 * 同じ構成を数百回繰り返すだけの空振りになる**（2026-08-02 に探索側で実際に起きた）。
 * 下の assertAxesBite で、動かすとモデルが変わることを実測して確かめる。
 */
const AXES_BY_JACK: Record<string, { axial: string; pad: string }> = {
  'JACK-TRS': { axial: 'jack.contact.sleeve.axialCenter', pad: 'jack.contact.sleeve.padWidth' },
  'JACK-TRRS': { axial: 'trrs.jack.contact.sleeve.axialCenter', pad: 'trrs.jack.contact.narrowPadWidth' },
}
const jackId = String(VARIANT).split('|')[1]
const AX = AXES_BY_JACK[jackId]
if (!AX) throw new Error(`${VARIANT}: 走査軸の定義が無い`)

/**
 * 走査の設定。**digest に混ぜるので、直書きせずここに集める**（非阻害オーダー P1-1）。
 * 同じ値が「実際に振る範囲」「既定値が範囲内かの判定」「出力の sweep 欄」で使われる。
 * 散らしておくと、片方だけ直したときに記録と実際が食い違う。
 */
const AXIAL_RANGE_MM: readonly [number, number] = [0.45, 4.55]
const PAD_RANGE_MM: readonly [number, number] = [0.01, 5.0]
const DIVISIONS = 30
const STEP_MM = 0.02

const base = getModel(VARIANT)

/** その軸を動かすとモデルが本当に変わるか。変わらなければ空振り */
for (const key of [AX.axial, AX.pad]) {
  const before = JSON.stringify(base.jack.contacts.map((c) => [c.axialCenterMm, c.padWidthMm]))
  const shipped = base.dims.entry(key).value
  const after = JSON.stringify(
    buildModelWithOverrides(VARIANT, { [key]: shipped + 0.5 }).jack.contacts.map((c) => [c.axialCenterMm, c.padWidthMm]),
  )
  if (before === after) throw new Error(`${VARIANT}: 軸 ${key} を動かしてもモデルが変わらない。走査が空振りになる`)
}

const fullOk = (m: TrsModel) => m.evaluate(m.fullDepthMm, DEFAULT_FAULTS).acoustic.code === 'NORMAL'

// ---------------------------------------------------------------------------
// 同時振り
// ---------------------------------------------------------------------------

const spread = new Map<string, { min: number; max: number; n: number }>()
let configs = 0
let buildFailed = 0
let notFullOk = 0

const N = DIVISIONS
for (let i = 0; i <= N; i++) {
  const a = +(AXIAL_RANGE_MM[0] + (AXIAL_RANGE_MM[1] - AXIAL_RANGE_MM[0]) * (i / N)).toFixed(4)
  for (let j = 0; j <= N; j++) {
    const w = +(PAD_RANGE_MM[0] + (PAD_RANGE_MM[1] - PAD_RANGE_MM[0]) * (j / N)).toFixed(4)
    let m: TrsModel
    try {
      m = buildModelWithOverrides(VARIANT, { [AX.axial]: a, [AX.pad]: w })
    } catch {
      buildFailed++
      continue
    }
    if (!fullOk(m)) {
      notFullOk++
      continue
    }
    configs++
    for (const ev of extractEvents(m, sweep(m, { stepMm: STEP_MM }))) {
      const cur = spread.get(ev.kind) ?? { min: Infinity, max: -Infinity, n: 0 }
      cur.min = Math.min(cur.min, ev.depthMm)
      cur.max = Math.max(cur.max, ev.depthMm)
      cur.n++
      spread.set(ev.kind, cur)
    }
  }
}

if (configs === 0)
  throw new Error(`${VARIANT}: 完全挿入が成立する構成が 1 つも無かった。幅を 0 件と報告する前に軸を見直すこと`)

// **既定値の構成が走査に含まれているか。** 含まれていないと、
// 名目値が幅の外に出る (統合フォローアップ P0-3 で見つかったのと同じ形)
const shippedA = base.dims.entry(AX.axial).value
const shippedW = base.dims.entry(AX.pad).value
const inRange = (v: number, lo: number, hi: number) => v >= lo - 1e-9 && v <= hi + 1e-9
const shippedInside = inRange(shippedA, ...AXIAL_RANGE_MM) && inRange(shippedW, ...PAD_RANGE_MM)

/**
 * **感度 artifact 自身の provenance**（非阻害オーダー P1-1）。
 *
 * v0.1.1 まで、この artifact は `generatedFromCommit` を 1 行持つだけだった。
 * その commit は release commit より前を指す（artifact をコミットすると HEAD が進むので当然）。
 * profile 側は `inputFiles[].sha256` でこの artifact の bytes を固定しているので
 * 取り込みは安全だったが、**この artifact だけを見て「何から作られたか」を再計算できなかった。**
 *
 * profile と同じ方式にする。commit の一致は要求せず、**入力の中身で固定する。**
 * `settings` を混ぜるのは、3極と4極が同じファイル群から作られるため
 * ファイルの指紋だけでは 2 つの variant が同じ digest になってしまうから。
 */
const provenance = buildProvenance({
  root: ROOT,
  inputs: listSensitivityInputs(ROOT),
  settings: {
    variantId: String(VARIANT),
    sweptParameters: `${AX.axial},${AX.pad}`,
    axialRangeMm: AXIAL_RANGE_MM.join('..'),
    padRangeMm: PAD_RANGE_MM.join('..'),
    divisions: String(DIVISIONS),
    stepMm: String(STEP_MM),
  },
  // 呼び出し方で変わらない正規化した形を記録する (byte-identical を壊さないため)
  command: `npm run sensitivity:events -- --variant "${VARIANT}"${RELEASE ? ' --release' : ''}`,
  artifactDate: process.env.ARTIFACT_DATE ?? new Date().toISOString().slice(0, 10),
  release: RELEASE,
  allowRevisionOverride: argv.includes('--unsafe-revision-override'),
  envRevision: process.env.SOURCE_REVISION,
})

const out = {
  schemaVersion: 1 as const,
  generatedBy: 'npm run sensitivity:events',
  // **この 3 つが今回の修正の核心。** どの variant の解析かを機械可読にする
  variantId: String(VARIANT),
  analysisScope: 'EVENT_DEPTH_SPREAD_ONLY',
  sweptParameters: [AX.axial, AX.pad],
  generatedFromCommit: provenance.generatedFromCommit,
  provenance,
  generatedAt: process.env.ARTIFACT_DATE ?? new Date().toISOString().slice(0, 10),
  basis: 'MODEL_PARAMETER_SWEEP',
  note:
    'モデル内部の感度であって、実物のばらつきでも製造公差でもない。'
    + '帰線接点の軸位置とパッド幅を同時に振り、完全挿入が成立する構成にわたって'
    + '主要イベントの深さの最小・最大を集めたもの。',
  sweep: {
    axialRangeMm: AXIAL_RANGE_MM,
    padRangeMm: PAD_RANGE_MM,
    divisions: DIVISIONS,
    stepMm: STEP_MM,
    configurationsTried: (N + 1) * (N + 1),
    configurationsUsable: configs,
    buildFailed,
    fullInsertionNotOk: notFullOk,
    shippedValues: { [AX.axial]: shippedA, [AX.pad]: shippedW },
    shippedInsideSweptRange: shippedInside,
  },
  byKind: Object.fromEntries(
    [...spread.entries()]
      .sort()
      .map(([k, v]) => [
        k,
        { minMm: +v.min.toFixed(4), maxMm: +v.max.toFixed(4), configs: v.n, movesMm: +(v.max - v.min).toFixed(4) },
      ]),
  ),
}

mkdirSync(resolve(ROOT, 'artifacts'), { recursive: true })
writeFileSync(resolve(ROOT, `artifacts/sensitivity.${slug}.json`), JSON.stringify(out, null, 1) + '\n')

console.log(`\n  ${VARIANT}`)
console.log(`  走査 ${out.sweep.configurationsTried} 構成 / 成立 ${configs} (組めず ${buildFailed} / 完全挿入不成立 ${notFullOk})`)
console.log(`  軸: ${AX.axial} × ${AX.pad}`)
console.log(`  既定値が走査範囲の中: ${shippedInside}`)
for (const [k, v] of Object.entries(out.byKind)) console.log(`    ${k.padEnd(26)} ${v.minMm} 〜 ${v.maxMm}`)
console.log(`  artifacts/sensitivity.${slug}.json を書き出した`)
