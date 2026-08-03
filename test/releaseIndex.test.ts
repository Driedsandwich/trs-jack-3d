/**
 * release index / evidence schema / 配布区分 / 窓の端点。
 * v0.2.0 非阻害フォローアップオーダー §1〜§4 に対応する。
 *
 * ## 何を直したかったか
 *
 * v0.2.0 では、下流が lock を**報告文から手で転記して**作っていた。転記ミスの余地がある。
 * また `validation-results.json` の 9 対象のうち 2 件は配布しないため、
 * 受け手が「9 件すべてを bundle だけで独立再検証できる」と読みうる状態だった。
 *
 * ## この試験群が守るもの
 *
 *   §1 索引が profile / 感度 / asset の値を**実物と一致した形で**持っていること
 *   §2 evidence が schema を持ち、その schema に適合すること
 *   §3 配布する対象としない対象が artifact 自身で見分けられること
 *   §4 窓の端点が profile の区間と**そのまま**突き合わせられること
 */

import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
import { RELEASE_ASSETS, SOURCE_ONLY_TARGETS } from '../scripts/releaseAssets.mjs'
import { mustBeNonEmpty, mustFind } from './_must'

const ROOT = resolve(__dirname, '..')
const J = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))
const sha256 = (p: string) => createHash('sha256').update(readFileSync(resolve(ROOT, p))).digest('hex')

const INDEX_PATH = 'artifacts/trs-jack-3d-release-index.v1.json'
const index = J(INDEX_PATH)
const validation = J('artifacts/validation-results.json')
const manifest = J('artifacts/source-input-manifest.json')
const robustness = J('artifacts/topology-robustness.trs_jack_trrs.json')
const trrs = J('artifacts/half_plug_topology_profile.v2.trs_jack_trrs.json')

const ajv = new Ajv({ allErrors: true, strict: false })
/** **同じ schema を 2 回 compile しない。** ajv は $id の重複を拒む */
const cache = new Map<string, ReturnType<typeof ajv.compile>>()
const compile = (p: string) => {
  if (!cache.has(p)) cache.set(p, ajv.compile(J(p)))
  return cache.get(p)!
}
const shippedPaths = new Set(RELEASE_ASSETS.map((a) => a.path))

