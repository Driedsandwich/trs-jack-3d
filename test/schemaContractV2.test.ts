/**
 * Schema 契約 v2 と release evidence。
 * 非阻害フォローアップオーダー（2026-08-03）P1-5 / P2-6 / P2-7 / P2-8 に対応する。
 *
 * ## 直したかった具体的な失敗
 *
 * v0.1.0 → v0.1.1 で `spreadStatus` の enum を非互換に変えたのに `schemaVersion` は 1 のままだった。
 * 下流の adapter は `spreadStatus !== 'MEASURED'` で全 event を弾き、
 * **エラーも警告も出さずに汚染検出が丸ごと素通り**した。
 *
 * **沈黙が最悪の壊れ方である。**この試験群が守るのは「旧語彙で読んだら止まる」ことである。
 *
 * ## 方式は実測で選んだ
 *
 * 下流 (`half-plug-emulator` の `release-verifier.mjs`) が何を見るかを確かめた。
 *
 *   - `schemaVersion` を 2 にする  → `Unsupported profile schemaVersion: 2` で停止する
 *   - `contractRevision` を足すだけ → どこも読まないので PASS する
 *
 * 沈黙を避けるという目的に対して、答えは 1 つしかなかった。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
import { ALL_TOPOLOGY_CLASSES } from '../src/model/topology'
import { RELEASE_ASSETS } from '../scripts/releaseAssets.mjs'
import { mustBeNonEmpty, mustFind } from './_must'

const ROOT = resolve(__dirname, '..')
const J = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))

const v2Schema = J('schemas/half-plug-topology-profile.v3.schema.json')
const v1Schema = J('schemas/half-plug-topology-profile.v1.schema.json')
const PROFILES = [
  ['TRS|JACK-TRS', 'artifacts/half_plug_topology_profile.v3.trs_jack_trs.json'],
  ['TRS|JACK-TRRS', 'artifacts/half_plug_topology_profile.v3.trs_jack_trrs.json'],
] as const
const profiles = PROFILES.map(([id, p]) => [id, J(p)] as const)

const ajv = new Ajv({ allErrors: true, strict: false })
const okV2 = ajv.compile(v2Schema)
const okV1 = ajv.compile(v1Schema)

describe('P1-5 版が上がっていて、旧版を期待する実装が止まる', () => {
  for (const [id, p] of profiles) {
    it(`${id}: schemaVersion 3 / schemaId が入っている`, () => {
      expect(p.schemaVersion).toBe(3)
      expect(p.schemaId).toBe('half-plug-topology-profile.v3')
    })
  }

  it('**v1 schema は v2 profile を拒む**（旧実装が沈黙しない）', () => {
    // これが通ってしまうと、旧語彙で読む実装が「読めたつもり」になる
    for (const [id, p] of profiles) {
      expect(okV1(p), `${id} が v1 schema を通ってしまう`).toBe(false)
      const errs = mustBeNonEmpty(okV1.errors ?? [], `${id} の v1 違反`)
      // schemaVersion で弾かれること（別の理由でたまたま落ちたのでは意味が薄い）
      expect(errs.some((e) => e.instancePath === '/schemaVersion')).toBe(true)
    }
  })

  it('**v2 schema は v1 相当の文書を拒む**', () => {
    const [, p] = profiles[0]
    expect(okV2({ ...p, schemaVersion: 1 })).toBe(false)
    expect((okV2.errors ?? []).some((e) => e.instancePath === '/schemaVersion')).toBe(true)
  })

  it('現物は v2 schema に適合する', () => {
    for (const [id, p] of profiles) {
      const ok = okV2(p)
      expect({ id, errs: ok ? [] : (okV2.errors ?? []).map((e) => `${e.instancePath}: ${e.message}`) })
        .toEqual({ id, errs: [] })
    }
  })
})

/**
 * 移行表は v0.5.0 で **history 形式**になった。
 * 記録と schema 実物の突き合わせは test/contractMigration.test.ts が見る。
 * ここで見るのは **profile 本体との整合**——表に書いた改名が本文で済んでいるか、である。
 */
