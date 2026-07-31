/**
 * 接点検証。仕様 §17「接点検証」。
 */

import { describe, expect, it } from 'vitest'
import { getModel } from '../src/data'
import { DEFAULT_FAULTS, deterministicNoise, evaluateContact } from '../src/model/contact'
import { sweep, extractEvents } from '../src/model/sweep'
import { computeForceCurve } from '../src/model/force'
import {
  intersectIntervals,
  intervalsWidth,
  mergeIntervals,
  plugRadiusAt,
  radiusAtLeastIntervals,
} from '../src/model/resolve'

const model = getModel('TRS|JACK-TRS')
const F = DEFAULT_FAULTS

describe('完全抜去時', () => {
  it('プラグとの接触が一切ない', () => {
    const ev = model.evaluate(-5, F)
    for (const c of ev.contacts) {
      expect(c.state).toBe('OPEN')
      expect(c.physicallyTouching).toBe(false)
      expect(c.deflectionMm).toBe(0)
      expect(c.connectedNets).toEqual([])
    }
  })

  it('ブレーク接点はデータシート記載の通常状態 (クローズ) になる', () => {
    const ev = model.evaluate(-5, F)
    const withBreak = ev.contacts.filter((c) => c.breakState !== null)
    expect(withBreak.length).toBe(2) // データシート: "with 2 break contacts"
    for (const c of withBreak) expect(c.breakState).toBe('BREAK_CLOSED')
  })

  it('端子はどのプラグ導体にもつながらない', () => {
    const ev = model.evaluate(-5, F)
    for (const t of model.jack.terminals) {
      expect(ev.circuit.terminalToPlugNet[t.id]).toEqual([])
    }
  })
})

describe('完全挿入時', () => {
  const ev = model.evaluate(model.fullDepthMm, F)

  it('Jack Tip → Plug Tip / Jack Ring → Plug Ring / Jack Sleeve → Plug Sleeve', () => {
    expect(ev.circuit.terminalToPlugNet['T3']).toEqual(['TIP'])
    expect(ev.circuit.terminalToPlugNet['T2']).toEqual(['RING'])
    expect(ev.circuit.terminalToPlugNet['T1']).toEqual(['SLEEVE'])
  })

  it('全信号接点が CLOSED', () => {
    for (const c of ev.contacts) {
      expect(c.state, `${c.contactId} が ${c.state}`).toBe('CLOSED')
      expect(c.connectedNets.length).toBe(1)
    }
  })

  it('対応するブレーク接点は両方とも開く', () => {
    for (const c of ev.contacts.filter((x) => x.breakState !== null)) {
      expect(c.breakState, `${c.contactId}`).toBe('BREAK_OPEN')
    }
  })

  it('不要な橋絡が無い', () => {
    expect(ev.anyBridged).toBe(false)
    expect(ev.anyWrongSegment).toBe(false)
    // プラグ導体どうしが同じネットに落ちていない
    const nets = ev.circuit.nets.filter((n) => n.nodes.filter((x) => x.startsWith('PLUG:')).length > 1)
    expect(nets).toEqual([])
  })

  it('音響予測は正常 (ステレオ)', () => {
    expect(ev.acoustic.code).toBe('NORMAL')
    expect(ev.acoustic.severity).toBe('ok')
  })

  it('押付力は参考値 0.8〜1.3 N/接点の範囲に収まる', () => {
    for (const c of ev.contacts) {
      expect(c.normalForceN).toBeGreaterThanOrEqual(0.8)
      expect(c.normalForceN).toBeLessThanOrEqual(1.3)
    }
  })

  it('許容たわみを超えている接点が無い', () => {
    for (const c of ev.contacts) expect(c.overDeflected).toBe(false)
  })
})

