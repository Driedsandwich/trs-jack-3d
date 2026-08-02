/**
 * 感度 artifact の provenance と、感度 availability の分離。
 * 非阻害フォローアップオーダー（2026-08-03）P1-1 / P1-2 / P1-3 に対応する。
 *
 * ## P1-1 何が弱かったか
 *
 * v0.1.1 まで、感度 artifact は `generatedFromCommit` を 1 行持つだけだった。
 * その値は release commit より前を指す。artifact をコミットすると HEAD が進むので当然である。
 *
 * profile 側は `inputFiles[].sha256` でこの artifact の bytes を固定しているため
 * 取り込みは安全だったが、**この artifact だけを見て「何から作られたか」を再計算できなかった。**
 *
 * ## P1-3 何が誤読されたか
 *
 * `sensitivitySummary.available` が 2 つの別々の事実を 1 つに潰していた。
 * TRS×TRRS は `available: false` でありながら event-specific spread を 7 件持つ。
 * 受け手からは「感度情報が一切無い」と読める。**実際に読み違えられた。**
 *
 * ## この試験の書き方
 *
 * 「存在するか」ではなく「**値どうしが矛盾しないか**」を見る。
 * v0.1.0 の汚染は、45 本あった意味規則のどれにも捕まらなかった。
 * 構造は見ていたが、記録された値どうしの整合を見ていなかったためである。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listSensitivityInputs } from '../scripts/provenance'
import { mustBeNonEmpty, mustFind } from './_must'

const ROOT = resolve(__dirname, '..')
const J = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))

const trs = J('artifacts/half_plug_topology_profile.v2.trs_jack_trs.json')
const trrs = J('artifacts/half_plug_topology_profile.v2.trs_jack_trrs.json')
const sensTrs = J('artifacts/sensitivity.trs_jack_trs.json')
const sensTrrs = J('artifacts/sensitivity.trs_jack_trrs.json')

const PAIRS = [
  { name: 'TRS|JACK-TRS', profile: trs, sens: sensTrs },
  { name: 'TRS|JACK-TRRS', profile: trrs, sens: sensTrrs },
]

/** provenance と同じ手順で digest を作り直す。第三者ができることを、ここでもやる */
const recompute = (p: { inputSettings?: Record<string, string>; inputFiles: { path: string; sha256: string }[] }) =>
  createHash('sha256')
    .update(
      [
        ...Object.entries(p.inputSettings ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `setting  ${k}=${v}`),
        ...p.inputFiles.map((f) => `${f.sha256}  ${f.path}`),
      ].join('\n'),
    )
    .digest('hex')

describe('P1-1 感度 artifact の provenance', () => {
  for (const { name, sens } of PAIRS) {
    it(`${name}: inputDigest を inputFiles から作り直せる`, () => {
      // **これができなければ provenance は飾りである。**
      // 値を記録しただけで再計算できないなら、受け手は固定できない
      expect(recompute(sens.provenance)).toBe(sens.provenance.inputDigest)
    })

    it(`${name}: 自分自身を入力にしていない`, () => {
      const files = mustBeNonEmpty(sens.provenance.inputFiles as { path: string }[], 'inputFiles')
      // 自己参照を許すと、artifact を作り直すたびに digest が変わり、何も固定できなくなる
      expect(files.filter((f) => f.path.startsWith('artifacts/sensitivity'))).toEqual([])
    })

    it(`${name}: inputFiles が実際の入力一覧と一致する`, () => {
      // 生成器が見ているファイルと、artifact が名乗るファイルがずれていないか。
      // ずれていると「この入力から作った」が嘘になる
      const actual = listSensitivityInputs(ROOT).map((f) => f.path).sort()
      const recorded = (sens.provenance.inputFiles as { path: string }[]).map((f) => f.path).sort()
      expect(recorded).toEqual(actual)
    })
  }

  it('variant ごとに inputDigest が違う', () => {
    // 3極と4極は**同じスクリプト・同じモデルデータ**から作られる。
    // ファイルの指紋だけを digest にすると 2 つが同一になり、
    // 「どちらの解析か」を digest で固定できない
    expect(sensTrs.provenance.inputDigest).not.toBe(sensTrrs.provenance.inputDigest)
  })

  it('ファイル一覧が同一でも digest が分かれている（設定が効いている証拠）', () => {
    // 上の試験は「たまたま違う」でも通る。**同じファイル集合から違う digest が出ている**
    // ことまで見て、初めて設定が digest に効いていると言える
    const a = (sensTrs.provenance.inputFiles as { path: string; sha256: string }[])
      .map((f) => `${f.sha256} ${f.path}`).sort().join()
    const b = (sensTrrs.provenance.inputFiles as { path: string; sha256: string }[])
      .map((f) => `${f.sha256} ${f.path}`).sort().join()
    expect(a).toBe(b)
    expect(sensTrs.provenance.inputSettings.variantId).not.toBe(sensTrrs.provenance.inputSettings.variantId)
  })

  for (const { name, profile, sens } of PAIRS) {
    it(`${name}: profile が参照している感度の inputDigest が一致する`, () => {
      // commit ではなくこちらで見る。感度を回し直したのに profile を作り直していなければ、
      // ここが食い違う
      expect(profile.sensitivitySummary.eventSpreadSource.inputDigest).toBe(sens.provenance.inputDigest)
    })
  }
})

