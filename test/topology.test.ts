/**
 * 電気トポロジー分類器の検証。統合オーダー 2026-08-03 P0-4。
 *
 * ## 何を守っているか
 *
 * 「帰線が浮き、L と R が別々の導体に届いている」という同じ判定が、
 * 2026-08-03 まで **5 か所**に書かれていた。
 * 5 つが揃って正しい保証はどこにも無く、実際 1 つだけが 2026-08-02 に直り、
 * もう 1 つの説明文が旧実装のまま取り残されていた（逆向きの陳腐化）。
 *
 * ここでは 3 つを見る。
 *   1. 分類器そのものの振る舞い（純関数なので直接呼べる）
 *   2. **parity — 分類器と探索/成果物が同じ答えを出すか**
 *   3. 端子 ID を直書きしていないこと
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allVariantIds, getModel } from '../src/data'
import { DEFAULT_FAULTS } from '../src/model/contact'
import {
  ALL_TOPOLOGY_CLASSES,
  classifyElectricalTopology,
  classifyFromEvaluation,
} from '../src/model/topology'
import type { PlugNet, SignalFunction } from '../src/model/types'
import { mustBeNonEmpty } from './_must'

const ROOT = resolve(__dirname, '..')

/** 最小の入力を組み立てる。モデルを通さず、分類の規則そのものを見る */
const mk = (o: {
  l?: PlugNet[]
  r?: PlugNet[]
  g?: PlugNet[]
  mic?: PlugNet[]
  netFunctions?: Partial<Record<PlugNet, SignalFunction>>
  states?: ('OPEN' | 'CLOSED' | 'INSULATED' | 'WRONG_SEGMENT' | 'BRIDGED' | 'TOUCH_UNSTABLE')[]
}) =>
  classifyElectricalTopology({
    terminalToPlugNet: { TL: o.l ?? [], TR: o.r ?? [], TG: o.g ?? [], TM: o.mic ?? [] },
    signalRoleMap: o.mic ? { TL: 'L', TR: 'R', TG: 'GND', TM: 'MIC' } : { TL: 'L', TR: 'R', TG: 'GND' },
    netFunctions: o.netFunctions ?? { TIP: 'L', RING: 'R', SLEEVE: 'GND' },
    contactStates: o.states ?? ['CLOSED'],
    breakStates: [null],
  })

describe('分類器そのもの', () => {
  it('全部つながっていれば all-expected-functions-match', () => {
    expect(mk({ l: ['TIP'], r: ['RING'], g: ['SLEEVE'] }).topologyClass).toBe('all-expected-functions-match')
  })

  it('どこにも届いていなければ no-path', () => {
    expect(mk({ states: ['OPEN'] }).topologyClass).toBe('no-path')
  })

  it('触れているが絶縁帯の上なら on-insulator（no-path と区別する）', () => {
    expect(mk({ states: ['INSULATED'] }).topologyClass).toBe('on-insulator')
  })

  it('**帰線が浮き L と R が別導体なら ground-open-differential**', () => {
    const c = mk({ l: ['TIP'], r: ['RING'], g: [] })
    expect(c.topologyClass).toBe('ground-open-differential')
    expect(c.reasonCode).toBe('RETURN_OPEN_L_AND_R_ON_DISTINCT_CONDUCTORS')
    expect(c.openSignals).toEqual(['GND'])
  })

  it('**帰線が浮いても L と R が同じ導体なら差分にならない**', () => {
    // 2026-08-02 まで、この 2 つを区別せず「左右差分が残る」と表示していた
    const c = mk({ l: ['TIP'], r: ['TIP'], g: [] })
    expect(c.topologyClass).toBe('signal-to-signal-short')
    expect(c.shortsSignalToSignal).toBe(true)
  })

  it('**信号どうしの短絡と、帰線への短絡を混同しない**', () => {
    // 2026-08-03 まで、どちらも signal-to-return-short にしていた
    const sig = mk({ l: ['TIP'], r: ['TIP'], g: ['SLEEVE'] })
    expect({ cls: sig.topologyClass, s2s: sig.shortsSignalToSignal }).toEqual({
      cls: 'signal-to-signal-short',
      s2s: true,
    })
    const ret = mk({ l: ['TIP'], r: ['RING'], g: ['TIP'] })
    expect({ cls: ret.topologyClass, s2r: ret.shortsSignalToReturn }).toEqual({
      cls: 'signal-to-return-short',
      s2r: true,
    })
  })

  it('片チャンネルだけ届いていなければ one-sided', () => {
    expect(mk({ l: ['TIP'], r: [], g: ['SLEEVE'] }).topologyClass).toBe('one-sided')
  })

  it('接触が不安定なら境目として立てる', () => {
    expect(mk({ l: ['TIP'], r: ['RING'], g: ['SLEEVE'], states: ['TOUCH_UNSTABLE'] }).confidenceBoundary).toBe(true)
  })

  it('純関数である（同じ入力から同じ結果）', () => {
    const a = JSON.stringify(mk({ l: ['TIP'], r: ['RING'], g: [] }))
    const b = JSON.stringify(mk({ l: ['TIP'], r: ['RING'], g: [] }))
    expect(a).toBe(b)
  })

  it('**端子 ID を直書きしていない**（機能で引いている）', () => {
    // 端子 ID を Z1/Z2/Z3 に変えても、signalRole が同じなら同じ結果になること。
    // 直書きしていると 4極ジャック (P1〜P6) で常に判定不能になる
    const byId = classifyElectricalTopology({
      terminalToPlugNet: { Z1: ['TIP'], Z2: ['RING'], Z3: [] },
      signalRoleMap: { Z1: 'L', Z2: 'R', Z3: 'GND' },
      netFunctions: { TIP: 'L', RING: 'R', SLEEVE: 'GND' },
      contactStates: ['CLOSED'],
      breakStates: [null],
    })
    expect(byId.topologyClass).toBe(mk({ l: ['TIP'], r: ['RING'], g: [] }).topologyClass)
  })

  it('返すクラスは必ず一覧に載っている', () => {
    for (const id of allVariantIds()) {
      const m = getModel(id)
      for (let d = 0; d <= m.fullDepthMm; d += 0.5) {
        const c = classifyFromEvaluation(m.jack.terminals, m.plug.netFunctions, m.evaluate(d, DEFAULT_FAULTS))
        expect({ id, d, known: ALL_TOPOLOGY_CLASSES.includes(c.topologyClass) }).toEqual({ id, d, known: true })
      }
    }
  }, 30_000)
})

