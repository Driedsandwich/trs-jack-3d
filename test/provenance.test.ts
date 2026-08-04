/**
 * artifact provenance の受入試験。統合オーダー 2026-08-03 P0-1 の 7 項目。
 *
 * ## 何を守っているか
 *
 * 「この artifact は何から作られたか」を、**第三者が検算できる形**で残すこと。
 * 監査で指摘されたのは、コミット済み profile の `sourceRevision` が
 * 実際の生成入力を表していなかったことだった。
 *
 * ただし `sourceRevision === HEAD` を要求してはいけない。
 * **artifact を含めてコミットすると HEAD が変わるので自己参照になる。**
 * そこで入力ファイルの中身そのものを指紋 (`inputDigest`) にしてある。
 *
 * ## 7 項目の割り当て
 *
 *   1. clean checkout から生成            … ここ (規則) + `npm run verify:provenance` (実走)
 *   2. 入力 1 文字変更で inputDigest が変わる … ここ
 *   3. artifact だけの再コミットでは変わらない … ここ
 *   4. dirty tree で release モードが失敗     … ここ
 *   5. 同一入力・同一日で byte-identical      … ここ (実際に 2 回生成して比べる)
 *   6. 根拠件数と生成元データの件数が一致     … ここ
 *   7. stale な SOURCE_REVISION で失敗        … ここ
 *
 * 項目 1 だけ実走を別コマンドへ出している。作業ツリーが clean かどうかで
 * 結果が変わるテストは、**開発中は必ず落ちる**（入力を直している最中なので）。
 * 規則そのものはここで、実際の clean checkout は `npm run verify:provenance` で見る。
 */

import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CONTRACT_MIGRATION_FILE, INPUT_SCOPE_FILE, assertReleaseAllowed, buildProvenance, listInputs } from '../scripts/provenance'
import { getModel } from '../src/data'
import { mustFind } from './_must'

const ROOT = resolve(__dirname, '..')
const PROFILE = resolve(ROOT, 'artifacts/half_plug_topology_profile.v3.trs_jack_trs.json')
const profile = JSON.parse(readFileSync(PROFILE, 'utf8'))

const tmps: string[] = []
const mkTmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'trs-prov-'))
  tmps.push(d)
  return d
}
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })))

/** 入力だけを複製した仮の root を作る。実物には触らない */
function cloneInputs(): string {
  const d = mkTmp()
  for (const sub of ['schemas', 'scripts', 'src/data', 'src/model', 'artifacts'])
    cpSync(resolve(ROOT, sub), join(d, sub), { recursive: true })
  cpSync(resolve(ROOT, 'package-lock.json'), join(d, 'package-lock.json'))
  // **範囲定義も入力である**（v0.3.0 フォローアップ P1-2）。
  // 無いと listInputs が落ちる——既定値へ黙って戻さない設計なので、それが正しい
  cpSync(resolve(ROOT, INPUT_SCOPE_FILE), join(d, INPUT_SCOPE_FILE))
  cpSync(resolve(ROOT, CONTRACT_MIGRATION_FILE), join(d, CONTRACT_MIGRATION_FILE))
  return d
}

const digestOf = (root: string) =>
  buildProvenance({
    root,
    command: 'test',
    artifactDate: '2026-08-03',
    release: false,
    allowRevisionOverride: false,
  }).inputDigest

