/**
 * TRRS (4極) 拡張の検証。仕様 §13 / §19。
 *
 * 3極 TRS 版の検証 (dimensions.test.ts / contact.test.ts) が通ったうえで追加した。
 * TRS と TRRS を同一の接点モデルとして曖昧に混在させていないこと、
 * CTIA と OMTP を混同していないことを機械的に確認する。
 */

import { describe, expect, it } from 'vitest'
import { plugRadiusAt } from '../src/model/resolve'
import { allVariantIds, buildModelWithOverrides, getModel, splitVariantId } from '../src/data'
import { DEFAULT_FAULTS } from '../src/model/contact'
import { sweep } from '../src/model/sweep'

const F = DEFAULT_FAULTS

describe('4極プラグの形状', () => {
  const ctia = getModel('TRRS-CTIA|JACK-TRRS')
  const omtp = getModel('TRRS-OMTP|JACK-TRRS')
  const trs = getModel('TRS|JACK-TRS')

  it('導体 4 本と絶縁帯 3 本を持つ', () => {
    expect(ctia.plug.poleCount).toBe(4)
    expect(ctia.plug.segments.filter((s) => s.kind === 'conductor').length).toBe(4)
    expect(ctia.plug.segments.filter((s) => s.kind === 'insulator').length).toBe(3)
  })

  it('嵌合長・軸径は 3極と共通で、絶縁帯は 3 本ともちょうど 0.7mm', () => {
    expect(ctia.plug.fingerLengthMm).toBe(trs.plug.fingerLengthMm)
    expect(ctia.plug.bodyDiameterMm).toBe(trs.plug.bodyDiameterMm)
    for (const s of ctia.plug.segments.filter((x) => x.kind === 'insulator')) {
      expect(s.endMm - s.startMm, s.id).toBeCloseTo(0.7, 6)
    }
    // 3極側も同じ 0.7 に揃っている
    for (const s of trs.plug.segments.filter((x) => x.kind === 'insulator')) {
      expect(s.endMm - s.startMm, s.id).toBeCloseTo(0.7, 6)
    }
  })

  it('図面の寸法チェーンは肩基準であり、記載値がそのまま導体境界になる', () => {
    // 図面 (Same Sky SP-3544 / Cliff FC68124) の 8.5±0.2 と 5.5±0.2 は、
    // どちらも矢印の右端が肩で終わっている = 肩基準。先端基準ではない。
    // 先端基準に読み替えると 14−8.5=5.5 が Ring1 前端、14−5.5=8.5 が Ring2 前端。
    // Sleeve 長 2.5 から 14−2.5=11.5 が Sleeve 前端。
    const seg = (id: string) => ctia.plug.segments.find((s) => s.id === id)!
    const r1 = seg('RING')
    const rm = seg('INSM')
    const r2 = seg('RING2')
    const sl = seg('SLEEVE')

    expect(r1.startMm).toBeCloseTo(5.5, 6) // 14 − 8.5
    expect(r2.startMm).toBeCloseTo(8.5, 6) // 14 − 5.5
    expect(sl.startMm).toBeCloseTo(11.5, 6) // 14 − 2.5
    expect(sl.endMm - sl.startMm).toBeCloseTo(2.5, 6) // 記載寸法 2.5

    // 絶縁帯を挟んで連続している
    expect(r1.endMm).toBeCloseTo(rm.startMm, 6)
    expect(rm.endMm).toBeCloseTo(r2.startMm, 6)

    // Ring1 と Ring2 は同じ幅 2.3mm になる (0.7 の絶縁帯を挟んで対称)
    expect(r1.endMm - r1.startMm).toBeCloseTo(2.3, 6)
    expect(r2.endMm - r2.startMm).toBeCloseTo(2.3, 6)

    // 3極と 4極で Ring 領域の開始位置は共通
    expect(r1.startMm).toBeCloseTo(trs.plug.segments.find((s) => s.id === 'RING')!.startMm, 6)
  })

  it('CTIA と OMTP は形状が完全に同一で、機能割当だけが違う', () => {
    expect(JSON.stringify(ctia.plug.segments.map((s) => [s.id, s.startMm, s.endMm]))).toBe(
      JSON.stringify(omtp.plug.segments.map((s) => [s.id, s.startMm, s.endMm])),
    )
    expect(ctia.plug.netFunctions.RING2).toBe('GND')
    expect(ctia.plug.netFunctions.SLEEVE).toBe('MIC')
    expect(omtp.plug.netFunctions.RING2).toBe('MIC')
    expect(omtp.plug.netFunctions.SLEEVE).toBe('GND')
  })

  it('CTIA と OMTP を取り違えていない (Tip/Ring1 は両方とも L/R)', () => {
    for (const m of [ctia, omtp]) {
      expect(m.plug.netFunctions.TIP).toBe('L')
      expect(m.plug.netFunctions.RING).toBe('R')
    }
    // Ring2 と Sleeve は必ず入れ替わっている
    expect(ctia.plug.netFunctions.RING2).not.toBe(omtp.plug.netFunctions.RING2)
    expect(ctia.plug.netFunctions.SLEEVE).not.toBe(omtp.plug.netFunctions.SLEEVE)
  })
})

