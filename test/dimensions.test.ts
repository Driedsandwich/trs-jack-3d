/**
 * 寸法検証。仕様 §17「寸法検証」。
 *
 * 設計値 (dimensions.json) とモデルが実際に生成する値を突き合わせ、
 * データシート記載寸法と矛盾しないことを機械的に確認する。
 */

import { describe, expect, it } from 'vitest'
import { getModel } from '../src/data'
import { plugRadiusAt } from '../src/model/resolve'

const model = getModel('TRS|JACK-TRS')

describe('プラグ寸法 (Lumberg 1532 10)', () => {
  it('軸径は φ3.5 ± 0.05 の範囲内', () => {
    const e = model.dims.entry('plug.bodyDiameter')
    expect(e.value).toBe(3.5)
    expect(e.tolerance).toBe(0.05)
    expect(e.grade).toBe('FACT')
    // Ring / Sleeve 区間の実半径が公差内か
    for (const s of [6.0, 7.0, 8.0, 10.0, 12.0, 13.5]) {
      const d = plugRadiusAt(model.plug.profile, s) * 2
      expect(Math.abs(d - 3.5)).toBeLessThanOrEqual(0.05)
    }
  })

  it('指部長は 14 mm ちょうど', () => {
    expect(model.plug.fingerLengthMm).toBe(14.0)
    expect(model.dims.entry('plug.fingerLength').grade).toBe('FACT')
  })

  it('セグメントは隙間なく連続し、合計が指部長に一致する', () => {
    const segs = model.plug.segments
    expect(segs[0].startMm).toBe(0)
    expect(segs[segs.length - 1].endMm).toBeCloseTo(14.0, 9)
    let total = 0
    for (let i = 0; i < segs.length; i++) {
      total += segs[i].endMm - segs[i].startMm
      if (i > 0) expect(segs[i].startMm).toBeCloseTo(segs[i - 1].endMm, 9)
    }
    expect(total).toBeCloseTo(14.0, 9)
  })

  it('絶縁帯は幅ゼロではない (仕様 §4.2)', () => {
    const ins = model.plug.segments.filter((s) => s.kind === 'insulator')
    expect(ins.length).toBe(2)
    for (const s of ins) expect(s.endMm - s.startMm).toBeGreaterThan(0.1)
  })

  it('第2絶縁帯の幅は図面記載の 0.7 mm と一致する', () => {
    const ins2 = model.plug.segments.find((s) => s.id === 'INS2')!
    expect(ins2.endMm - ins2.startMm).toBeCloseTo(0.7, 1)
    // 記載寸法そのもの
    expect(model.dims.entry('plug.ins2.width').value).toBe(0.7)
    expect(model.dims.entry('plug.ins2.width').grade).toBe('FACT')
  })

  it('記載寸法チェーンと整合する (14 − 8.5 = 5.5 が Ring 前端、14 − 5 = 9.0 が Sleeve 前端)', () => {
    const L = model.dims.num('plug.fingerLength')
    const ringFront = L - model.dims.num('plug.dim.ringFrontToShoulder')
    const sleeveFront = L - model.dims.num('plug.dim.sleeveExposedLength')
    expect(model.plug.segments.find((s) => s.id === 'RING')!.startMm).toBeCloseTo(ringFront, 2)
    expect(model.plug.segments.find((s) => s.id === 'SLEEVE')!.startMm).toBeCloseTo(sleeveFront, 2)
    // 0.7 の整合: Ring 後端 = Sleeve 前端 − 0.7
    const ringEnd = model.plug.segments.find((s) => s.id === 'RING')!.endMm
    expect(ringEnd).toBeCloseTo(sleeveFront - 0.7, 2)
  })

  it('Tip 導体の接触面は Ring/Sleeve より細い (図面実測の特徴)', () => {
    // Tip 金属部 (先端から逆テーパ終端まで) の最大径
    const taperEnd = model.dims.num('plug.tip.taperEnd')
    const tipMax = Math.max(...model.plug.profile.filter((p) => p.s <= taperEnd).map((p) => p.r))
    expect(tipMax).toBeLessThan(model.plug.bodyRadiusMm)
    expect(tipMax * 2).toBeCloseTo(3.02, 1)
    // 実際に Tip 接点が当たる位置でも φ3.5 より細い
    const tipContact = model.jack.contacts.find((c) => c.id === 'JC_TIP')!
    const sAtFull = model.fullDepthMm - tipContact.axialCenterMm
    expect(plugRadiusAt(model.plug.profile, sAtFull)).toBeLessThan(model.plug.bodyRadiusMm - 0.2)
  })

  it('プロファイルは単調な s で定義され、半径は非負', () => {
    for (let i = 1; i < model.plug.profile.length; i++) {
      expect(model.plug.profile[i].s).toBeGreaterThanOrEqual(model.plug.profile[i - 1].s)
    }
    for (const p of model.plug.profile) expect(p.r).toBeGreaterThanOrEqual(0)
  })
})

