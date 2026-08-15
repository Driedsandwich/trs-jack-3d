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
})
