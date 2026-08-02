/**
 * Half-Plug Topology Profile v1 の互換性試験。
 * 統合オーダー (2026-08-01) §3 P0「Schemaと互換性試験」の 10 項目に対応する。
 *
 * ## 自前の検証器をやめた (2026-08-03・統合オーダー P0-6)
 *
 * 2026-08-03 まで、JSON Schema の検証を自前で書いていた。
 * 実装していたのは required / type / enum / const / additionalProperties / $ref /
 * minItems / minimum だけで、**`pattern` を実装していなかった。**
 *
 * ところが 2026-08-03 の P0-1 で、provenance に `pattern` 制約を 5 本足していた
 * (inputDigest の sha256、generatedFromCommit の 40 桁 hex、artifactDate の日付形式、
 * inputFiles[].sha256、profileId)。**そのどれも検証されていなかった。**
 * schema に書いたから守られている、と report に書いたが、実際には素通りしていた。
 *
 * 実測: 意図的な違反 10 種のうち **5 種が自前の検証器を素通り**した
 * (ajv はすべて検出)。**現物の artifact に違反は 0 件だった**ので、
 * 誤った値が公開されたことは無い。守りが効いていなかっただけである。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
import { getModel } from '../src/data'

const ROOT = resolve(__dirname, '..')
const json = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))

const schema = json('schemas/half-plug-topology-profile.v1.schema.json')

// variant ごとに profile を出すので、**全部を検査する**。
// 1 つだけ見て通すと、追加した variant が壊れていても気づけない。
const PROFILES = [
  ['TRS|JACK-TRS', 'artifacts/half_plug_topology_profile.v1.trs_jack_trs.json'],
  ['TRS|JACK-TRRS', 'artifacts/half_plug_topology_profile.v1.trs_jack_trrs.json'],
] as const
const profiles = PROFILES.map(([id, path]) => [id, json(path)] as const)
/** 既定 variant。個別の主張はこちらで見る */
const profile = profiles[0][1]
const trrsProfile = profiles[1][1]

// ---------------------------------------------------------------------------
// JSON Schema 検証 — draft-07 の完全実装 (ajv)
// ---------------------------------------------------------------------------

// strict:false は schema の `description` など ajv が知らない注釈を許すため。
// **検証の厳しさは落ちない** (未知のキーワードを無視するのではなく、注釈を許すだけ)。
const ajv = new Ajv({ allErrors: true, strict: false })
const compiled = ajv.compile(schema)

/** 違反の一覧を人が読める形で返す。空配列なら適合 */
function validate(value: unknown): string[] {
  return compiled(value)
    ? []
    : (compiled.errors ?? []).map((e) => `${e.instancePath || '(root)'}: ${e.keyword} — ${e.message}`)
}

// ---------------------------------------------------------------------------