describe('同極どうしの完全挿入は正しく結線される', () => {
  it('4極 CTIA プラグ × 4極ジャック (CTIA 配線)', () => {
    const m = getModel('TRRS-CTIA|JACK-TRRS')
    const ev = m.evaluate(m.fullDepthMm, F)
    expect(ev.circuit.terminalToPlugNet['P2']).toEqual(['TIP']) // L
    expect(ev.circuit.terminalToPlugNet['P3']).toEqual(['RING']) // R
    expect(ev.circuit.terminalToPlugNet['P4']).toEqual(['RING2']) // GND
    expect(ev.circuit.terminalToPlugNet['P1']).toEqual(['SLEEVE']) // MIC
    expect(ev.anyBridged).toBe(false)
    expect(ev.anyWrongSegment).toBe(false)
    expect(ev.acoustic.code).toBe('NORMAL')
  })

  it('4極 OMTP プラグを CTIA 配線の 4極ジャックに挿すと、帰線とマイクが入れ替わる', () => {
    const m = getModel('TRRS-OMTP|JACK-TRRS')
    const ev = m.evaluate(m.fullDepthMm, F)
    // 幾何としては同じ導体に当たる
    expect(ev.circuit.terminalToPlugNet['P4']).toEqual(['RING2'])
    expect(ev.circuit.terminalToPlugNet['P1']).toEqual(['SLEEVE'])
    // だが機能が食い違うので「正常」にはならない
    expect(ev.acoustic.code).not.toBe('NORMAL')
  })
})