describe('ジャック寸法 (Lumberg 1503 09)', () => {
  it('データシート記載の外形寸法を保持している', () => {
    expect(model.dims.num('jack.overallLength')).toBe(17.6)
    expect(model.dims.num('jack.housing.width')).toBe(11.5)
    expect(model.dims.num('jack.housing.height')).toBe(6.0)
    expect(model.dims.num('jack.noseLength')).toBe(3.5)
    expect(model.dims.num('jack.housing.depth')).toBe(14.1)
    // 3.5 + 14.1 = 17.6
    expect(model.dims.num('jack.noseLength') + model.dims.num('jack.housing.depth')).toBeCloseTo(17.6, 9)
  })

  it('挿入穴は φ3.6、プラグ φ3.5 に対し片側 0.05 mm の隙間', () => {
    const bore = model.jack.entryBoreDiameterMm
    expect(bore).toBe(3.6)
    expect((bore - model.plug.bodyDiameterMm) / 2).toBeCloseTo(0.05, 9)
  })

  it('完全挿入深度はプラグ指部長と一致する (肩が停止面に当たるため)', () => {
    expect(model.fullDepthMm).toBe(14.0)
    expect(model.fullDepthMm).toBe(model.plug.fingerLengthMm)
    // 肩の外径がボアより大きいことが停止の根拠
    expect(model.dims.num('plug.handle.shoulderDiameter')).toBeGreaterThan(bore())
    function bore() {
      return model.jack.entryBoreDiameterMm
    }
  })

  it('端子の軸位置は基板レイアウト図 + ナット長 3.5 と整合する', () => {
    const nose = model.dims.num('jack.noseLength')
    const pairs: [string, number][] = [
      ['jack.pin1.axial', 2.1],
      ['jack.pin2.axial', 5.4],
      ['jack.pin5.axial', 8.5],
      ['jack.pin3.axial', 9.9],
      ['jack.pin4.axial', 13.1],
    ]
    for (const [key, fromBody] of pairs) {
      expect(model.dims.num(key)).toBeCloseTo(fromBody + nose, 9)
    }
  })
})

describe('接点位置の整合 (完全挿入時に正しい導体上にあること)', () => {
  it('各接点のパッド全幅が、対応する導体区間の内側に収まる', () => {
    const d = model.fullDepthMm
    for (const c of model.jack.contacts) {
      const seg = model.plug.segments.find((s) => s.id === c.expectedSegment)!
      const sLo = d - c.axialCenterMm - c.padWidthMm / 2
      const sHi = d - c.axialCenterMm + c.padWidthMm / 2
      expect(sLo, `${c.id} の前端が ${seg.id} からはみ出している`).toBeGreaterThan(seg.startMm)
      expect(sHi, `${c.id} の後端が ${seg.id} からはみ出している`).toBeLessThan(seg.endMm)
    }
  })

  it('接点の根元は接触点より奥にある (前方へ伸びる片持ち梁)', () => {
    for (const c of model.jack.contacts) {
      expect(c.rootAxialMm).toBeGreaterThan(c.axialCenterMm)
    }
  })

  it('自由半径はプラグ半径より小さい (押付が生じる)', () => {
    for (const c of model.jack.contacts) {
      expect(c.freeRadiusMm).toBeLessThan(model.plug.bodyRadiusMm)
    }
  })
})

describe('設計値とモデル測定値の差の一覧', () => {
  it('主要寸法の差はすべて 0.05 mm 以内', () => {
    const table: { name: string; design: number; model: number }[] = [
      { name: 'プラグ軸径', design: 3.5, model: plugRadiusAt(model.plug.profile, 11) * 2 },
      { name: '指部長', design: 14.0, model: model.plug.fingerLengthMm },
      {
        name: '第2絶縁帯幅',
        design: 0.7,
        model: (() => {
          const s = model.plug.segments.find((x) => x.id === 'INS2')!
          return s.endMm - s.startMm
        })(),
      },
      { name: '挿入穴径', design: 3.6, model: model.jack.entryBoreDiameterMm },
      { name: '完全挿入深度', design: 14.0, model: model.fullDepthMm },
    ]
    const diffs = table.map((t) => ({ ...t, diff: Math.abs(t.design - t.model) }))
    for (const d of diffs) {
      expect(d.diff, `${d.name}: 設計 ${d.design} / モデル ${d.model}`).toBeLessThanOrEqual(0.05)
    }
  })
})