interface Change { kind: string, effect: string, schemaPointer: string, added?: string[], removed?: string[] }
interface History { shippedIn: string, versionWasHeld: boolean, changes: Change[] }

describe('移行表が実態と合っている', () => {
  for (const [id, p] of profiles) {
    const cm = () => p.contractMigration
    const allChanges = (): Change[] => (cm().history as History[]).flatMap((h) => h.changes)

    it(`${id}: 宣言した改名が実際に済んでいる`, () => {
      // **宣言だけして直していない**が一番たちが悪い。表のとおり読んでも合わない
      const body = JSON.stringify({ intervals: p.intervals, events: p.events })
      const renames = mustBeNonEmpty(
        allChanges().filter((c) => c.kind === 'enum-value-renamed'),
        `${id} の改名表`,
      )
      for (const r of renames) {
        for (const from of mustBeNonEmpty(r.removed ?? [], `${r.schemaPointer} の旧語`)) {
          expect(body.includes(`"${from}"`), `旧語 ${from} が本体に残っている`).toBe(false)
        }
        expect(r.removed).not.toEqual(r.added)
      }
    })

    it(`${id}: topologyClass の改名先が現在の語彙に実在する`, () => {
      const renames = allChanges().filter((c) => c.schemaPointer.includes('topologyClass'))
      mustBeNonEmpty(renames, `${id} の topologyClass 改名`)
      for (const r of renames) {
        for (const to of mustBeNonEmpty(r.added ?? [], '改名先')) expect(ALL_TOPOLOGY_CLASSES).toContain(to)
      }
    })

    it(`${id}: 破壊的変更なら版が上がっている`, () => {
      expect(cm().breaking).toBe(true)
      expect(cm().toSchemaVersion).toBe(p.schemaVersion)
      expect(cm().fromSchemaVersion).toBeLessThan(cm().toSchemaVersion)
    })

    it(`${id}: 方式を選んだ根拠が書いてある`, () => {
      // 「なんとなく上げた」では、次に同じ判断をする人が同じ調査をやり直す
      expect(cm().policy.decisionRule).toBe('language-subset')
      expect(String(cm().policy.document)).toContain('SCHEMA_VERSIONING_POLICY')
      expect(String(cm().consumerAction)).toContain('schemaVersion')
    })
  }

  // **全 profile を見る。**片方だけ見ていると、もう片方から記録が消えても緑になる
  // (2026-08-03 の変異試験で実際にこの穴を踏んだ)
  for (const [id, p] of profiles) {
    it(`${id}: **v0.1.1 で schemaVersion を据え置いた失敗が表に残っている**`, () => {
      // 記録しておかないと、同じ判断がまた「追加のみだから据え置き」で通る
      const h = mustFind(
        p.contractMigration.history as History[],
        (x) => x.shippedIn === 'v0.1.1',
        `${id} の v0.1.1 の記録`,
      )
      expect(h.versionWasHeld, 'v0.1.1 は版を据え置いた回である').toBe(true)
      const spread = h.changes.filter((c) => c.schemaPointer.includes('spreadStatus'))
      expect(spread.length).toBeGreaterThan(0)
      expect(spread.flatMap((c) => c.removed ?? [])).toContain('MEASURED')
    })

    it(`${id}: **v0.4.0 で据え置いた失敗も表に残っている**`, () => {
      // v0.5.0 で是正した本体。ここが消えると「なぜ 6 本まとめて上げたか」が辿れなくなる
      const h = mustFind(
        p.contractMigration.history as History[],
        (x) => x.shippedIn === 'v0.4.0',
        `${id} の v0.4.0 の記録`,
      )
      expect(h.versionWasHeld).toBe(true)
      expect(h.changes.flatMap((c) => c.added ?? [])).toContain('input-scope')
    })
  }
})