describe('§1 release index — 下流が手で転記しなくて済む', () => {
  it('索引が release asset に入っている', () => {
    expect([...shippedPaths]).toContain(INDEX_PATH)
  })

  it('**索引自身は索引に載っていない**（自己参照になる）', () => {
    const names = (index.assets as { filename: string }[]).map((a) => a.filename)
    expect(names).not.toContain('trs-jack-3d-release-index.v1.json')
  })

  it('載っている asset の sha256 が実ファイルと一致する', () => {
    // ここがずれると、下流が索引から lock を作った時点で byte 検証が落ちる
    const byName = new Map(RELEASE_ASSETS.map((a) => [a.path.split('/').pop()!, a.path]))
    const assets = mustBeNonEmpty(index.assets as { filename: string; sha256: string }[], '索引の asset')
    for (const a of assets) {
      const p = mustFind([...byName.keys()], (k) => k === a.filename, `${a.filename} の配布元`)
      expect(a.sha256, a.filename).toBe(sha256(byName.get(p)!))
    }
  })

  it('索引の asset 数が配布一覧と合う（索引自身を除く）', () => {
    expect(index.assets.length).toBe(RELEASE_ASSETS.length - 1)
  })

  for (const [variantId, file] of [
    ['TRS|JACK-TRS', 'artifacts/half_plug_topology_profile.v2.trs_jack_trs.json'],
    ['TRS|JACK-TRRS', 'artifacts/half_plug_topology_profile.v2.trs_jack_trrs.json'],
  ] as const) {
    it(`${variantId}: 索引の値が profile の実物と一致する`, () => {
      const p = J(file)
      const e = index.profiles[variantId]
      expect(e, `${variantId} の項目`).toBeDefined()
      expect(e.filename).toBe(file.split('/').pop())
      expect(e.profileId).toBe(p.profileId)
      expect(e.inputDigest).toBe(p.provenance.inputDigest)
      expect(e.sha256).toBe(sha256(file))
      expect(e.generatedFromCommit).toBe(p.provenance.generatedFromCommit)
    })

    it(`${variantId}: 感度 asset の値も実物と一致する`, () => {
      const slug = variantId.toLowerCase().replace(/[^a-z0-9]+/g, '_')
      const sensPath = `artifacts/sensitivity.${slug}.json`
      const sens = J(sensPath)
      const e = index.profiles[variantId].sensitivityAsset
      expect(e.filename).toBe(sensPath.split('/').pop())
      expect(e.sha256).toBe(sha256(sensPath))
      expect(e.inputDigest).toBe(sens.provenance.inputDigest)
      expect(e.generatedFromCommit).toBe(sens.provenance.generatedFromCommit)
    })
  }

  it('**生成 commit を 1 つに潰していない**', () => {
    // release 工程が 2 段階なので、profile と感度・頑健性は違う commit で作られうる。
    // 単一の artifactGenerationCommit だけを見ると、片方が必ず食い違う
    const groups = mustBeNonEmpty(
      index.artifactGenerationCommits as { commit: string; assets: string[] }[],
      '生成 commit の内訳',
    )
    const listed = groups.flatMap((g) => g.assets)
    const withCommit = (index.assets as { filename: string; generatedFromCommit?: string }[])
      .filter((a) => a.generatedFromCommit)
      .map((a) => a.filename)
    expect([...listed].sort()).toEqual([...withCommit].sort())
    for (const g of groups) expect(g.commit).toMatch(/^([0-9a-f]{40}|UNKNOWN)$/)
  })

  it('`artifactGenerationCommit` が profile の生成 commit と一致する', () => {
    // 下流の lock が既定で照合する値。profile 以外を指していたら意味を成さない
    const p = J('artifacts/half_plug_topology_profile.v2.trs_jack_trs.json')
    expect(index.artifactGenerationCommit).toBe(p.provenance.generatedFromCommit)
  })

  it('**tag を知らないうちは null のまま**（分からないものを埋めない）', () => {
    // evidence をコミットしてから tag を打つので、生成時点では知りようがない。
    // 埋めてしまうと「この索引は tag を指している」という嘘になる
    for (const k of ['releaseTag', 'releaseCommit']) {
      const v = index[k]
      expect(v === null || typeof v === 'string', `${k} は null か文字列`).toBe(true)
    }
    expect(index.evidenceBuiltAtCommit).toMatch(/^([0-9a-f]{40}|UNKNOWN)$/)
    expect((index.notes as string[]).join('\n')).toContain('null なら、まだ tag を打っていない')
  })

  it('profile schema の版と ID を持っている', () => {
    expect(index.profileSchemaVersion).toBe(trrs.schemaVersion)
    expect(index.profileSchemaId).toBe(trrs.schemaId)
  })
})

describe('§2 evidence が schema を持ち、それに適合する', () => {
  for (const [artifact, schema] of [
    ['artifacts/validation-results.json', 'schemas/validation-results.v1.schema.json'],
    ['artifacts/source-input-manifest.json', 'schemas/source-input-manifest.v1.schema.json'],
    [INDEX_PATH, 'schemas/trs-jack-3d-release-index.v1.schema.json'],
  ] as const) {
    it(`${artifact.split('/').pop()} が schema に適合する`, () => {
      expect(existsSync(resolve(ROOT, schema)), `${schema} が無い`).toBe(true)
      const v = compile(schema)
      const ok = v(J(artifact))
      expect({ artifact, errs: ok ? [] : (v.errors ?? []).map((e) => `${e.instancePath}: ${e.message}`) })
        .toEqual({ artifact, errs: [] })
    })

    it(`${schema.split('/').pop()} が配布される`, () => {
      // schema を配らなければ、受け手は形を確かめられない
      expect([...shippedPaths]).toContain(schema)
    })
  }

  it('**schema が実際に効く**（壊した文書を弾く）', () => {
    // 通るだけの schema では意味がない
    const v = compile('schemas/validation-results.v1.schema.json')
    expect(v({ ...validation, schemaVersion: 2 })).toBe(false)
    expect(v({ ...validation, results: [] })).toBe(false)
    const m = compile('schemas/source-input-manifest.v1.schema.json')
    expect(m({ ...manifest, inputFiles: [] })).toBe(false)
    const i = compile('schemas/trs-jack-3d-release-index.v1.schema.json')
    expect(i({ ...index, profiles: {} })).toBe(false)
  })
})

