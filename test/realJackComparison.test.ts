/**
 * 実在部品の図面値との突き合わせを固定する。
 *
 * ここで守りたいのは **都合の悪い結果を消させないこと** である。
 * 2026-08-02 に、唯一見つかった実在の断面図 (pro-SIGNAL PS000001) の接点位置を入れると、
 * このプロジェクトの看板だった「3極プラグ×4極ジャックで左右差分が残る区間」が消えた。
 * 仮定値をいじれば区間は簡単に戻せてしまうので、
 * **戻したときにテストが落ちる**ようにしてある。
 *
 * artifact を読むだけでなく、モデルから計算し直して突き合わせる。
 * artifact の数字を書き換えただけでは通らない。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildModelWithOverrides, getModel } from '../src/data'
import { DEFAULT_FAULTS } from '../src/model/contact'
import { classifyFromEvaluation } from '../src/model/topology'
import type { TrsModel } from '../src/model/engine'
import { mustFind } from './_must'

const ROOT = resolve(__dirname, '..')
const PATH = resolve(ROOT, 'artifacts/real_jack_comparison.json')
// **ガードを置かない。** artifacts/ は git 管理下で「無い環境」は存在しない。
// 2026-08-03 まで `describe.skipIf(!present)` を付けており、実測すると
// この artifact を消しただけで 6 件が黙って消えた (→ CONTRIBUTING §7)。
const art = JSON.parse(readFileSync(PATH, 'utf8'))

const STEP = 0.01
const VARIANT = 'TRS|JACK-TRRS' as const

/**
 * 左右差分の窓を数える。
 *
 * **`t ? ... : []` にしてはいけない。** 2026-08-03 に変異試験で確かめたところ、
 * signalRole を引けないと全深さで `l.length === 1` が偽になり、この関数は **0 を返す**。
 * すると「図面値では区間が出ない」「パッド幅を振っても戻らない」という
 * **反証を守るための 2 件が、壊れていても通った**。
 * 引けないことは即座に落とす。0 と「引けなかった」を同じ値にしない。
 */
function differenceWindowCount(m: TrsModel): number {
  // **端子が引けることを先に確かめる。** 引けないと分類器は「届いていない」を返し、
  // 窓が 0 件になる。0 と「引けなかった」を同じ値にすると、
  // 反証を守るテストが壊れていても通る (2026-08-03 に変異試験で実測した)。
  for (const role of ['L', 'R', 'GND'] as const)
    mustFind(m.jack.terminals, (t) => t.signalRole === role, `端子 role=${role}`)
  let n = 0
  let inWindow = false
  for (let d = 0; d <= m.fullDepthMm + 1e-9; d += STEP) {
    // 判定は分類器に任せる (統合オーダー P0-4)。ここに条件式を書かない
    const cls = classifyFromEvaluation(
      m.jack.terminals,
      m.plug.netFunctions,
      m.evaluate(+d.toFixed(4), DEFAULT_FAULTS),
    )
    const hit = cls.topologyClass === 'ground-open-differential'
    if (hit && !inWindow) n++
    inWindow = hit
  }
  return n
}