describe('Half-Plug Topology Profile v1', () => {
  // 1. JSON Schema validation (draft-07 の完全実装)
  it.each(profiles.map(([id]) => id))('1. schema に適合する (%s)', (id) => {
    const p = profiles.find(([x]) => x === id)![1]
    expect(validate(p)).toEqual([])
  })

  it('1b. 検証器そのものが働く (壊した profile を弾ける)', () => {
    // 通るだけの検証器では意味がないので、確かに落ちることを見る
    expect(validate({ ...profile, schemaVersion: 2 }).length).toBeGreaterThan(0)
    expect(validate({ ...profile, intervals: [] }).length).toBeGreaterThan(0)
    const bad = structuredClone(profile)
    bad.intervals[0].normalizedStart = 1.5
    expect(validate(bad).length).toBeGreaterThan(0)
  })

  it('**1d. `npm run validate:profiles` が全成果物で通る**', () => {
    // schema 検証と意味検証を、テストスイートの一部としても回す。
    // 別コマンドにしか無いと「回し忘れても緑」になる (→ CONTRIBUTING §7)。
    // 対象は profile 2 件 / 探索 / 実部品比較 / テスト件数 の 5 件
    const out = execFileSync('node', ['scripts/validateProfiles.mjs'], { cwd: ROOT, encoding: 'utf8' })
    expect(out).toMatch(/5 件すべてが schema と意味規則の両方に適合しています/)
  }, 30_000)

  it('**1c. `pattern` 制約が実際に効いている**', () => {
    // 2026-08-03 まで自前の検証器を使っており、**`pattern` を実装していなかった。**
    // P0-1 で足した 5 本の pattern 制約はどれも検証されていなかった。
    // 現物に違反は 0 件だったが、守りが効いていなかった (→ ファイル冒頭)。
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const cases: [string, (p: any) => void][] = [
      ['inputDigest が非 hex', (p) => { p.provenance.inputDigest = 'これは sha256 ではない' }],
      ['inputDigest が 63 桁', (p) => { p.provenance.inputDigest = 'a'.repeat(63) }],
      ['generatedFromCommit が短い', (p) => { p.provenance.generatedFromCommit = 'abc123' }],
      ['artifactDate の形式が違う', (p) => { p.provenance.artifactDate = '2026/08/03' }],
      ['inputFiles[].sha256 が非 hex', (p) => { p.provenance.inputFiles[0].sha256 = 'nope' }],
    ]
    for (const [name, mutate] of cases) {
      const bad = structuredClone(profile)
      mutate(bad)
      expect({ name, caught: validate(bad).length > 0 }).toEqual({ name, caught: true })
    }
  })

  // 2. 同一入力・同一日・同一 revision で byte-identical
  it('2. 決定性 — 乱数も現在時刻も使っていない', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/exportHalfPlugProfile.ts'), 'utf8')
    expect(src).not.toMatch(/Math\.random/)
    // 日付は ARTIFACT_DATE で固定できる経路しか持たない
    expect(src).toMatch(/process\.env\.ARTIFACT_DATE/)
    expect(src).toMatch(/process\.env\.SOURCE_REVISION/)
  })

  // 3. 全 state change がちょうど 1 つの interval 境界へ対応
  it('3. 全ての区間境界が、隣の区間の開始と一致する', () => {
    for (let i = 1; i < profile.intervals.length; i++)
      expect(profile.intervals[i].nominalStartMm).toBe(profile.intervals[i - 1].nominalEndMm)
  })

  // 4. interval 間に穴・重複がない
  it('4. 区間に穴も重複もなく、0 から完全挿入まで覆っている', () => {
    const iv = profile.intervals
    expect(iv[0].nominalStartMm).toBe(0)
    expect(iv[iv.length - 1].nominalEndMm).toBe(profile.fullInsertionDepthMm)
    for (const x of iv) expect(x.nominalEndMm).toBeGreaterThan(x.nominalStartMm)
  })

  // 5. normalizedStart/End が 0〜1
  it('5. normalized が 0〜1 で、mm と整合している', () => {
    for (const x of profile.intervals) {
      expect(x.normalizedStart).toBeGreaterThanOrEqual(0)
      expect(x.normalizedEnd).toBeLessThanOrEqual(1)
      expect(x.normalizedStart).toBeCloseTo(x.nominalStartMm / profile.fullInsertionDepthMm, 5)
    }
  })

  // 6. FACT/DERIVED/ASSUMPTION/UNKNOWN の伝播
  it('6. 各区間の evidenceGrade が、その区間の接点の最も弱い区分になっている', () => {
    const order = ['FACT', 'DERIVED', 'ASSUMPTION', 'UNKNOWN']
    for (const x of profile.intervals) {
      const weakest = x.contacts.reduce(
        (a: string, c: { evidenceGrade: string }) =>
          order.indexOf(c.evidenceGrade) > order.indexOf(a) ? c.evidenceGrade : a,
        'FACT',
      )
      expect({ id: x.intervalId, g: x.evidenceGrade }).toEqual({ id: x.intervalId, g: weakest })
    }
    // 台帳の件数がそのまま載っていること
    const dims = json('src/data/dimensions.json').entries as Record<string, { grade: string }>
    const counts = { FACT: 0, DERIVED: 0, ASSUMPTION: 0, UNKNOWN: 0 } as Record<string, number>
    for (const v of Object.values(dims)) counts[v.grade]++
    expect(profile.assumptionSummary.counts).toEqual(counts)
  })

  // 7. 未測定 profile に verifiedPhysical=true を設定できない
  it('7. 実測していないので verifiedPhysical は false', () => {
    expect(profile.modelLimitations.verifiedPhysical).toBe(false)
    expect(profile.modelLimitations.physicalVerificationRef).toBeNull()
    // 実測記録が無い状態で true にできる経路がコードに無いこと
    const src = readFileSync(resolve(ROOT, 'scripts/exportHalfPlugProfile.ts'), 'utf8')
    expect(src).not.toMatch(/verifiedPhysical:\s*true/)
  })

  // 8. quality から Ω や DSP 係数を生成しない
  it('8. quality を Ω・ゲイン・係数へ変換していない', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/exportHalfPlugProfile.ts'), 'utf8')
    expect(src).not.toMatch(/quality\s*\*/)
    expect(src).not.toMatch(/ohm|Ohm|resistance/)
    // profile 本体にも quality を持ち出していない
    expect(JSON.stringify(profile)).not.toMatch(/"quality"/)
    // 変換禁止が明文で残っていること
    expect(profile.modelLimitations.notes.join()).toMatch(/quality/)
  })

  // 9. 既定 TRS で存在しない音響状態を捏造しない
  it.each(profiles.map(([id]) => id))('9. 存在しないトポロジーを「無い」と記録している (%s)', (id) => {
    const p = profiles.find(([x]) => x === id)![1]
    // 帰線断は「差分になる/ならない」で分けている。両方とも探索対象に入れる
    expect(p.absentTopologies.searched).toContain('ground-open-differential')
    expect(p.absentTopologies.searched).toContain('ground-open-nondifferential')
    const present = new Set(
      p.intervals.map((x: { electricalTopology: { topologyClass: string } }) => x.electricalTopology.topologyClass),
    )
    for (const t of p.absentTopologies.absent) expect(present.has(t)).toBe(false)
    for (const t of present) expect(p.absentTopologies.absent).not.toContain(t)
  })

  it('3極×3極では左右差分が現れず、3極×4極では現れる（取り違えていない）', () => {
    const cls = (p: { intervals: { electricalTopology: { topologyClass: string } }[] }) =>
      new Set(p.intervals.map((x) => x.electricalTopology.topologyClass))
    expect(cls(profile).has('ground-open-differential')).toBe(false)
    expect(profile.absentTopologies.absent).toContain('ground-open-differential')
    expect(cls(trrsProfile).has('ground-open-differential')).toBe(true)
  })

  it('3極プラグ × 4極ジャックの profile が、左右差分の区間を持っている', () => {
    // **無改造で成立する唯一の構成。** これが消えたら気づけるようにする
    const iv = trrsProfile.intervals.filter(
      (x: { electricalTopology: { topologyClass: string } }) =>
        x.electricalTopology.topologyClass === 'ground-open-differential',
    )
    expect(iv.length).toBeGreaterThan(0)
    for (const x of iv) {
      // 帰線が浮くだけで、信号どうしの短絡ではない
      expect(x.safetyFlags.shortsSignalToSignal).toBe(false)
      expect(x.safetyFlags.shortsSignalToReturn).toBe(false)
      // 4極ジャックの接点位置は全て仮定なので ASSUMPTION 以外になりえない
      expect(x.evidenceGrade).toBe('ASSUMPTION')
    }
  })

  /**
   * **このテストは 2026-08-03 まで、古くなった主張のほうを固定していた。**
   *
   * 元は `expect(jackBasis.note).toMatch(/接点位置を含めて全て仮定/)` だった。
   * 2026-08-02 に 4極ジャックを Lumberg 1503 28 ベースへ組み直し、端子位置とブレーク接点が
   * FACT になったのに、exporter の直書き文字列と**この検査**が古い主張を守り続けたため、
   * 公開済み artifact に「一次資料なし」「全て仮定」が残った (統合オーダー P0-2)。
   *
   * 語句をそのまま固定すると、**モデルが進んだときにテストが足枷になる。**
   * 固定するのは語句ではなく「強い根拠と弱い根拠が分けて書かれていること」にする。
   */
  it('4極ジャックの profile は、**どこが FACT でどこが仮定か**を分けて書いている', () => {
    const b = trrsProfile.jackBasis
    // 全体としては最も弱い入力に合わせる
    expect(b.evidenceGrade).toBe('ASSUMPTION')
    expect(trrsProfile.modelLimitations.verifiedPhysical).toBe(false)

    // 包括的な断りへ戻していないこと (逆向きの陳腐化の再発防止)
    const whole = JSON.stringify(trrsProfile)
    for (const stale of ['一次資料なし', '接点位置を含めて全て仮定'])
      expect({ stale, present: whole.includes(stale) }).toEqual({ stale, present: false })

    // 内訳が台帳の区分と一致すること。台帳を直せば artifact も追随する
    const dims = getModel('TRS|JACK-TRRS').dims
    expect(dims.entry('trrs.jack.terminal.p1.axialCenter').grade).toBe('FACT')
    expect(dims.entry('trrs.jack.contact.beamOffset').grade).toBe('ASSUMPTION')
    expect(b.detail.terminalLayoutBasis).toMatch(/^FACT/)
    expect(b.detail.breakContactBasis).toMatch(/^FACT/)
    expect(b.detail.internalContactGeometryBasis).toMatch(/^ASSUMPTION/)
    // 実在の単一品と誤認させない
    expect(b.detail.constructedProfile).toBe(true)
    expect(b.detail.constructedFrom.length).toBeGreaterThan(0)
    // 実物確認はどちらも未実施のまま
    expect(b.detail.electricalContinuityValidation).toBe('未実施')
    expect(b.detail.acousticValidation).toBe('未実施')
    // 反対証拠を落としていない
    expect(b.note).toMatch(/PS000001/)
  })

  it('**variant ごとに limitations を書き分けている**', () => {
    // 2026-08-03 まで、どの variant でも「Lumberg 1532 10 × 1503 09 の 1 組」と書いていた
    const trsNote = profile.modelLimitations.notes.join()
    const trrsNote = trrsProfile.modelLimitations.notes.join()
    expect(trsNote).toMatch(/1503 09/)
    expect(trrsNote).toMatch(/1503 28/)
    expect({ trrsClaimsTrsJack: trrsNote.includes('1532 10 × Lumberg 1503 09') }).toEqual({
      trrsClaimsTrsJack: false,
    })
  })

  /**
   * 統合オーダー P0-3。感度の幅を **kind 単位の集計から事象へ複製しない**。
   *
   * 2026-08-03 まで `eventSpread.byKind[e.kind]` を全事象へ配っていた。
   * STATE_CHANGE は 1 回の挿入で 29 件出るので、29 件すべてに同じ −0.88〜14mm が付き、
   * Ring のブレーク接点にも帰線接点用の幅が付いていた。
   */
  it('**同じ kind が複数回出る事象へ、kind 単位の幅を配っていない**', () => {
    const byKind: Record<string, number> = {}
    for (const e of profile.events as { kind: string }[]) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1
    const multi = Object.entries(byKind).filter(([, n]) => n > 1).map(([k]) => k)
    // 前提そのものを検査する。複数回出る kind が無ければこの検査は何も見ていない
    expect(multi.length, '複数回出る kind が 1 つも無い。この検査は空振りしている').toBeGreaterThan(0)
    for (const e of profile.events as { kind: string; spreadMm: unknown; spreadStatus: string }[])
      if (multi.includes(e.kind))
        expect({ kind: e.kind, spread: e.spreadMm, status: e.spreadStatus }).toEqual({
          kind: e.kind,
          spread: null,
          // 2026-08-03 に MEASURED / NOT_EVENT_SPECIFIC から改名 (実物測定と誤認されるため)
          status: 'MODEL_SWEEP_NOT_EVENT_SPECIFIC',
        })
    // 集計そのものは profile 直下に残っている (捨てていない)
    expect(profile.sensitivitySummary.aggregateSpreadByKind).toBeTruthy()
  })

  it('**eventId が一意で、label の文言から作られていない**', () => {
    const ids = (profile.events as { eventId: string; label: string }[]).map((e) => e.eventId)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size, `eventId が重複: ${ids.length} 件中 ${new Set(ids).size} 種`).toBe(ids.length)
    // label を変えても変わらないこと = label の文字列が ID に入っていないこと
    for (const e of profile.events as { eventId: string; label: string }[])
      expect({ id: e.eventId, containsLabel: e.eventId.includes(e.label) }).toEqual({
        id: e.eventId,
        containsLabel: false,
      })
  })

  // 10. CC BY 対象データの帰属情報を保持
  it('10. ライセンスと帰属が機械可読で残っている', () => {
    expect(profile.dataLicense.data).toBe('CC BY 4.0')
    expect(profile.dataLicense.code).toBe('MIT')
    expect(profile.dataLicense.attribution).toMatch(/trs-jack-3d/)
    expect(profile.dataLicense.attribution).toMatch(/CC BY 4\.0/)
  })

  // オーダーが禁じている結合を、出力側でも守れているか
  it('禁止された結合をしていない', () => {
    const notes = profile.modelLimitations.notes.join('\n')
    expect(notes).toMatch(/DSP 係数ではない/)
    expect(notes).toMatch(/代表しない/)
    // acousticAnnotation は係数ではなく分類であること
    for (const x of profile.intervals) {
      expect(typeof x.electricalTopology.topologyClass).toBe('string')
      expect(['none', 'protection-dependent', 'short-circuit']).toContain(x.acousticAnnotation.electricalRisk)
    }
  })

  it('感度の幅は「測っていない」と「動かない」を区別している', () => {
    // spreadMm が null の事象があること自体は正しい。混同されないよう注記が要る
    const hasNull = profile.events.some((e: { spreadMm: unknown }) => e.spreadMm === null)
    if (hasNull) expect(profile.sensitivitySummary.notes.join()).toMatch(/測っていない/)
    for (const e of profile.events)
      if (e.spreadMm) expect(e.spreadMm.sweptParameters.length).toBeGreaterThan(0)
  })
})
