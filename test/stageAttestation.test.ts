/**
 * **最終関門を通ったこと自体を残す（v0.6.17・外部監査 P1-F / §10）。**
 *
 * ## なぜ要るか
 *
 * `release:stage` の門（実測の突き合わせ・cross-binding・local 拒否）は
 * **通ったら黙って進む。**通った事実は CI のログと作業報告にしか残らず、
 * **配布物からは読めなかった。**
 *
 * `validation-results.releaseReadinessStatus: READY` は `release:evidence` 時点の判定で、
 * **最終関門を通った証拠ではない。**受け手がそれを「staging を通った」と読むと誤る。
 *
 * ## 索引に入れない理由（自己参照）
 *
 * 索引は `release:evidence` が作り、その時点で全 asset の sha256 を持つ。
 * attestation は**索引を読んでから**作るので、索引が自分の digest を持つと収束しない。
 * 代わりに **SHA256SUMS が持つ**（staging の最後に作られるので循環しない）。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
import { RELEASE_ASSETS, REQUIRED_CONSUMER_PINS } from '../scripts/releaseAssets.mjs'
import { CLI_RESULT_SCHEMA_PATH } from '../scripts/verifyReleaseSourceInputs.mjs'
import { mustBeNonEmpty } from './_must'

const ROOT = resolve(__dirname, '..')
const STAGE = readFileSync(resolve(ROOT, 'scripts/stageRelease.mjs'), 'utf8')

describe('release-stage-attestation', () => {
  const REQUIRED = [
    'releaseTag', 'stageCommand', 'stageToolVersion', 'generatedAt', 'sourceCommit',
    'testCountsSha256', 'validationResultsSha256', 'releaseIndexSha256',
    'exactTestEvidenceMatched', 'releaseReadinessStatus', 'exitCode',
  ] as const

  it('**監査が挙げた 11 項目を、すべて書いている**', () => {
    for (const k of REQUIRED) expect(STAGE, `${k} を書いていない`).toContain(`${k}:`)
  })

  it('**門の結果を控えてから書いている**（書きっぱなしの true でない）', () => {
    /** 判定は各門が通ったときにだけ立つ。**定数 true を書き込んでいないこと** */
    expect(STAGE).toContain('STAGE_GATES.exactTestEvidenceMatched = true')
    expect(STAGE).toContain('STAGE_GATES.testEvidenceCrossBound = true')
    expect(STAGE, '初期値が true になっている')
      .toMatch(/STAGE_GATES = \{ exactTestEvidenceMatched: false, testEvidenceCrossBound: false \}/)
    expect(STAGE, '門の結果でなく定数を書いている').not.toMatch(/exactTestEvidenceMatched: true,/)
  })

  it('**自己参照していない**（索引には入れず、SHA256SUMS が持つ）', () => {
    const names = RELEASE_ASSETS.map((a) => a.path.split('/').pop())
    expect(names, '索引が持つ asset 一覧に attestation を入れている')
      .not.toContain('release-stage-attestation.v1.json')
    /** SHA256SUMS の行は `rows` から作られるので、そこへ push していること */
    expect(STAGE, 'SHA256SUMS に載らない').toMatch(/rows\.push\(\{ name: ATTESTATION_NAME/)
    /** 索引の前ではなく後で作っていること（索引を読んで digest を取るため） */
    expect(STAGE.indexOf('ATTESTATION_NAME'), 'attestation を索引より前に作っている')
      .toBeGreaterThan(STAGE.indexOf('const INDEX_REL'))
  })

  /**
   * **配った実物を測っているか（v0.6.18・v0.6.17 の欠陥）。**
   *
   * v0.6.17 は `resolve(ROOT, ...)` を測っていた。写しである 2 つは同じ値になるが、
   * **索引だけは配布時に releaseTag / releaseCommit を書き込む**ので違う。
   * 結果、公開した attestation は
   *
   *   名乗り e9c72e24…（repo 側・releaseTag: null）
   *   配布物 a0147681…（受け手が計算する値）
   *
   * となり、受け手が突き合わせても一致しなかった（公開後に実測して発見）。
   *
   * **この検査はソースを読む。**staging を実際に回すとテストが 30 秒級になるため。
   * 代わりに「repo 側を測っていないこと」を名指しで見る。
   */
  it('**digest は配った実物（OUT）から測っている**', () => {
    const block = STAGE.slice(STAGE.indexOf('const ATTESTATION_NAME'))
    for (const k of ['testCountsSha256', 'validationResultsSha256', 'releaseIndexSha256']) {
      const line = block.split('\n').find((l) => l.trimStart().startsWith(`${k}:`))
      expect(line, `${k} を書いていない`).toBeTruthy()
      expect(line, `${k} が repo 側を測っている（配布物と違う値になる）`).toContain('resolve(OUT,')
      expect(line, `${k} が repo 側を測っている`).not.toContain('resolve(ROOT,')
    }
  })

  /**
   * **索引は写しではない**ことを、実物で確かめる（この検査の前提そのもの）。
   * 前提が崩れたら（配布時に何も書き込まなくなったら）上の検査は無意味になるので、
   * そのときはここが落ちて気づける。
   */
  it('配布する索引は repo 側と別物である（だから OUT を測る意味がある）', () => {
    expect(STAGE, '配布用の索引を書き込んでいない').toContain('stagedIndex')
    expect(STAGE, 'tag と commit を書き込んでいない')
      .toMatch(/stagedIndex = \{ \.\.\.idx, releaseTag: tag, releaseCommit: commit \}/)
  })

  it('自己申告であることを、成果物自身が名乗っている', () => {
    expect(STAGE, '自己申告だと書いていない').toContain('自己申告')
    expect(STAGE, '受け手の独立検証を置き換えないと書いていない').toContain('独立検証を置き換えない')
  })
})