describe('実在部品の図面値との突き合わせ', () => {
  const DRAWING = {
    'trrs.jack.contact.sleeve.axialCenter': 1.28,
    'trrs.jack.contact.ring2.axialCenter': 4.4,
    'trrs.jack.contact.ring1.axialCenter': 7.55,
    'trrs.jack.contact.tip.axialCenter': 12.75,
  }

  it('**図面値では左右差分の区間が出ない**（この結果を消させない）', () => {
    expect(differenceWindowCount(buildModelWithOverrides(VARIANT, DRAWING))).toBe(0)
  }, 30_000)

  it('図面値でも完全挿入は成立する（部品として破綻していないことの確認）', () => {
    const m = buildModelWithOverrides(VARIANT, DRAWING)
    expect(m.evaluate(m.fullDepthMm, DEFAULT_FAULTS).acoustic.code).toBe('NORMAL')
  })

  it('仮定値では区間が出る（比較が成立していることの確認）', () => {
    expect(differenceWindowCount(getModel(VARIANT))).toBe(1)
  }, 30_000)

  it('**看板の結論は Tip 接点が 12.6mm より浅いことを必要条件にしている**', () => {
    const others = { ...DRAWING }
    delete (others as Record<string, number>)['trrs.jack.contact.tip.axialCenter']
    const alive = (tip: number) =>
      differenceWindowCount(
        buildModelWithOverrides(VARIANT, { ...others, 'trrs.jack.contact.tip.axialCenter': tip }),
      ) > 0
    expect({ at12_60: alive(12.6), at12_65: alive(12.65) }).toEqual({ at12_60: true, at12_65: false })
  }, 30_000)

  it('パッド幅や追従量を振っても図面値では戻らない', () => {
    for (const pad of [0.3, 0.9])
      for (const c of [0.02, 0.15]) {
        const m = buildModelWithOverrides(VARIANT, {
          ...DRAWING,
          'trrs.jack.contact.narrowPadWidth': pad,
          'model.contact.complianceMm': c,
        })
        expect({ pad, c, windows: differenceWindowCount(m) }).toEqual({ pad, c, windows: 0 })
      }
  }, 60_000)

  it('**図面が縮尺どおりであることの照合が、モデル側の値と合っている**', () => {
    // 断面図の目視読み取り (2.76 / 5.79 / 8.80・精度約 0.1mm) と、本モデルが FACT な導体境界から
    // 計算する絶縁帯の中心が 0.1mm 以内で一致すること。ここがずれたら
    // 「同じ座標系で比較している」という前提そのものが崩れる。
    const m = getModel('TRRS-CTIA|JACK-TRRS')
    const centers = m.plug.segments
      .filter((s) => s.kind === 'insulator')
      .map((s) => +(m.fullDepthMm - (s.startMm + s.endMm) / 2).toFixed(3))
      .sort((a, b) => a - b)
    const measured = [2.76, 5.79, 8.8]
    expect(centers).toHaveLength(3)
    for (let i = 0; i < 3; i++) expect(Math.abs(centers[i] - measured[i])).toBeLessThan(0.1)
  })

  describe('artifact との整合', () => {
    it('artifact の結論がモデルの実測と一致する', () => {
      expect(art.result.drawing.differenceWindows).toHaveLength(0)
      expect(art.result.assumed.differenceWindows).toHaveLength(1)
      expect(art.contactPositions.drawing).toEqual(DRAWING)
    })

    it('**差し替えでも variant 追加でもないことが記録されている**', () => {
      expect(art.decision.chosen).toBe('compare-only')
      expect(art.referencePart.representativeness).toMatch(/代表するものではない/)
    })

    it('**VERIFICATION_PLAN §2-2 の対抗予測が artifact と一致する**', () => {
      // 手で書いた表を放置しないための照合。最初に書いたとき MIC を 12.02 と誤記していた。
      // 強調記号を落としてから照合する (L 行は太字になっている)
      const md = readFileSync(resolve(ROOT, 'docs/VERIFICATION_PLAN.md'), 'utf8').replace(/\*/g, '')
      const tp = art.testerPredictions.drawing as Record<string, { shoulderGapMm: number }>
      for (const role of ['MIC', 'GND', 'R', 'L']) {
        const v = tp[role].shoulderGapMm.toFixed(2)
        expect({ role, inDoc: md.includes(`| ${v} mm |`) }).toEqual({ role, inDoc: true })
      }
    })

    it('**Lumberg 1503 28 の端子位置は、接点が入るべき範囲に全部入る**', () => {
      // §6-3 の主張。ここが崩れると「接点は端子のほぼ真上」という読みが成立しない。
      const t = art.lumbergTerminalScenario.terminalsFromNoseMm as Record<string, number>
      const need: Record<string, [number, number]> = {
        'trrs.jack.contact.ring2.axialCenter': [3.2, 5.5],
        'trrs.jack.contact.ring1.axialCenter': [6.2, 8.5],
        'trrs.jack.contact.tip.axialCenter': [9.2, 14.0],
      }
      for (const [k, [lo, hi]] of Object.entries(need))
        expect({ k, inside: t[k] > lo && t[k] < hi }).toEqual({ k, inside: true })
    })

    it('**実在資料 2 件が逆を指していることを記録している**', () => {
      // PS000001 は区間なし、Lumberg 端子位置は区間あり。
      // 片方だけ残して「決着した」と書けないようにする。
      expect(art.result.drawing.differenceWindows).toHaveLength(0)
      expect(art.lumbergTerminalScenario.differenceWindows.length).toBeGreaterThan(0)
      expect(art.lumbergTerminalScenario.fullInsertionOk).toBe(true)
      expect(art.lumbergTerminalScenario.caveat).toMatch(/保証は無い/)
    })

    it('モデルがこの部品の値を採用していないこと', () => {
      // 「比較対象として持つ」という判断が守られているか。
      // 採用してしまうと artifact の assumed 側が図面値と同じになる。
      const assumed = art.contactPositions.assumed as Record<string, number>
      expect(assumed['trrs.jack.contact.tip.axialCenter']).not.toBe(12.75)
      for (const [k, v] of Object.entries(assumed))
        expect({ k, v }).toEqual({ k, v: getModel(VARIANT).dims.entry(k).value })
    })
  })
})