describe('P2-6.1 `fully-seated` を捨てた', () => {
  it('現在の語彙に `fully-seated` が無い', () => {
    expect(ALL_TOPOLOGY_CLASSES).not.toContain('fully-seated' as never)
    expect(ALL_TOPOLOGY_CLASSES).toContain('all-expected-functions-match')
  })

  it('v2 schema の enum にも無い', () => {
    const tc = v2Schema.definitions.interval.properties.electricalTopology.properties.topologyClass
    expect(tc.enum).not.toContain('fully-seated')
    expect(tc.enum).toContain('all-expected-functions-match')
  })

  for (const [id, p] of profiles) {
    it(`${id}: **電気的に揃う深さと機械的な完全挿入の差が数字で出ている**`, () => {
      // 名前を直しただけでは同じ誤読が起きる。差を数字で見せる
      const mi = p.mechanicalInsertion
      expect(mi.completeAtMm).toBe(p.fullInsertionDepthMm)
      const iv = (p.intervals as { nominalStartMm: number; electricalTopology: { topologyClass: string } }[])
        .find((x) => x.electricalTopology.topologyClass === 'all-expected-functions-match')
      expect(mi.firstAllFunctionsMatchAtMm).toBe(iv?.nominalStartMm ?? null)
      if (iv) {
        expect(mi.gapMm).toBeCloseTo(p.fullInsertionDepthMm - iv.nominalStartMm, 4)
        // **差が 0 なら、そもそも改名の理由が無い。**0 でないことがこの項目の根拠
        expect(mi.gapMm).toBeGreaterThan(0)
      }
    })
  }
})

describe('P2-6.2 normalized の射程が機械可読になっている', () => {
  for (const [id, p] of profiles) {
    it(`${id}: profile 内の座標であると宣言している`, () => {
      expect(p.coordinateSystem.normalizedScope).toBe('PROFILE_LOCAL')
      expect(p.coordinateSystem.crossProfileComparable).toBe(false)
      expect(String(p.coordinateSystem.normalizedNote)).toContain('保証しない')
    })
  }

  it('**分母が profile ごとに違うので、同じ normalized は同じ深さではない**', () => {
    // crossProfileComparable: false の根拠そのもの
    const depths = profiles.map(([, p]) => p.fullInsertionDepthMm)
    const sameNormalized = 0.95
    const mm = depths.map((d) => d * sameNormalized)
    // 分母が同じなら差は 0 になる。どちらでも「宣言が正しい」ことは変わらないが、
    // 実際に違う場合は数字で示せる
    if (new Set(depths).size > 1) expect(new Set(mm).size).toBeGreaterThan(1)
    for (const [, p] of profiles) expect(p.coordinateSystem.crossProfileComparable).toBe(false)
  })
})

