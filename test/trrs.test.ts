/**
 * TRRS (4極) 拡張の検証。仕様 §13 / §19。
 *
 * 3極 TRS 版の検証 (dimensions.test.ts / contact.test.ts) が通ったうえで追加した。
 * TRS と TRRS を同一の接点モデルとして曖昧に混在させていないこと、
 * CTIA と OMTP を混同していないことを機械的に確認する。
 */

import { describe, expect, it } from 'vitest'
import { plugRadiusAt } from '../src/model/resolve'
import { allVariantIds, buildModelWithOverrides, getModel, listJackVariants, splitVariantId } from '../src/data'
import { DEFAULT_FAULTS } from '../src/model/contact'
import { sweep } from '../src/model/sweep'
import { classifyFromEvaluation } from '../src/model/topology'
import type { TrsModel } from '../src/model/engine'

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

/**
 * **端子 ID を直書きしない。** 2026-08-02 に 4極ジャックを Lumberg 1503 28 ベースへ
 * 組み直したとき、端子番号が Same Sky 式 (P2=tip) から Lumberg 式 (P2=ring2) へ変わり、
 * ID を直書きしていたこのファイルの検査が 3 件落ちた。
 * 機能で引けば、どの部品を基準にしても同じ検査になる。
 */
const netsOf = (m: TrsModel, ev: ReturnType<TrsModel['evaluate']>, role: string) => {
  const t = m.jack.terminals.find((x) => x.signalRole === role)
  if (!t) throw new Error(`端子 role=${role} が引けない`)
  return ev.circuit.terminalToPlugNet[t.id] ?? []
}

describe('同極どうしの完全挿入は正しく結線される', () => {
  it('4極 CTIA プラグ × 4極ジャック (CTIA 配線)', () => {
    const m = getModel('TRRS-CTIA|JACK-TRRS')
    const ev = m.evaluate(m.fullDepthMm, F)
    expect(netsOf(m, ev, 'L')).toEqual(['TIP'])
    expect(netsOf(m, ev, 'R')).toEqual(['RING'])
    expect(netsOf(m, ev, 'GND')).toEqual(['RING2'])
    expect(netsOf(m, ev, 'MIC')).toEqual(['SLEEVE'])
    expect(ev.anyBridged).toBe(false)
    expect(ev.anyWrongSegment).toBe(false)
    expect(ev.acoustic.code).toBe('NORMAL')
  })

  it('4極 OMTP プラグを CTIA 配線の 4極ジャックに挿すと、帰線とマイクが入れ替わる', () => {
    const m = getModel('TRRS-OMTP|JACK-TRRS')
    const ev = m.evaluate(m.fullDepthMm, F)
    // 幾何としては同じ導体に当たる
    expect(netsOf(m, ev, 'GND')).toEqual(['RING2'])
    expect(netsOf(m, ev, 'MIC')).toEqual(['SLEEVE'])
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
    // 4極ジャックの Ring2 接点 (完全挿入で s = 14 − 4.74 = 9.26) は
    // 3極プラグの Sleeve (9.0〜14.0) に当たる。Ring2 端子は機器側の帰線なので
    // 正しくつながる。3極ヘッドホンが4極ジャックで普通に鳴る挙動と一致する。
    // 2026-08-02 に Lumberg 1503 28 ベースへ組み直して 9.65 → 9.26 になった。
    // 結論 (Sleeve に当たる) は変わっていない。
    const m = getModel('TRS|JACK-TRRS')
    expect(m.unmatchedContacts).toEqual(['JC_RING2'])
    const ev = m.evaluate(m.fullDepthMm, F)
    const r2 = ev.contacts.find((c) => c.contactId === 'JC_RING2')!
    expect(r2.reason).toContain('存在しない')
    expect(r2.connectedNets).toEqual(['SLEEVE'])
    expect(r2.padCenterSMm).toBeCloseTo(9.26, 2)

    expect(netsOf(m, ev, 'L')).toEqual(['TIP'])
    expect(netsOf(m, ev, 'R')).toEqual(['RING'])
    expect(netsOf(m, ev, 'GND')).toEqual(['SLEEVE']) // 帰線が Sleeve に落ちる
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
    expect(ts[0]!).toBeCloseTo(0.72, 2) // = プラトー間隔 0.700 + minOverlap 0.01 × 2
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
    /**
     * **時間枠だけ広げてある（2026-08-06）。判定条件は変えていない。**
     *
     * 単独で回すと 2.4〜5.6 秒（実測 4 回）。ところが全 25 ファイルを並列で回すと
     * 30 秒を超えて落ちることがあった（実測 6 回中 2 回・どちらも他の処理と競合した回）。
     * **落ちた理由は結論ではなく wall-clock** なので、枠を実測の 20 倍以上へ広げる。
     * ここを縮めたいなら分割数 `n` か `stepMm` を動かすことになるが、
     * それは**この検査が見ている範囲を狭める**ので、時間のほうを譲る。
     */
  }, 120_000)
})

/**
 * 4極ジャックを Lumberg 1503 28 ベースへ組み直したこと（2026-08-02）を固定する。
 *
 * ここで守りたいのは 2 つ。
 * ① 端子位置が図面記載のままであること（勝手に動かして「実在部品ベース」を名乗らせない）
 * ② **接点位置が ASSUMPTION のままだと明記されていること**
 *    （「実在部品ベースになった」を「実測された」へ格上げさせない）
 */