describe('混挿 (仕様 §13)', () => {
  it('4極 CTIA プラグ × 3極ジャック: 正常に鳴る (マイクだけ働かない)', () => {
    // 図面どおりの配置 (Ring2 は 8.5〜10.8) だと、3極ジャックの帰線接点
    // (完全挿入で s=10.8、パッド 0.9) が Ring2 の後端と重なる。
    // CTIA は Ring2 が帰線なので、帰線は正しくつながる。
    // 「4極ヘッドセットはステレオ機器でも普通に鳴る」という実挙動と一致する。
    const m = getModel('TRRS-CTIA|JACK-TRS')
    const ev = m.evaluate(m.fullDepthMm, F)
    expect(ev.circuit.terminalToPlugNet['T3']).toEqual(['TIP']) // L
    expect(ev.circuit.terminalToPlugNet['T2']).toEqual(['RING']) // R
    expect(ev.circuit.terminalToPlugNet['T1']).toEqual(['RING2']) // 帰線
    expect(m.plug.netFunctions.RING2).toBe('GND')

    // 浮くのは Sleeve (=CTIA ではマイク)。音には影響しない。
    const touched = new Set(Object.values(ev.circuit.terminalToPlugNet).flat())
    expect(m.plug.netFunctions.SLEEVE).toBe('MIC')
    expect(touched.has('SLEEVE')).toBe(false)

    expect(ev.acoustic.code).toBe('NORMAL')
  })

  it('4極 OMTP プラグ × 3極ジャック: 帰線が浮いて音量が落ちる (CTIA との対比)', () => {
    // OMTP は Sleeve が帰線。3極ジャックの帰線接点は Ring2 (=OMTP ではマイク) に
    // 当たるので、帰線を担う Sleeve がどこにも触れない。
    // OMTP ヘッドセットが標準機器で正しく鳴らないという既知の挙動と一致する。
    const m = getModel('TRRS-OMTP|JACK-TRS')
    const ev = m.evaluate(m.fullDepthMm, F)
    expect(ev.circuit.terminalToPlugNet['T1']).toEqual(['RING2'])
    expect(m.plug.netFunctions.RING2).toBe('MIC')

    const touched = new Set(Object.values(ev.circuit.terminalToPlugNet).flat())
    expect(m.plug.netFunctions.SLEEVE).toBe('GND')
    expect(touched.has('SLEEVE')).toBe(false)

    expect(ev.acoustic.code).toBe('GROUND_OPEN')
    expect(ev.acoustic.severity).toBe('bad')
  })

  it('3極プラグ × 4極ジャック: 音は正常でマイクだけ未接続', () => {
    // 図面どおりの配置だと、4極ジャックの Ring2 接点 (完全挿入で s=9.65) は
    // 3極プラグの Sleeve (9.0〜14.0) に当たる。Ring2 端子は機器側の帰線なので
    // 正しくつながる。3極ヘッドホンが4極ジャックで普通に鳴る挙動と一致する。
    const m = getModel('TRS|JACK-TRRS')
    expect(m.unmatchedContacts).toEqual(['JC_RING2'])
    const ev = m.evaluate(m.fullDepthMm, F)
    const r2 = ev.contacts.find((c) => c.contactId === 'JC_RING2')!
    expect(r2.reason).toContain('存在しない')
    expect(r2.connectedNets).toEqual(['SLEEVE'])
    expect(r2.padCenterSMm).toBeCloseTo(9.65, 2)

    expect(ev.circuit.terminalToPlugNet['P2']).toEqual(['TIP']) // L
    expect(ev.circuit.terminalToPlugNet['P3']).toEqual(['RING']) // R
    expect(ev.circuit.terminalToPlugNet['P4']).toEqual(['SLEEVE']) // 帰線
    expect(ev.acoustic.code).toBe('NORMAL')
    expect(ev.acoustic.label).toContain('マイク')
  })

})