/**
 * **受け手が固定すべきものを名指しする（v0.6.17・外部監査 §10）。**
 * 監査の指摘は「索引へ欄を足す必要はないが、`notes` だけを機械契約にするな」。
 * 値の正本は `assets[]`。ここが持つのは**どれを固定すべきかの名前**だけ。
 */
describe('受け手向けの必須 pin', () => {
  it('**4 種類をすべて名指ししている**', () => {
    mustBeNonEmpty([...REQUIRED_CONSUMER_PINS], '必須 pin')
    const want = [
      'verifyReleaseSourceInputs.mjs',
      CLI_RESULT_SCHEMA_PATH.split('/').pop() as string,
      'source-input-manifest.json',
    ]
    for (const w of want) expect(REQUIRED_CONSUMER_PINS, `${w} が pin に無い`).toContain(w)
    /** profile は 2 本ある */
    const profiles = REQUIRED_CONSUMER_PINS.filter((n) => n.includes('half_plug_topology_profile'))
    expect(profiles.length, 'profile が 2 本そろっていない').toBe(2)
  })

  it('**手書きの一覧になっていない**（配布一覧に実在するものだけ）', () => {
    const names = new Set(RELEASE_ASSETS.map((a) => a.path.split('/').pop()))
    for (const p of REQUIRED_CONSUMER_PINS) {
      expect(names.has(p), `${p} は配布物に無い（pin が古い）`).toBe(true)
    }
  })

  it('索引の notes が、その名前を実際に載せている', () => {
    const idx = JSON.parse(readFileSync(resolve(ROOT, 'artifacts/trs-jack-3d-release-index.v1.json'), 'utf8'))
    const notes = (idx.notes as string[]).join('\n')
    for (const p of REQUIRED_CONSUMER_PINS) expect(notes, `${p} を名指ししていない`).toContain(p)
    /** **notes 自身を機械契約にしないこと**を、notes が言っている */
    expect(notes, 'notes を分岐に使うなと書いていない').toContain('機械契約ではない')
  })

  /**
   * ⚠️ **件数を書かず、一覧から数える（v0.6.22・外部監査 P2）。**
   *
   * `notes` は「**受け手が固定すべき 4 点**」と書きながら、
   * その後ろに**ファイルを 5 つ**並べていた。一覧は `RELEASE_ASSETS` から
   * 引いているのに**数だけ手で書いていた**ので、profile が 2 本になった時点でずれた。
   * 数を書くなら一覧から数える——[[feedback-parts-must-sum-to-the-whole]] と同じ型。
   */
  it('notes が名乗る件数が、実際に並べた件数と合う', () => {
    const idx = JSON.parse(readFileSync(resolve(ROOT, 'artifacts/trs-jack-3d-release-index.v1.json'), 'utf8'))
    const line = (idx.notes as string[]).find((n) => n.includes('受け手が固定すべき'))
    expect(line, '受け手向けの note が無い').toBeTruthy()
    const claimed = /固定すべき\s*(\d+)\s*点/.exec(line as string)
    expect(claimed, '件数を手で書いている（一覧から数えること）').toBeNull()
    for (const p of REQUIRED_CONSUMER_PINS) expect(line as string, `${p} が並んでいない`).toContain(p)
  })
})

/**
 * ⚠️ **記録の形を、source text でなく実 object で検査する（v0.6.22・外部監査 P1）。**
 *
 * v0.6.21 までの検査は上の `STAGE`（`stageRelease.mjs` の**文字列**）だけを見ていた。
 * 「このコードに `exitCode:` と書いてあるか」は分かるが、
 * **生成された記録が契約に合うかは見ていない。**
 * 監査の指摘は「`schemaId` を名乗っているのに、その schema を配っていない」。
 *
 * ここでは 3 つを見る。
 *
 *   ① 配る一覧に schema が入っている（受け手が独立検証できる）
 *   ② 生成器が書く欄と、schema の必須欄が**同じ**である（2 つの一覧がずれない）
 *   ③ 壊した記録を schema が**拒む**（何でも通す schema でない）
 */