describe('4極ジャックの土台 — Lumberg 1503 28', () => {
  const m = getModel('TRS|JACK-TRRS')

  it('端子は 6 本あり、軸位置は図面記載の値である', () => {
    expect(m.jack.terminals.map((t) => t.id)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6'])
    const v = (k: string) => m.dims.entry(k).value
    expect([
      v('trrs.jack.terminal.p1.axialCenter'),
      v('trrs.jack.terminal.p2.axialCenter'),
      v('trrs.jack.terminal.p3.axialCenter'),
      v('trrs.jack.terminal.p4.axialCenter'),
      v('trrs.jack.terminal.p5.axialCenter'),
      v('trrs.jack.terminal.p6.axialCenter'),
    ]).toEqual([4.74, 4.74, 7.5, 11.3, 12.5, 13.5])
    for (const k of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'])
      expect({ k, grade: m.dims.entry(`trrs.jack.terminal.${k}.axialCenter`).grade }).toEqual({
        k,
        grade: 'FACT',
      })
  })

  it('ブレーク接点が 2 個ある（UNKNOWNS §5-3 の解決）', () => {
    const brk = m.jack.contacts.map((c) => c.breakContact).filter(Boolean)
    expect(brk.map((b) => b!.id).sort()).toEqual(['BRK_TRRS_RING', 'BRK_TRRS_TIP'])
    expect(brk.map((b) => b!.terminalId).sort()).toEqual(['P5', 'P6'])
  })

  it('**接点の軸位置は ASSUMPTION のままである**（実測されたことにしない）', () => {
    for (const k of ['tip', 'ring1', 'ring2', 'sleeve'])
      expect({ k, grade: m.dims.entry(`trrs.jack.contact.${k}.axialCenter`).grade }).toEqual({
        k,
        grade: 'ASSUMPTION',
      })
    expect(m.dims.entry('trrs.jack.contact.beamOffset').grade).toBe('ASSUMPTION')
  })

  it('**ばね 3 本の端子位置から、機能の割り当ては 1 通りしか成立しない**', () => {
    // これが DERIVED の根拠。崩れたら「端子番号↔機能」の導出も崩れる。
    const springs = [4.74, 7.5, 11.3]
    const windows: Record<string, [number, number]> = {
      ring2: [3.2, 5.5],
      ring1: [6.2, 8.5],
      tip: [9.2, 14.0],
    }
    const names = Object.keys(windows)
    const perms: string[][] = []
    const go = (rest: string[], acc: string[]) => {
      if (!rest.length) perms.push(acc)
      else rest.forEach((r, i) => go([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, r]))
    }
    go(names, [])
    const ok = perms.filter((p) =>
      p.every((name, i) => springs[i] > windows[name][0] && springs[i] < windows[name][1]),
    )
    expect(ok).toEqual([['ring2', 'ring1', 'tip']])
  })

  it('**4極 CTIA プラグでも既定の入力値のまま左右差分の区間が出る**（組み直し前は 0 件だった）', () => {
    // 「無改造」とは書かない。意味するのは「このモデルの入力値を変えていない」であって、
    // 市販の実物がそうなるという意味ではない (統合オーダー P0-5)。
    const c = getModel('TRRS-CTIA|JACK-TRRS')
    let hit = 0
    for (let d = 0; d <= c.fullDepthMm + 1e-9; d += 0.01) {
      // 判定は分類器に任せる (統合オーダー P0-4)。ここに条件式を写さない
      const cls = classifyFromEvaluation(c.jack.terminals, c.plug.netFunctions, c.evaluate(+d.toFixed(4), DEFAULT_FAULTS))
      if (cls.topologyClass === 'ground-open-differential') hit++
    }
    expect(hit).toBeGreaterThan(0)
    expect(c.evaluate(c.fullDepthMm, DEFAULT_FAULTS).acoustic.code).toBe('NORMAL')
  }, 30_000)
})

/**
 * 画面に出る variant 説明文が、モデルの実態と食い違わないようにする。
 * 2026-08-02 の組み直しで端子番号が Same Sky 式から Lumberg 式へ変わったのに、
 * 説明文が「Same Sky SJ3-35074A に準拠」のまま残っていた。
 * **画面の文言は文書より見られるので、ここが古いと一番害が大きい。**
 */
describe('4極ジャックの variant 説明文', () => {
  const info = listJackVariants().find((v) => v.id === 'JACK-TRRS')!

  it('組み直し前の出典（Same Sky SJ3-35074A）を名乗っていない', () => {
    expect(info.description).not.toContain('SJ3-35074A')
    expect(info.description).toContain('1503 28')
  })

  it('**接点位置が仮定であることを画面に出している**', () => {
    expect(info.description).toMatch(/仮定/)
    expect(info.basis).toBe('constructed')
  })

  it('**外形が流用であることを画面に出している**', () => {
    // 3D は 3極品の外形を描く。黙っていると「1503 28 の実物」に見える。
    expect(info.description).toMatch(/外形/)
    expect(info.description).toMatch(/流用|違う/)
  })
})