describe('全組み合わせの健全性', () => {
  it('6 通り全てが例外なく評価でき、決定論的である', () => {
    const ids = allVariantIds()
    expect(ids.length).toBe(6)
    for (const id of ids) {
      const m = getModel(id)
      const [p, j] = splitVariantId(id)
      expect(p).toBeTruthy()
      expect(j).toBeTruthy()
      for (const d of [-5, 0, 4, 8, 11, 14]) {
        const a = JSON.stringify(m.evaluate(d, F))
        const b = JSON.stringify(m.evaluate(d, F))
        expect(a, `${id} @ ${d}mm`).toBe(b)
      }
    }
  })

  it('どの組み合わせでも、完全抜去時は全接点 OPEN', () => {
    for (const id of allVariantIds()) {
      const ev = getModel(id).evaluate(-5, F)
      for (const c of ev.contacts) expect(c.state, `${id}/${c.contactId}`).toBe('OPEN')
    }
  })

  it('4極ジャックのリング接点パッドは、同じ高さの導体面どうしの間隔より狭い (常時橋絡しない)', () => {
    // 判定基準は「導体の幅」でも「絶縁帯の幅」でもなく、
    // 同じ高さ (= 最大半径) の平坦面どうしの間隔。
    // パッドがこの間隔をまたげたときだけ、2 つの導体に同時に触れられる。
    const m = getModel('TRRS-CTIA|JACK-TRRS')
    const rMax = Math.max(...m.plug.profile.map((p) => p.r))
    const runs: [number, number][] = []
    for (let s = 0; s <= m.plug.fingerLengthMm; s += 0.001) {
      const high = plugRadiusAt(m.plug.profile, s) >= rMax - 1e-6
      const last = runs[runs.length - 1]
      if (high && last && Math.abs(last[1] - s) < 0.0015) last[1] = s
      else if (high) runs.push([s, s])
    }
    expect(runs.length, '最大半径の平坦面が複数あること').toBeGreaterThan(1)
    const minGap = Math.min(...runs.slice(1).map((r, i) => r[0] - runs[i][1]))
    // 段に面取りが無いので、間隔は絶縁帯の記載幅 0.7mm とそのまま一致する。
    // (2026-07-31 まで 0.790 としていた。ラスタ実測が線の太さを面取りと誤認していた)
    expect(minGap).toBeCloseTo(0.7, 2)

    for (const cid of ['JC_RING', 'JC_RING2']) {
      const c = m.jack.contacts.find((x) => x.id === cid)!
      expect(c.padWidthMm, cid).toBeLessThan(minGap)
    }
  })

  it('どの組み合わせでも、Tip 導体を含む橋絡は起きない', () => {
    // Tip 導体だけ他より 0.15mm 低いので、接点は Tip と他の導体に同時には触れられない。
    // 3極・4極のどのモデルでも成り立つ。
    for (const id of allVariantIds()) {
      const m = getModel(id)
      for (let i = 0; i <= Math.round(m.fullDepthMm / 0.02); i++) {
        const d = Number((i * 0.02).toFixed(2))
        for (const c of m.evaluate(d, F).contacts) {
          if (c.connectedNets.length < 2) continue
          expect(c.connectedNets, `${id}/${c.contactId}/d=${d}`).not.toContain('TIP')
        }
      }
    }
  })
})