describe('P2-7 release evidence が自己完結している', () => {
  const paths = (RELEASE_ASSETS as { path: string; role: string }[]).map((a) => a.path)

  it('一覧の asset がすべて存在する', () => {
    for (const p of paths) expect(() => readFileSync(resolve(ROOT, p)), p).not.toThrow()
  })

  it('**v0.1.1 で入れ忘れた schema が入っている**', () => {
    // 入れ忘れの再発をここで止める。受け手は感度 artifact を検証できなかった
    expect(paths).toContain('schemas/event-sensitivity.v2.schema.json')
    expect(paths).toContain('schemas/topology-robustness.v3.schema.json')
    expect(paths).toContain('schemas/half-plug-topology-profile.v3.schema.json')
  })

  it('配布名が重複していない（片方が黙って上書きされる）', () => {
    const names = paths.map((p) => p.split('/').pop())
    expect(names.length).toBe(new Set(names).size)
  })

  it('artifact には対応する schema が同梱されている', () => {
    // artifact だけ渡して schema を渡さなければ、受け手は形を確かめられない
    const schemas = paths.filter((p) => p.startsWith('schemas/'))
    expect(schemas.length).toBeGreaterThanOrEqual(3)
    for (const a of paths.filter((p) => p.startsWith('artifacts/')))
      expect(schemas.length, `${a} 用の schema`).toBeGreaterThan(0)
  })

  it('検証結果が同梱され、全件適合している', () => {
    const v = J('artifacts/validation-results.json')
    expect(v.allPassed).toBe(true)
    expect(v.targetsPassed).toBe(v.targetsTotal)
    // 件数だけでなく本文も持っていること（0 件なら空配列）
    for (const r of v.results) expect(Array.isArray(r.semanticErrors)).toBe(true)
  })

  it('入力一覧が同梱され、artifact 間で食い違っていない', () => {
    const m = J('artifacts/source-input-manifest.json')
    expect(m.inconsistentAcrossArtifacts).toBe(0)
    expect(m.mismatchedWithWorkingTreeAtBuild).toBe(0)
    const inputs = mustBeNonEmpty(m.inputFiles as { path: string; consumedBy: string[] }[], '入力一覧')
    // profile の入力が 1 件も入っていなければ、この manifest は何も証明していない
    mustFind(inputs, (x) => x.path === 'package-lock.json', 'lockfile の記録')
    for (const x of inputs) expect(x.consumedBy.length).toBeGreaterThan(0)
  })

  it('**tag 時点のテスト件数が同梱される**', () => {
    // v0.1.1 では入っておらず、報告の 260 件が tag(258) か main かを判別できなかった
    expect(paths).toContain('artifacts/test_counts.json')
  })

  /**
   * **名前を実際の検査範囲まで狭めた**（v0.3.0 フォローアップ P1-1）。
   *
   * 2026-08-03 まで、このテストは「package.json の version が配布版と揃っている」という名前だった。
   * だが見ていたのは `stageRelease.mjs` の既定値だけで、**`package-lock.json` を一切参照していない。**
   * 名前のほうが広かったので、その名前を根拠に「parity は守られている」と判断し、
   * **v0.2.0 から続いていた `package.json: 0.3.0` / `package-lock.json: 0.1.0` の不一致を見逃した。**
   *
   * 名前が検査範囲より広いと、その名前が穴を隠す。
   */
  /**
   * **既定の版数を直書きしていないこと**（v0.4.0 で直した）。
   *
   * v0.1.1 tag では package.json が 0.1.0 のままで、release tooling の判定材料にできなかった。
   * その後は直書きの文字列と package.json を突き合わせていたが、
   * **採番のたびに手で直す必要があり、v0.4.0 で実際に忘れた。**
   * 突き合わせるのではなく、引くようにする。
   */
  it('stageRelease の既定 version を直書きしていない（package.json から引く）', () => {
    const stage = readFileSync(resolve(ROOT, 'scripts/stageRelease.mjs'), 'utf8')
    expect(stage).toMatch(/argOf\('version',\s*`v\$\{[^}]*package\.json/)
    // 直書きの版数が残っていないこと
    expect(stage).not.toMatch(/argOf\('version',\s*'v[\d.]+'\)/)
  })

  /**
   * **lockfile の version が package.json と揃っている（P1-1 で直した）。**
   *
   * v0.2.0 で `package.json` だけを上げ、lockfile は 0.1.0 のまま 2 版続いた。
   * 直前まで、このテストは**不一致が続いていることを主張する形**で置いてあった
   * （直した瞬間に落ちて、反転を忘れないようにするため）。ここがその反転後である。
   *
   * 判定の本体は `validate:profiles` の `packageVersionParity` にある。
   * **`check:stale` には入れていない**——`package.json` は入力ではないので、
   * version だけ上げても check:stale は「再実行は不要です」としか言わない（実測で確認した）。
   */
  it('**lockfile の version が package.json と揃っている**', () => {
    const pkg = J('package.json')
    const lock = J('package-lock.json')
    expect({ lockRoot: lock.version, lockSelf: lock.packages['']?.version, lockName: lock.name })
      .toEqual({ lockRoot: pkg.version, lockSelf: pkg.version, lockName: pkg.name })
  })

  it('parity の判定が release validation 側にある（テストだけの検査にしない）', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/validateProfiles.mjs'), 'utf8')
    expect(src).toContain('packageVersionParity')
    expect(src).toContain("artifact: 'package.json'")
  })
})