describe('§3 配布する対象としない対象が見分けられる', () => {
  it('すべての target に配布区分が付いている', () => {
    const rs = mustBeNonEmpty(validation.results as { artifact: string; distribution: string }[], '検証対象')
    for (const r of rs) expect(['RELEASE_ASSET', 'SOURCE_ONLY']).toContain(r.distribution)
  })

  it('配布区分が実際の配布一覧と一致する', () => {
    // ここが嘘だと、受け手は「bundle に入っている」と思って探し、見つからない
    for (const r of validation.results as { artifact: string; distribution: string }[])
      expect({ a: r.artifact, d: r.distribution })
        .toEqual({ a: r.artifact, d: shippedPaths.has(r.artifact) ? 'RELEASE_ASSET' : 'SOURCE_ONLY' })
  })

  it('配布数と非配布数の合計が対象数と合う', () => {
    expect(validation.distributedTargets + validation.sourceOnlyTargets).toBe(validation.targetsTotal)
    expect(validation.targetsTotal).toBe(validation.results.length)
  })

  it('**非配布の対象が実在する**（0 件ならこの区分は何も表していない）', () => {
    expect(validation.sourceOnlyTargets).toBeGreaterThan(0)
    const declared = SOURCE_ONLY_TARGETS.map((t) => t.path).sort()
    const actual = (validation.results as { artifact: string; distribution: string }[])
      .filter((r) => r.distribution === 'SOURCE_ONLY').map((r) => r.artifact).sort()
    expect(actual).toEqual(declared)
  })

  it('受け手向けの断りが本文に入っている', () => {
    expect(String(validation.note)).toContain('SOURCE_ONLY')
  })
})

describe('§4 窓の端点が profile と突き合わせられる', () => {
  const windows = [
    ...(robustness.nominalConfiguration.windows as Record<string, number>[]),
    ...(robustness.counterExamples as { windows: Record<string, number>[] }[]).flatMap((c) => c.windows),
  ]

  it('版が上がり、端点の規約が機械可読になっている', () => {
    expect(robustness.schemaVersion).toBe(2)
    expect(robustness.windowEndConvention).toBe('EXCLUSIVE')
    expect(robustness.contractMigration.breaking).toBe(true)
    expect(robustness.contractMigration.toSchemaVersion).toBe(2)
  })

  it('**旧項目名が本体に残っていない**', () => {
    // 宣言だけして直していないのが一番たちが悪い
    const body = JSON.stringify({ n: robustness.nominalConfiguration, c: robustness.counterExamples })
    for (const r of robustness.contractMigration.renamedFields as { from: string; to: string }[]) {
      expect(body.includes(`"${r.from}":`), `旧項目 ${r.from} が残っている`).toBe(false)
      expect(body.includes(`"${r.to}":`), `新項目 ${r.to} が無い`).toBe(true)
    }
  })

  it('端点どうしの算術が合う', () => {
    mustBeNonEmpty(windows, '窓')
    for (const w of windows) {
      expect(w.lastSampleMm).toBeGreaterThanOrEqual(w.startMm)
      expect(w.endExclusiveMm).toBeCloseTo(w.lastSampleMm + robustness.stepMm, 6)
      expect(w.widthMm).toBeCloseTo(w.endExclusiveMm - w.startMm, 6)
    }
  })

  it('**無改造の窓が profile の区間とそのまま一致する**', () => {
    // v1 では toMm が最後の標本位置で、profile の終端と 1 刻みずれて見えた。
    // 端点を分けた目的はここが直接突き合わせられることにある
    const iv = mustFind(
      trrs.intervals as { intervalId: string; nominalStartMm: number; nominalEndMm: number; electricalTopology: { topologyClass: string } }[],
      (x) => x.electricalTopology.topologyClass === robustness.targetTopologyClass,
      `profile の ${robustness.targetTopologyClass} 区間`,
    )
    const w = mustBeNonEmpty(robustness.nominalConfiguration.windows as Record<string, number>[], '無改造の窓')[0]
    expect(w.startMm).toBeCloseTo(iv.nominalStartMm, 6)
    expect(w.endExclusiveMm).toBeCloseTo(iv.nominalEndMm, 6)
    // lastSampleMm は区間の終端ではない。**この 2 つを取り違えないことが要点**
    expect(w.lastSampleMm).not.toBeCloseTo(iv.nominalEndMm, 6)
  })
})