describe('挿入途中 (半挿し)', () => {
  it('帰線用の接点が Tip 導体に触れる位置が存在する', () => {
    const ev = model.evaluate(4.5, F)
    const sleeve = ev.contacts.find((c) => c.contactId === 'JC_SLEEVE')!
    expect(sleeve.state).toBe('WRONG_SEGMENT')
    expect(sleeve.connectedNets).toEqual(['TIP'])
  })

  it('接点が絶縁帯に乗って回路が開く位置が存在する', () => {
    // Ring 接点のパッド (0.55mm) は絶縁帯 (0.7mm) より狭いので、完全に乗り切れる
    const ev = model.evaluate(12.25, F)
    const ring = ev.contacts.find((c) => c.contactId === 'JC_RING')!
    expect(ring.state).toBe('INSULATED')
    expect(ring.connectedNets).toEqual([])
    expect(ring.physicallyTouching).toBe(true) // 触れてはいるが導通しない
    // 他の 2 つは正常なので、右チャンネルだけが落ちる
    expect(ev.acoustic.code).toBe('LEFT_ONLY')
  })

  it('幅を持つ接点が導体境界をまたいで橋絡する位置が存在する', () => {
    // 第2絶縁帯 (Ring/Sleeve 間) をまたぐ位置。両側の導体はどちらも φ3.5 で同じ高さなので、
    // 接点は両方に同時に届く。
    const ev = model.evaluate(11.85, F)
    const sleeve = ev.contacts.find((c) => c.contactId === 'JC_SLEEVE')!
    expect(sleeve.state).toBe('BRIDGED')
    expect(sleeve.connectedNets.sort()).toEqual(['RING', 'SLEEVE'])
    expect(ev.anyBridged).toBe(true)
  })

  it('第1絶縁帯では橋絡が起きない (Tip 導体が Ring より 0.15mm 細いため)', () => {
    // パッド幅 0.9 > 絶縁帯 0.7 という軸方向の条件だけなら、ここでも橋絡しそうに見える。
    // しかし Tip 導体の最大半径は 1.600、Ring は 1.750。接点は Ring に押し開かれた位置から
    // 0.15mm 下の Tip 面には届かない。軸方向の条件だけで判定してはいけない。
    for (let d = 7.5; d <= 9.5; d += 0.01) {
      const sleeve = model.evaluate(Number(d.toFixed(2)), F).contacts.find((c) => c.contactId === 'JC_SLEEVE')!
      expect(sleeve.connectedNets.sort(), `d=${d.toFixed(2)}`).not.toEqual(['RING', 'TIP'])
    }
  })

  it('橋絡の成立条件は「同じ高さの導体面どうしの間隔 < パッド幅」である', () => {
    const sleeveContact = model.jack.contacts.find((c) => c.id === 'JC_SLEEVE')!
    const maxRadiusOf = (id: string) => {
      const seg = model.plug.segments.find((s) => s.id === id)!
      let m = 0
      for (let s = seg.startMm; s <= seg.endMm; s += 0.005) m = Math.max(m, plugRadiusAt(model.plug.profile, s))
      return m
    }
    const rTip = maxRadiusOf('TIP')
    const rRing = maxRadiusOf('RING')
    const rSleeve = maxRadiusOf('SLEEVE')

    // Ring と Sleeve は同じ高さ → 橋絡しうる
    expect(Math.abs(rRing - rSleeve)).toBeLessThan(1e-6)
    // Tip だけ低い → Ring とは橋絡できない
    expect(rRing - rTip).toBeGreaterThan(0.1)

    // 同じ高さの平坦面どうしの間隔がパッド幅より狭いことが、実際の成立条件
    const plateauGap = (() => {
      let lastHigh = -Infinity
      let firstHighAfter = Infinity
      for (let s = 0; s <= model.plug.fingerLengthMm; s += 0.001) {
        if (plugRadiusAt(model.plug.profile, s) >= rRing - 1e-6) {
          if (s < 9) lastHigh = s
          else if (firstHighAfter === Infinity) firstHighAfter = s
        }
      }
      return firstHighAfter - lastHigh
    })()
    expect(plateauGap).toBeLessThan(sleeveContact.padWidthMm)
    // 段に面取りが無いので、間隔は第2絶縁帯の記載幅 0.7mm とそのまま一致する。
    // 面取りが復活すると間隔が広がるので、この行が気付く。
    expect(plateauGap).toBeCloseTo(0.7, 2)

    // パッド幅が狭い Ring 接点は、どの絶縁帯もまたげない
    const ringContact = model.jack.contacts.find((c) => c.id === 'JC_RING')!
    expect(ringContact.padWidthMm).toBeLessThan(plateauGap)
  })

  it('ブレーク接点だけが先に開く位置が存在する', () => {
    const ev = model.evaluate(8.1, F)
    const ring = ev.contacts.find((c) => c.contactId === 'JC_RING')!
    expect(ring.breakState).toBe('BREAK_OPEN')
    // しかしどの端子も正しい導体にはつながっていない
    expect(ev.circuit.terminalToPlugNet['T3']).toEqual([])
    expect(ev.circuit.terminalToPlugNet['T2']).not.toEqual(['RING'])
  })

  it('Tip 用接点は Ring/Sleeve 面に乗ると過大にたわむ', () => {
    // 帰線が Sleeve、Tip 接点がまだ Ring/Sleeve 上にいる深さは存在しない構成なので、
    // 幾何の性質そのものを確認する: φ3.5 面でのたわみ > Tip 面でのたわみ
    const tip = model.jack.contacts.find((c) => c.id === 'JC_TIP')!
    const onBarrel = model.plug.bodyRadiusMm - tip.freeRadiusMm
    const atFull = model.evaluate(model.fullDepthMm, F).contacts.find((c) => c.contactId === 'JC_TIP')!
    expect(onBarrel).toBeGreaterThan(atFull.deflectionMm * 1.5)
    expect(onBarrel).toBeLessThanOrEqual(tip.maxDeflectionMm)
  })
})