describe('P0-1 provenance の受入試験', () => {
  it('0. 生成済み profile が provenance を持っている（前提そのものの確認）', () => {
    // これが無ければ以降の検査はすべて空振りする
    expect(profile.provenance, 'provenance が無い').toBeTruthy()
    for (const k of [
      'generatorVersion',
      'generatedFromCommit',
      'workingTreeDirty',
      'revisionOverride',
      'artifactKind',
      'inputDigestAlgorithm',
      'inputDigest',
      'inputDigestScope',
      'inputFiles',
      'command',
      'artifactDate',
    ])
      expect({ k, present: k in profile.provenance }).toEqual({ k, present: true })
    expect(profile.provenance.inputFiles.length).toBeGreaterThan(10)
  })

  it('1. clean な入力なら workingTreeDirty は false になる（規則）', () => {
    // 実走は npm run verify:provenance。ここでは「何を見て dirty と判定するか」を固定する。
    // **入力ファイルだけを見る**こと。木全体を見ると、artifact を書き出した直後は
    // 必ず dirty になり、clean な入力からでも release を作れなくなる。
    const files = listInputs(ROOT).map((f) => f.path)
    expect(files.length).toBeGreaterThan(10)
    for (const f of files)
      expect({ f, isArtifactOutput: /half_plug_topology_profile/.test(f) }).toEqual({
        f,
        isArtifactOutput: false,
      })
    // 生成物のディレクトリを丸ごと入力にしていないこと。
    // **感度 artifact は variant 別になった** (統合フォローアップ P1-2)。
    // variantSlug を渡さない listInputs は、どの感度 artifact も入力にしない
    expect(files.filter((f) => f.startsWith('artifacts/'))).toEqual([])
    expect(listInputs(ROOT, 'trs_jack_trs').map((f) => f.path).filter((f) => f.startsWith('artifacts/'))).toEqual([
      'artifacts/sensitivity.json',
      'artifacts/sensitivity.trs_jack_trs.json',
    ])
    expect(listInputs(ROOT, 'trs_jack_trrs').map((f) => f.path).filter((f) => f.startsWith('artifacts/'))).toEqual([
      'artifacts/sensitivity.trs_jack_trrs.json',
    ])
  })

  it('2. **入力を 1 文字変えると inputDigest が変わる**', () => {
    const a = cloneInputs()
    const before = digestOf(a)
    // 寸法の note を 1 文字だけ足す
    const p = join(a, 'src/data/dimensions.json')
    writeFileSync(p, readFileSync(p, 'utf8').replace('"entries"', '"entries" '))
    const after = digestOf(a)
    expect({ changed: before !== after }).toEqual({ changed: true })
  })

  it('3. **artifact だけを書き換えても inputDigest は変わらない**（自己参照を避ける）', () => {
    // 監査の指摘の核心。artifact を含めてコミットすると HEAD が変わるので、
    // revision で固定すると「生成時点で正しかった値」がコミット後に古く見える。
    const a = cloneInputs()
    const before = digestOf(a)
    const p = join(a, 'artifacts/half_plug_topology_profile.v3.trs_jack_trs.json')
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), profileId: 'まったく別の値' }))
    expect({ unchanged: digestOf(a) === before }).toEqual({ unchanged: true })
    // profileId も digest から作っているので、同じ入力なら同じ ID になる
    expect(profile.profileId.endsWith(profile.provenance.inputDigest.slice(0, 12))).toBe(true)
  })

  it('4. **入力が dirty なら release モードは失敗する**', () => {
    expect(() => assertReleaseAllowed(true, true, 'M src/data/dimensions.json')).toThrowError(/clean な入力からしか/)
    // 通常モードは dirty でも通る（開発中は常に dirty なので）
    expect(() => assertReleaseAllowed(false, true)).not.toThrow()
    // clean なら release も通る
    expect(() => assertReleaseAllowed(true, false)).not.toThrow()
  })

  it('5. **同じ入力・同じ日から 2 回生成すると byte-identical**', () => {
    const out = mkTmp()
    const run = () =>
      execFileSync('npx', [
        'vite-node',
        'scripts/exportHalfPlugProfile.ts',
        '--variant',
        'TRS|JACK-TRS',
        '--out',
        out,
      ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ARTIFACT_DATE: '2026-08-03' }, stdio: ['ignore', 'pipe', 'pipe'] })
    run()
    const first = readFileSync(join(out, 'half_plug_topology_profile.v3.trs_jack_trs.json'))
    run()
    const second = readFileSync(join(out, 'half_plug_topology_profile.v3.trs_jack_trs.json'))
    expect({ bytes: first.length, identical: first.equals(second) }).toEqual({
      bytes: first.length,
      identical: true,
    })
  }, 60_000)

  it('6. **profile の根拠件数が、生成元の台帳と一致する**', () => {
    const counts: Record<string, number> = { FACT: 0, DERIVED: 0, ASSUMPTION: 0, UNKNOWN: 0 }
    for (const v of Object.values(getModel('TRS|JACK-TRS').dims.all())) counts[v.grade]++
    expect(profile.assumptionSummary.counts).toEqual(counts)
    // 台帳が inputFiles に入っていること（入っていなければ digest が件数の変化に反応しない）
    mustFind(
      profile.provenance.inputFiles as { path: string }[],
      (f) => f.path === 'src/data/dimensions.json',
      'inputFiles の中の dimensions.json',
    )
  })

  it('7. **食い違う SOURCE_REVISION は通常モードでは受け付けない**', () => {
    const opts = {
      root: ROOT,
      command: 'test',
      artifactDate: '2026-08-03',
      release: false,
      envRevision: '0'.repeat(40), // 実在しない改訂
    }
    expect(() => buildProvenance({ ...opts, allowRevisionOverride: false })).toThrowError(/食い違っている/)
    // 明示のオプションがあれば通り、上書きしたことが記録に残る
    const p = buildProvenance({ ...opts, allowRevisionOverride: true })
    expect({ commit: p.generatedFromCommit, override: p.revisionOverride }).toEqual({
      commit: '0'.repeat(40),
      override: true,
    })
    // 実際の HEAD と同じ値なら、上書きとして扱わない
    const head = buildProvenance({ ...opts, envRevision: undefined, allowRevisionOverride: false })
    const same = buildProvenance({ ...opts, envRevision: head.generatedFromCommit, allowRevisionOverride: false })
    expect(same.revisionOverride).toBe(false)
  })
})