describe('P1-2 感度 artifact の schema と意味規則', () => {
  for (const { name, sens } of PAIRS) {
    it(`${name}: 走査の内訳が走査総数と合う`, () => {
      const s = sens.sweep
      expect(s.configurationsUsable + s.buildFailed + s.fullInsertionNotOk).toBe(s.configurationsTried)
      expect(s.configurationsTried).toBe((s.divisions + 1) ** 2)
    })

    it(`${name}: 既定値が走査範囲に入っている`, () => {
      // false だと名目値が自分の幅の外に出る。v0.1.0 で実際に起きた形
      expect(s0(sens).shippedInsideSweptRange).toBe(true)
    })

    it(`${name}: 記録した走査軸が digest に混ぜた設定と一致する`, () => {
      expect(sens.sweptParameters.join(',')).toBe(sens.provenance.inputSettings.sweptParameters)
    })

    it(`${name}: 幅そのものが壊れていない`, () => {
      const kinds = Object.entries(sens.byKind as Record<string, { minMm: number; maxMm: number; movesMm: number }>)
      expect(kinds.length).toBeGreaterThan(0)
      for (const [k, v] of kinds) {
        expect(v.minMm, `${k} の minMm`).toBeLessThanOrEqual(v.maxMm)
        expect(v.movesMm, `${k} の movesMm`).toBeCloseTo(v.maxMm - v.minMm, 4)
      }
    })
  }
})

describe('P1-3 感度 availability の分離', () => {
  for (const { name, profile } of PAIRS) {
    const ss = () => profile.sensitivitySummary

    it(`${name}: available は globalSummaryAvailable の別名である`, () => {
      expect(ss().available).toBe(ss().globalSummaryAvailable)
    })

    it(`${name}: eventSpreadAvailable が eventSpreadSource の有無と一致する`, () => {
      expect(ss().eventSpreadAvailable).toBe(ss().eventSpreadSource !== null)
    })

    it(`${name}: event に幅があるなら eventSpreadAvailable が true`, () => {
      const events = mustBeNonEmpty(profile.events as { spreadStatus: string }[], 'events')
      const has = events.some((e) => e.spreadStatus === 'MODEL_SWEEP_EVENT_SPECIFIC')
      if (has) expect(ss().eventSpreadAvailable).toBe(true)
    })
  }

  it('**TRS×TRRS は global summary が無いまま event spread を持つ**', () => {
    // これがこの分離の理由そのもの。1 つの真偽値では表せない
    expect(trrs.sensitivitySummary.globalSummaryAvailable).toBe(false)
    expect(trrs.sensitivitySummary.eventSpreadAvailable).toBe(true)
    expect(trrs.sensitivitySummary.basis).toBe('MODEL_PARAMETER_SWEEP')
    const spread = (trrs.events as { spreadStatus: string }[]).filter(
      (e) => e.spreadStatus === 'MODEL_SWEEP_EVENT_SPECIFIC',
    )
    expect(spread.length).toBeGreaterThan(0)
  })

  it('notes が「感度情報が無い」と読めない', () => {
    // 文言と機械可読な状態が食い違っていると、読む側は文言を信じる
    const notes = (trrs.sensitivitySummary.notes as string[]).join('\n')
    expect(notes).toContain('eventSpreadSource')
    expect(notes).not.toContain('感度情報は出していない')
  })
})

describe('profile の幅が感度 artifact の値と一致する', () => {
  for (const { name, profile, sens } of PAIRS) {
    it(`${name}: event-specific な幅はすべて byKind の値そのもの`, () => {
      const events = (profile.events as {
        eventId: string; kind: string; spreadStatus: string
        spreadMm: { minMm: number; maxMm: number } | null
      }[]).filter((e) => e.spreadStatus === 'MODEL_SWEEP_EVENT_SPECIFIC')
      // **0 件だとこの試験は何も見ない。** 前提を先に固定する
      mustBeNonEmpty(events, `${name} の event-specific な幅`)
      for (const e of events) {
        const b = (sens.byKind as Record<string, { minMm: number; maxMm: number }>)[e.kind]
        expect(b, `${e.eventId} の kind ${e.kind} が byKind に無い`).toBeDefined()
        expect([e.spreadMm?.minMm, e.spreadMm?.maxMm]).toEqual([b.minMm, b.maxMm])
      }
    })
  }

  it('**4極の FIRST_BREAK_OPEN に3極の幅が付いていない**', () => {
    // v0.1.0 の汚染そのもの。名目 8.48mm に 8.06〜8.06mm が付いていた
    const e = mustFind(
      trrs.events as { kind: string; depthMm: number; spreadMm: { minMm: number; maxMm: number } | null }[],
      (x) => x.kind === 'FIRST_BREAK_OPEN',
      '4極の FIRST_BREAK_OPEN',
    )
    expect(e.spreadMm).not.toBeNull()
    expect(e.depthMm).toBeGreaterThanOrEqual(e.spreadMm!.minMm)
    expect(e.depthMm).toBeLessThanOrEqual(e.spreadMm!.maxMm)
  })
})

/** sweep の取り出し。型注釈を短く保つためだけの補助 */
function s0(sens: { sweep: { shippedInsideSweptRange: boolean } }) {
  return sens.sweep
}