describe('決定性 (仕様 §17)', () => {
  it('同一条件では同一結果になる', () => {
    const a = JSON.stringify(model.evaluate(7.3456, F))
    const b = JSON.stringify(model.evaluate(7.3456, F))
    expect(a).toBe(b)
  })

  it('0.05 mm 以下のステップで全域を走査できる', () => {
    const rows = sweep(model, { stepMm: 0.05 })
    expect(rows.length).toBeGreaterThan(500)
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].depthMm - rows[i - 1].depthMm).toBeLessThanOrEqual(0.0500001)
    }
    expect(rows[rows.length - 1].depthMm).toBeCloseTo(model.fullDepthMm, 6)
  })

  it('スイープを 2 回走らせても完全に同じ結果', () => {
    const a = JSON.stringify(sweep(model, { stepMm: 0.1 }))
    const b = JSON.stringify(sweep(model, { stepMm: 0.1 }))
    expect(a).toBe(b)
  })

  it('断続接触のノイズは時刻ではなく深度から決まる (再現可能)', () => {
    const n1 = deterministicNoise('JC_TIP', 42, 7.5, 0.02)
    const n2 = deterministicNoise('JC_TIP', 42, 7.5, 0.02)
    expect(n1).toBe(n2)
    expect(deterministicNoise('JC_TIP', 43, 7.5, 0.02)).not.toBe(n1)
    const faulty = { ...F, intermittent: true, seed: 3 }
    expect(JSON.stringify(model.evaluate(12.5, faulty))).toBe(
      JSON.stringify(model.evaluate(12.5, faulty)),
    )
  })

  it('接点が存在しない位置に架空の接触を生成しない', () => {
    // プラグ先端がまだ接点に届いていない深さでは、その接点は必ず OPEN
    for (const c of model.jack.contacts) {
      for (const d of [c.axialCenterMm - 1.0, c.axialCenterMm - 0.5, c.axialCenterMm - 0.36]) {
        const r = evaluateContact(c, model.plug, d, F, model.contactCfg)
        expect(r.physicallyTouching, `${c.id} at d=${d}`).toBe(false)
        expect(r.state).toBe('OPEN')
      }
    }
  })

  it('絶縁帯を無視して常時接続することはない', () => {
    const rows = sweep(model, { stepMm: 0.01 })
    const insulatedRows = rows.filter((r) => r.contacts.some((c) => c.state === 'INSULATED'))
    expect(insulatedRows.length).toBeGreaterThan(10)
    for (const r of insulatedRows) {
      for (const c of r.contacts.filter((x) => x.state === 'INSULATED')) {
        expect(c.connectedNets).toEqual([])
      }
    }
  })
})