describe('parity — 同じ判定が 2 通りの答えを出さない', () => {
  it('**分類器と成果物 (profile) が一致する**', () => {
    // artifact 側の topologyClass を、いまのモデルから計算し直して突き合わせる。
    // exporter が別の判定を持ち始めたらここで落ちる
    for (const [variant, file] of [
      ['TRS|JACK-TRS', 'artifacts/half_plug_topology_profile.v2.trs_jack_trs.json'],
      ['TRS|JACK-TRRS', 'artifacts/half_plug_topology_profile.v2.trs_jack_trrs.json'],
    ] as const) {
      const p = JSON.parse(readFileSync(resolve(ROOT, file), 'utf8'))
      const m = getModel(variant)
      const intervals = p.intervals as {
        intervalId: string
        nominalStartMm: number
        electricalTopology: { topologyClass: string; reasonCode: string }
      }[]
      mustBeNonEmpty(intervals, `${variant} の区間`)
      for (const iv of intervals) {
        const c = classifyFromEvaluation(
          m.jack.terminals,
          m.plug.netFunctions,
          m.evaluate(iv.nominalStartMm, DEFAULT_FAULTS),
        )
        expect({ variant, id: iv.intervalId, cls: iv.electricalTopology.topologyClass }).toEqual({
          variant,
          id: iv.intervalId,
          cls: c.topologyClass,
        })
      }
    }
  }, 30_000)

  it('**分類器と探索の成果物が一致する**', () => {
    // 探索は「目標クラスが現れる構成」を集めている。既定値のままの構成 (overrides が
    // 全部 shipped) については、分類器で数え直して同じ結論になることを確かめる
    const s = JSON.parse(readFileSync(resolve(ROOT, 'artifacts/topology_search_difference_signal.json'), 'utf8'))
    const axes = (Object.values(s.searchSpace.axesByJack) as { key: string; shipped: number }[][]).flat()
    mustBeNonEmpty(axes, '走査軸')
    const nominal = (s.realizability.matchesCurrentNominalParameters.samples ?? []) as {
      variantId: string
      overrides: Record<string, number>
    }[]
    // 既定値のままで成立した構成が 1 件も無ければ、この照合は何も見ていない
    mustBeNonEmpty(nominal, '既定の入力値のままで成立した構成')
    for (const w of nominal) {
      const m = getModel(w.variantId as Parameters<typeof getModel>[0])
      let hit = false
      for (let d = 0; d <= m.fullDepthMm + 1e-9 && !hit; d += 0.05) {
        const c = classifyFromEvaluation(m.jack.terminals, m.plug.netFunctions, m.evaluate(+d.toFixed(4), DEFAULT_FAULTS))
        if (c.topologyClass === 'ground-open-differential') hit = true
      }
      expect({ v: w.variantId, foundByClassifier: hit }).toEqual({ v: w.variantId, foundByClassifier: true })
    }
  }, 30_000)

  it('**profile の safetyFlags が分類器と一致する**', () => {
    // 2026-08-03 まで導体名 (TIP/RING) から作っており、機能ではなかった
    const p = JSON.parse(readFileSync(resolve(ROOT, 'artifacts/half_plug_topology_profile.v2.trs_jack_trrs.json'), 'utf8'))
    const m = getModel('TRS|JACK-TRRS')
    for (const iv of p.intervals as {
      intervalId: string
      nominalStartMm: number
      safetyFlags: { shortsSignalToSignal: boolean; shortsSignalToReturn: boolean }
    }[]) {
      const c = classifyFromEvaluation(m.jack.terminals, m.plug.netFunctions, m.evaluate(iv.nominalStartMm, DEFAULT_FAULTS))
      expect({ id: iv.intervalId, ...iv.safetyFlags }).toEqual({
        id: iv.intervalId,
        shortsSignalToSignal: c.shortsSignalToSignal,
        shortsSignalToReturn: c.shortsSignalToReturn,
      })
    }
  }, 30_000)

  it('**旧実装の説明が残っていない**（逆向きの陳腐化）', () => {
    // 「predictAcoustic の判定順の都合で L と R が同じ導体でも GROUND_OPEN になる」
    // という記述。その挙動は 2026-08-02 に直っており、いまは誤り。
    for (const f of ['scripts/searchTopology.ts', 'scripts/compareRealJack.ts', 'src/model/circuit.ts']) {
      const src = readFileSync(resolve(ROOT, f), 'utf8')
      expect({ f, stale: /判定順の都合で、?L と R が同じ導体に落ちていても/.test(src) }).toEqual({
        f,
        stale: false,
      })
    }
    // 独自実装が復活していないこと
    expect(readFileSync(resolve(ROOT, 'scripts/searchTopology.ts'), 'utf8')).not.toMatch(/function isStrictDifferenceSignal/)
  })
})