describe('最終関門の記録の契約（release-stage-attestation.v1.schema.json）', () => {
  const SCHEMA_PATH = 'schemas/release-stage-attestation.v1.schema.json'
  const schema = JSON.parse(readFileSync(resolve(ROOT, SCHEMA_PATH), 'utf8'))
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema)

  /** 契約に合う記録の見本（実物と同じ形。値は測ったものではない） */
  const VALID = {
    schemaVersion: 1,
    schemaId: 'trs-jack-3d-release-stage-attestation.v1',
    kind: 'release-stage-attestation',
    purpose: '最終関門を通ったことの記録。自己申告である。',
    releaseTag: 'v0.6.22',
    stageCommand: 'npm run release:stage',
    stageToolVersion: 1,
    generatedAt: '2026-08-15',
    sourceCommit: 'a'.repeat(40),
    testCountsSha256: 'b'.repeat(64),
    validationResultsSha256: 'c'.repeat(64),
    releaseIndexSha256: 'd'.repeat(64),
    exactTestEvidenceMatched: true,
    testEvidenceCrossBound: true,
    releaseReadinessStatus: 'READY',
    exitCode: 0,
    notInReleaseIndex: '索引はこの記録の sha256 を持たない。SHA256SUMS が持つ。',
  }

  it('① schema を配っている（受け手が独立検証できる）', () => {
    const paths = RELEASE_ASSETS.map((a) => a.path)
    expect(paths, 'schema を配布一覧へ入れていない').toContain(SCHEMA_PATH)
    /** 記録そのものは索引の外のまま（自己参照を避ける）。schema だけ入れる */
    expect(RELEASE_ASSETS.map((a) => a.path.split('/').pop()))
      .not.toContain('release-stage-attestation.v1.json')
  })

  it('② 生成器が書く欄と schema の必須欄が同じ（2 つの一覧がずれない）', () => {
    /** `const attestation = {` の直下の階層の key だけを取る */
    const start = STAGE.indexOf('const attestation = {')
    expect(start, '生成器の記録リテラルが見つからない（走査が壊れている）').toBeGreaterThan(0)
    const keys: string[] = []
    let depth = 0
    for (const raw of STAGE.slice(start).split('\n').slice(1)) {
      const m = /^\s{4}([A-Za-z][A-Za-z0-9]*):/.exec(raw)
      if (depth === 0 && m) keys.push(m[1])
      depth += (raw.match(/[[{]/g) ?? []).length - (raw.match(/[\]}]/g) ?? []).length
      if (depth < 0) break
    }
    expect(keys.length, '欄を 1 つも拾えていない（走査が壊れている）').toBeGreaterThanOrEqual(15)
    expect([...keys].sort(), '生成器の欄と schema の必須欄が食い違っている')
      .toEqual([...(schema.required as string[])].sort())
  })

  it('③ 契約に合う記録を通す', () => {
    expect(validate(VALID), JSON.stringify(validate.errors)).toBe(true)
  })

  it('③-b **壊した記録を拒む**（何でも通す schema ではない）', () => {
    const broken: [string, object][] = [
      ['digest が 63 桁', { ...VALID, testCountsSha256: 'b'.repeat(63) }],
      ['commit が短縮形', { ...VALID, sourceCommit: 'a'.repeat(12) }],
      ['exact が false', { ...VALID, exactTestEvidenceMatched: false }],
      ['cross が false', { ...VALID, testEvidenceCrossBound: false }],
      ['READY でない', { ...VALID, releaseReadinessStatus: 'NOT_READY' }],
      ['READY なのに exit が 0 でない', { ...VALID, exitCode: 1 }],
      ['tag が空（打つ前）', { ...VALID, releaseTag: '' }],
      ['未知の欄が増えた', { ...VALID, zzExtra: 1 }],
    ]
    for (const [name, obj] of broken) {
      expect(validate(obj), `**${name}** を通してしまう`).toBe(false)
    }
    /** 必須欄を 1 つずつ落として、全部拒まれること */
    for (const k of schema.required as string[]) {
      const o = { ...VALID } as Record<string, unknown>
      delete o[k]
      expect(validate(o), `必須欄 ${k} が無くても通してしまう`).toBe(false)
    }
  })

  it('③-c 生成器が**書く前に**検証している（壊れた記録を OUT に残さない）', () => {
    const v = STAGE.indexOf('release-stage-attestation.v1.schema.json')
    const w = STAGE.indexOf('writeFileSync(resolve(OUT, ATTESTATION_NAME)')
    expect(v, '生成器が schema を読んでいない').toBeGreaterThan(0)
    expect(w, '記録を書く行が見つからない').toBeGreaterThan(0)
    expect(v, '検証が書き込みより後にある（落ちても記録が残る）').toBeLessThan(w)
    expect(STAGE, '検証に落ちても止まらない').toMatch(/validate\(attestation\)[\s\S]{0,400}?process\.exit\(1\)/)
  })
})