describe('区間演算の健全性', () => {
  it('mergeIntervals は重なりを潰す', () => {
    expect(mergeIntervals([{ lo: 0, hi: 1 }, { lo: 0.5, hi: 2 }])).toEqual([{ lo: 0, hi: 2 }])
    expect(mergeIntervals([{ lo: 0, hi: 1 }, { lo: 2, hi: 3 }]).length).toBe(2)
  })

  it('intersectIntervals は交差幅を正しく返す', () => {
    const w = intervalsWidth(
      intersectIntervals([{ lo: 0, hi: 2 }], [{ lo: 1, hi: 5 }]),
    )
    expect(w).toBeCloseTo(1, 9)
  })

  it('radiusAtLeastIntervals は交点を解析的に求める', () => {
    const prof = [
      { s: 0, r: 0 },
      { s: 2, r: 2 },
      { s: 4, r: 2 },
    ]
    const iv = radiusAtLeastIntervals(prof, 1)
    expect(iv.length).toBe(1)
    expect(iv[0].lo).toBeCloseTo(1, 9)
    expect(iv[0].hi).toBeCloseTo(4, 9)
  })
})

describe('イベント抽出', () => {
  const rows = sweep(model, { stepMm: 0.01 })
  const events = extractEvents(model, rows)

  it('仕様 §11 の主要イベントが全て抽出される', () => {
    const kinds = new Set(events.map((e) => e.kind))
    for (const k of [
      'FIRST_PHYSICAL_CONTACT',
      'FIRST_ELECTRICAL_CONTACT',
      'FIRST_BREAK_OPEN',
      'FIRST_WRONG_SEGMENT',
      'FIRST_BRIDGE',
      'ALL_SIGNALS_CORRECT',
      'FULL_INSERTION',
      'LAST_CONTACT_RELEASE',
    ]) {
      expect(kinds.has(k as never), `${k} が抽出されていない`).toBe(true)
    }
  })

  it('イベントは深度順に並ぶ', () => {
    for (let i = 1; i < events.length; i++) {
      expect(events[i].depthMm).toBeGreaterThanOrEqual(events[i - 1].depthMm)
    }
  })

  it('最初の電気接触は最初の物理接触以降に起こる', () => {
    const phys = events.find((e) => e.kind === 'FIRST_PHYSICAL_CONTACT')!
    const elec = events.find((e) => e.kind === 'FIRST_ELECTRICAL_CONTACT')!
    expect(elec.depthMm).toBeGreaterThanOrEqual(phys.depthMm)
  })

  it('全接点が正規接続になるのは完全挿入より手前', () => {
    const all = events.find((e) => e.kind === 'ALL_SIGNALS_CORRECT')!
    expect(all.depthMm).toBeLessThanOrEqual(model.fullDepthMm)
    // そこから完全挿入まで、正規接続が途切れない
    for (const r of rows.filter((r) => r.depthMm >= all.depthMm)) {
      expect(r.bridged).toBe(false)
      expect(r.wrongSegment).toBe(false)
    }
  })
})