describe('4極: 仮定に依存しない性質 (docs/SENSITIVITY.md §3)', () => {
  const m4 = getModel('TRRS-CTIA|JACK-TRRS')

  /** その接点「そのもの」が 2 導体に同時に触れる深さがあるか。接点 ID で絞る */
  const bridgesOf = (m: ReturnType<typeof getModel>, contactId: string, stepMm = 0.02) => {
    const out = new Set<string>()
    for (const r of sweep(m, { stepMm })) {
      const c = r.contacts.find((x) => x.contactId === contactId)
      if (c && c.connectedNets.length > 1) out.add([...c.connectedNets].sort().join('+'))
    }
    return out
  }

  it('同一半径のプラトー間隔は 3 本とも図面記載の絶縁帯幅 0.7 に一致する', () => {
    const rMax = Math.max(...m4.plug.profile.map((p) => p.r))
    const runs: [number, number][] = []
    for (let s = 0; s <= m4.plug.fingerLengthMm; s += 0.001) {
      const hi = plugRadiusAt(m4.plug.profile, s) >= rMax - 1e-9
      const last = runs[runs.length - 1]
      if (hi && last && Math.abs(last[1] - s) < 0.0015) last[1] = s
      else if (hi) runs.push([s, s])
    }
    expect(runs.length, '最大半径の平坦面が 3 本 (Ring1 / Ring2 / Sleeve)').toBe(3)
    const gaps = runs.slice(1).map((r, i) => r[0] - runs[i][1])
    for (const g of gaps) expect(g).toBeCloseTo(0.7, 2)
  })

  it('Ring1 接点は、位置とパッド幅をどう置いても橋絡できない', () => {
    // 制約 (完全挿入でパッド全幅が自分の導体に収まる) の内側では、
    // パッドは自分の導体の奥端を越えられない。完全挿入が最も深い位置だから。
    // したがって Ring1 接点がまたげるのは第1絶縁帯 (Tip↔Ring1) だけで、
    // そこは Tip が 0.15mm 低いので橋絡できない。
    const INS1_CENTER = (4.8 + 5.5) / 2
    for (const axial of [6.45, 7.35, 8.25]) {
      for (const w of [0.3, 0.5, 0.72, 0.9]) {
        const m = buildModelWithOverrides('TRRS-CTIA|JACK-TRRS', {
          'trrs.jack.contact.ring1.axialCenter': axial,
          'trrs.jack.contact.narrowPadWidth': w,
        })
        // 第1絶縁帯の中心に来る深さ = 最も橋絡しやすい位置
        const c = m
          .evaluate(INS1_CENTER + axial, F)
          .contacts.find((x) => x.contactId === 'JC_RING')!
        expect(c.connectedNets.length, `Ring1 接点 位置${axial} パッド${w}`).toBeLessThan(2)
      }
    }
  }, 30_000)

  it('Ring2 接点が橋絡し始めるパッド幅は、接点位置に依存しない', () => {
    // 深さを走査して「どこかで橋絡したか」を見る方法は使わない。
    // 橋絡の窓はしきい値付近で幾らでも狭くなるので、走査刻みが答えを変えてしまう
    // (0.02mm 刻みにしたら位置ごとに 0.725 と 0.745 に割れた)。
    //
    // 代わりに、最も橋絡しやすい深さ = パッドの中心が絶縁帯の中心に来る位置で
    // 1 点だけ評価する。ここで橋絡しなければ、どの深さでも橋絡しない。
    const INSM_CENTER = (7.8 + 8.5) / 2 // Ring1↔Ring2 の絶縁帯の中心
    const bridgesAtBestDepth = (axial: number, w: number) => {
      const m = buildModelWithOverrides('TRRS-CTIA|JACK-TRRS', {
        'trrs.jack.contact.ring2.axialCenter': axial,
        'trrs.jack.contact.narrowPadWidth': w,
      })
      const c = m
        .evaluate(INSM_CENTER + axial, F)
        .contacts.find((x) => x.contactId === 'JC_RING2')!
      return c.connectedNets.length > 1
    }
    const threshold = (axial: number) => {
      for (let i = 690; i <= 780; i += 1) {
        if (bridgesAtBestDepth(axial, i / 1000)) return i / 1000
      }
      return null
    }
    const ts = [3.5, 4.0, 4.35, 4.8, 5.2].map(threshold)
    for (const t of ts) expect(t).not.toBeNull()
    expect(new Set(ts).size, `しきい値が位置で変わった: ${ts.join(', ')}`).toBe(1)

    // しきい値 = プラトー間隔 0.700 + 導通の最小重なり 0.01 × 2 = 0.72
    expect(ts[0]!).toBeCloseTo(0.72, 2)
  }, 30_000)

  it('3極プラグ × 4極ジャックで Ring2 接点が Sleeve に当たる結論は、位置の仮定にほぼ依存しない', () => {
    // 成立範囲 3.45〜5.25 を 41 分割して、完全挿入での行き先を数える。
    let sleeve = 0
    const n = 41
    for (let i = 0; i < n; i++) {
      const a = +(3.45 + ((5.25 - 3.45) * i) / (n - 1)).toFixed(4)
      const m = buildModelWithOverrides('TRS|JACK-TRRS', { 'trrs.jack.contact.ring2.axialCenter': a })
      const full = sweep(m, { stepMm: 0.05 }).slice(-1)[0]
      const c = full.contacts.find((x) => x.contactId === 'JC_RING2')
      if (c?.connectedNets.join() === 'SLEEVE') sleeve++
    }
    expect(sleeve).toBeGreaterThanOrEqual(n - 1) // 端 1 点だけ絶縁帯に乗る
  }, 30_000)
})
