/**
 * **受け手向けの CLI 結果の契約（v0.6.11・外部監査 §7）。**
 *
 * ## なぜ別の schema が要るか
 *
 * v0.6.10 まで、受け手はこの道具の出力を読むのに
 * `source-verification-result.v1`（**こちらが回した記録**）の説明を使うしかなかった。
 * だがその 2 つは**出る status が違う**——記録側は作業ツリーを読む経路なので
 * `ARCHIVE_INVALID` も `ARCHIVE_UNSUPPORTED` も `VERIFICATION_INCOMPLETE` も出ない。
 * **記録側の enum を CLI の一覧として読むと取りこぼす。**
 *
 * ## この試験の考え方
 *
 * schema を手で読んで「たぶん合う」と言わない。
 * **実際に道具を走らせて、出てきた JSON を ajv へ通す。**
 * status ごとに 1 本ずつ経路を踏み、**全部の経路が同じ契約に収まる**ことを見る。
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Ajv from 'ajv'
import { afterAll, describe, expect, it } from 'vitest'
import { CLI_STATUSES } from '../scripts/verifyReleaseSourceInputs.mjs'
import { mustBeNonEmpty } from './_must'

const ROOT = resolve(__dirname, '..')
const SCHEMA_PATH = 'schemas/source-verifier-cli-result.v1.schema.json'
const SCHEMA = JSON.parse(readFileSync(resolve(ROOT, SCHEMA_PATH), 'utf8'))
const validate = new Ajv({ allErrors: true, strict: false }).compile(SCHEMA)

const tmps: string[] = []
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })))

function run(args: string[]): { code: number, json: Record<string, unknown> } {
  try {
    const out = execFileSync('node', ['scripts/verifyReleaseSourceInputs.mjs', ...args], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28,
    })
    return { code: 0, json: JSON.parse(out) }
  } catch (e) {
    const err = e as { status?: number, stdout?: string }
    return { code: err.status ?? -1, json: JSON.parse(String(err.stdout ?? '{}')) }
  }
}

/** 一時ディレクトリに 1 ファイル置いて、その path を返す */
function tmpFile(name: string, body: string): string {
  const d = mkdtempSync(join(tmpdir(), 'cli-result-'))
  tmps.push(d)
  const p = join(d, name)
  writeFileSync(p, body)
  return p
}

const MANIFEST = 'artifacts/source-input-manifest.json'

/**
 * **status ごとに 1 本ずつ実際の経路を踏む。**
 * 手で JSON を組み立てると、道具が本当にその形を出すかを確かめられない。
 */
const CASES: readonly (readonly [string, string[]])[] = [
  ['OK', ['--manifest', MANIFEST, '--source', '.']],
  ['MISMATCH', ['--manifest', tmpFile('m.json', JSON.stringify({
    ...JSON.parse(readFileSync(resolve(ROOT, MANIFEST), 'utf8')),
    inputFiles: JSON.parse(readFileSync(resolve(ROOT, MANIFEST), 'utf8'))
      .inputFiles.map((f: Record<string, unknown>, i: number) =>
        (i === 0 ? { ...f, recordedSha256: '0'.repeat(64) } : f)),
  })), '--source', '.']],
  ['VERIFICATION_INCOMPLETE', ['--manifest', MANIFEST, '--source', '.', '--scope', '/nonexistent/scope.json']],
  ['SOURCE_UNAVAILABLE', ['--manifest', MANIFEST, '--source', '/nonexistent/dir']],
  ['MANIFEST_UNAVAILABLE', ['--manifest', '/nonexistent/manifest.json', '--source', '.']],
  ['NOTHING_TO_VERIFY', ['--manifest', tmpFile('empty.json', JSON.stringify({
    schemaVersion: 2, inputFiles: [], inputFilesTotal: 0,
  })), '--source', '.']],
]

describe('source-verifier-cli-result.v1 — 受け手向けの契約', () => {
  it('**schema は Draft-07 として成立している**', () => {
    expect(SCHEMA.$schema).toBe('http://json-schema.org/draft-07/schema#')
    expect(typeof validate).toBe('function')
  })

  it.each(CASES.map(([name, args]) => [name, args] as const))(
    '%s の出力が schema に適合する（実際に走らせて確かめる）',
    (expected, args) => {
      const r = run([...args])
      expect(r.json.status, `${expected} を出す経路のはずが違った`).toBe(expected)
      const ok = validate(r.json)
      expect(ok, JSON.stringify(validate.errors?.slice(0, 4))).toBe(true)
      // exitCode は出力にも入っている（保存したあとに復元できないため）
      expect(r.json.exitCode).toBe(r.code)
    },
  )

  /**
   * **archive 系の 2 つは、壊れた archive を渡さないと出ない。**
   * corpus の材料をそのまま source として渡す。
   */
  it.each([
    ['ARCHIVE_INVALID', 'traversal'],
    ['ARCHIVE_UNSUPPORTED', 'entryType'],
  ] as const)('%s の出力が schema に適合する', async (expected, group) => {
    const { allCases } = await import('./_corruptTar.mjs')
    const list = (allCases() as Record<string, { id: string, tar: Buffer, ok?: boolean }[]>)[group]
    const c = mustBeNonEmpty(list.filter((x) => !x.ok), `${group} の止まる材料`)[0]
    const d = mkdtempSync(join(tmpdir(), 'cli-arch-'))
    tmps.push(d)
    const p = join(d, 'src.tar')
    writeFileSync(p, c.tar)
    const r = run(['--manifest', MANIFEST, '--source', p])
    expect(r.json.status, `${c.id} で ${expected} を期待した`).toBe(expected)
    const ok = validate(r.json)
    expect(ok, JSON.stringify(validate.errors?.slice(0, 4))).toBe(true)
    expect(r.json.stableReasonCode, '止めたのに理由の名前が無い').toBeTypeOf('string')
  })

  /**
   * **enum が道具の一覧と一致している。**
   * 片方だけ増えると、受け手は来ない分岐を実装するか、来る値を落とす。
   */
  it('**status の enum が道具の一覧と過不足なく一致する**', () => {
    const inSchema = [...(SCHEMA.properties.status.enum as string[])].sort()
    expect(inSchema).toEqual([...CLI_STATUSES].sort())
  })

  /**
   * **監査の草案には `INTERNAL_ERROR` があるが、入れていない。**
   * この道具は出さないので、書くと「出うる」と嘘をつく。
   * **草案どおりに書くほうが楽だが、受け手は来ない分岐を実装することになる。**
   */
  it('道具が出さない status は enum に無い', () => {
    expect(SCHEMA.properties.status.enum).not.toContain('INTERNAL_ERROR')
    expect(CLI_STATUSES).not.toContain('INTERNAL_ERROR')
  })

  it('**この試験が空振りしていない**（契約を外れた JSON は落ちる）', () => {
    const r = run(['--manifest', MANIFEST, '--source', '.'])
    expect(validate(r.json)).toBe(true)
    // status を enum の外へ変えると落ちること
    expect(validate({ ...r.json, status: 'SOMETHING_ELSE' })).toBe(false)
    // 必須項目を落とすと落ちること
    const { archivePolicy, ...without } = r.json as Record<string, unknown>
    expect(archivePolicy, 'archivePolicy が出ていない').toBeTruthy()
    expect(validate(without)).toBe(false)
  })
})