describe('故障モード (仕様 §12)', () => {
  it('正常モデルは書き換わらない (パラメータ適用後も既定評価は不変)', () => {
    const before = JSON.stringify(model.evaluate(14, F))
    model.evaluate(14, { ...F, contamination: 1, wear: 1, tiltDeg: 3 })
    const after = JSON.stringify(model.evaluate(14, F))
    expect(after).toBe(before)
  })

  it('汚れ 1.0 では導通が失われる', () => {
    const ev = model.evaluate(14, { ...F, contamination: 1.0, rotationDeg: 0 })
    // 汚れパッチの方位 (90deg) にある Ring 接点が最も影響を受ける
    const ring = ev.contacts.find((c) => c.contactId === 'JC_RING')!
    expect(ring.contaminationApplied).toBeCloseTo(1.0, 3)
    expect(ring.quality).toBe(0)
    expect(ring.state).toBe('OPEN')
  })

  it('理想状態ではプラグの軸回転で接続が変わらない', () => {
    const a = model.evaluate(14, { ...F, rotationDeg: 0 })
    const b = model.evaluate(14, { ...F, rotationDeg: 137 })
    expect(JSON.stringify(a.circuit.terminalToPlugNet)).toBe(JSON.stringify(b.circuit.terminalToPlugNet))
    for (let i = 0; i < a.contacts.length; i++) {
      expect(b.contacts[i].state).toBe(a.contacts[i].state)
      expect(b.contacts[i].quality).toBeCloseTo(a.contacts[i].quality, 12)
    }
  })

  it('汚れがある場合に限り軸回転が効く', () => {
    const a = model.evaluate(14, { ...F, contamination: 0.9, rotationDeg: 0 })
    const b = model.evaluate(14, { ...F, contamination: 0.9, rotationDeg: 180 })
    const qa = a.contacts.map((c) => c.quality)
    const qb = b.contacts.map((c) => c.quality)
    expect(qa).not.toEqual(qb)
  })

  it('押付不足では不安定接触になる', () => {
    const ev = model.evaluate(14, { ...F, springForceScale: 0.3 })
    // 押付倍率は力に効く。品質が落ちる方向を確認
    for (const c of ev.contacts) expect(c.normalForceN).toBeLessThan(0.5)
  })

  it('摩耗すると押付が落ちる', () => {
    const normal = model.evaluate(14, F)
    const worn = model.evaluate(14, { ...F, wear: 1.0 })
    for (let i = 0; i < normal.contacts.length; i++) {
      expect(worn.contacts[i].deflectionMm).toBeLessThan(normal.contacts[i].deflectionMm)
      expect(worn.contacts[i].quality).toBeLessThan(normal.contacts[i].quality)
    }
  })

  it('軸ずれは片側を強く、反対側を弱くする', () => {
    const off = model.evaluate(14, { ...F, lateralOffsetMm: 0.2 })
    const base = model.evaluate(14, F)
    const ring = (e: typeof base) => e.contacts.find((c) => c.contactId === 'JC_RING')!
    const tip = (e: typeof base) => e.contacts.find((c) => c.contactId === 'JC_TIP')!
    // ずれ方向 (90deg) は Ring 側
    expect(ring(off).deflectionMm).toBeGreaterThan(ring(base).deflectionMm)
    expect(tip(off).deflectionMm).toBeLessThan(tip(base).deflectionMm)
  })

  it('挿抜力のピークが走査刻みに依存しない', () => {
    // 導体と絶縁帯の境界は幅ゼロの垂直な段なので、たわみがそこで不連続に跳ぶ。
    // ランプ項 dδ/dd に上限 (force.maxRampSlope) を置かないと、傾きが
    // 中心差分の刻みだけで決まってしまい、走査刻みを変えるとピークが
    // 17.8N にも 28.2N にも変わる。上限が効いていることをここで固定する。
    const peaks = [0.02, 0.01, 0.005].map((step) => {
      const curve = computeForceCurve(
        model.jack,
        model.plug,
        DEFAULT_FAULTS,
        model.contactCfg,
        model.forceCfg,
        step,
        -1,
      )
      return curve.reduce((a, b) => (b.insertionN > a.insertionN ? b : a)).insertionN
    })
    expect(Math.max(...peaks) - Math.min(...peaks)).toBeLessThan(0.001)
    // ピークは段の通過ではなく完全挿入位置のデテントで決まる
    expect(peaks[0]).toBeGreaterThan(3)
    expect(peaks[0]).toBeLessThan(20) // Lumberg 1503 09 の公称 3〜20N
  })

  it('全プリセットが例外なく評価できる', () => {
    for (const p of model.faultPresets) {
      const d = p.depthMm ?? 14
      const ev = model.evaluate(d, { ...F, ...p.params })
      expect(ev.contacts.length).toBe(3)
      expect(typeof ev.acoustic.code).toBe('string')
    }
  })
})
