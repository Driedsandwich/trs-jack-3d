/**
 * tag source の独立検算 helper。
 * v0.2.0 非阻害フォローアップオーダー §5 に対応する。
 *
 * ## 何を守るか
 *
 * この script は**受け手が「こちらの自己申告を信じずに確かめる」ための道具**である。
 * だから守るべきものが 3 つある。
 *
 *   1. **read-only であること。**受け手の source tree を書き換える道具は使ってもらえない
 *   2. **取れなかったのと合わなかったのを混ぜないこと。**
 *      両方を「失敗」に潰すと、検証していないのに「壊れている」と読める
 *   3. **0 件を検証して OK と言わないこと。**空振りは最悪の合格である
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { mustBeNonEmpty } from './_must'

const ROOT = resolve(__dirname, '..')
const SCRIPT = 'scripts/verifyReleaseSourceInputs.mjs'
const SRC = readFileSync(resolve(ROOT, SCRIPT), 'utf8')

const tmps: string[] = []
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })))

/** script を走らせて {code, json} を返す。**落ちても JSON は出る** */
function run(args: string[]): { code: number; json: Record<string, unknown> } {
  try {
    const out = execFileSync('node', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
    return { code: 0, json: JSON.parse(out) }
  } catch (e) {
    const err = e as { status?: number; stdout?: string }
    return { code: err.status ?? -1, json: JSON.parse(String(err.stdout ?? '{}')) }
  }
}

/** v0.2.0 tag が記録した manifest を一時ファイルへ出す（**script は書かない。テストが書く**） */
function tagManifest(mutate?: (d: Record<string, unknown>) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'vrsi-'))
  tmps.push(dir)
  const raw = execFileSync('git', ['show', 'v0.2.0:artifacts/source-input-manifest.json'], { cwd: ROOT, encoding: 'utf8' })
  const d = JSON.parse(raw)
  mutate?.(d)
  const p = join(dir, 'manifest.json')
  writeFileSync(p, JSON.stringify(d))
  return p
}

describe('§5-1 read-only であること', () => {
  const WRITE_APIS = [
    'writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'rmdirSync', 'unlinkSync',
    'copyFileSync', 'renameSync', 'createWriteStream', 'truncateSync', 'writeSync',
    'writeFile', 'appendFile', 'mkdtempSync', 'chmodSync', 'symlinkSync',
  ]

  it('**書き込み API を 1 つも使っていない**', () => {
    const hits = WRITE_APIS.filter((w) => new RegExp(`\\b${w}\\b`).test(SRC))
    expect({ script: SCRIPT, hits }).toEqual({ script: SCRIPT, hits: [] })
  })

  it('外部コマンドが読み取り専用のものだけ', () => {
    // execFileSync の第 1 引数と、続く配列の先頭（サブコマンド）を拾う
    const calls = [...SRC.matchAll(/execFileSync\(\s*'([^']+)'\s*,\s*\[\s*'([^']+)'/g)]
      .map((m) => `${m[1]} ${m[2]}`)
    mustBeNonEmpty(calls, '外部コマンド呼び出し')
    const ALLOWED = ['git archive', 'git rev-parse', 'gh api']
    for (const c of calls) expect(ALLOWED, `${c} は読み取り専用の一覧に無い`).toContain(c)
  })

  it('tar を展開せずメモリ上で読んでいる', () => {
    // 展開はファイル書き込みになる。外部の tar コマンドも使わない
    expect(SRC).not.toMatch(/execFileSync\(\s*'tar'/)
    expect(SRC).toMatch(/readTar/)
  })

  it('**実行しても作業ツリーが変わらない**', () => {
    const before = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
    run(['--manifest', tagManifest(), '--tag', 'v0.2.0'])
    const after = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
    expect(after).toBe(before)
  })
})

describe('§5-2 v0.2.0 tag の source と一致する', () => {
  const r = run(['--manifest', tagManifest(), '--tag', 'v0.2.0'])

  it('全件一致して終了コード 0', () => {
    expect({ status: r.json.status, code: r.code }).toEqual({ status: 'OK', code: 0 })
  })

  it('**28 件を実際に検算している**（0 件で OK ではない）', () => {
    const iv = r.json.independentVerification as Record<string, number>
    expect(iv.checked).toBe(28)
    expect(iv.matched).toBe(28)
    expect(iv.mismatched).toBe(0)
    expect(iv.missingInSource).toBe(0)
  })

  it('**自己申告と独立検証が別項目になっている**', () => {
    // 混ぜると「manifest がそう言っている」と「計算し直した」の区別が消える
    const self = r.json.selfReported as Record<string, number>
    const iv = r.json.independentVerification as Record<string, number>
    expect(self.inputFilesTotal).toBe(28)
    expect(iv.checked).toBe(self.inputFilesTotal)
    expect(r.json.selfReported).not.toBe(r.json.independentVerification)
  })

  it('**`checked` は自己申告の写しではなく、実際に数えた数である**', () => {
    // 正しい manifest では両者が一致してしまい、写しても気づけない。
    // **自己申告だけを嘘にして、独立検証がそれに引きずられないことを見る**
    // (2026-08-03 の変異試験で、写しに差し替えても素通りしたので足した)
    const p = tagManifest((d) => {
      ;(d as { inputFilesTotal: number }).inputFilesTotal = 999
    })
    const out = run(['--manifest', p, '--tag', 'v0.2.0'])
    const self = out.json.selfReported as Record<string, number>
    const iv = out.json.independentVerification as Record<string, number>
    expect(self.inputFilesTotal).toBe(999)
    expect(iv.checked).toBe(28)
  })

  it('network を使っていないことを出力に残している', () => {
    expect(r.json.networkUsed).toBe(false)
    expect(String(r.json.origin)).toMatch(/^git-archive:/)
  })

  it('記録漏れの入力候補が 0 件', () => {
    expect(r.json.unrecordedInputCandidates).toEqual([])
  })
})

describe('§5-3 取れなかったのと合わなかったのを混ぜない', () => {
  it('**source を取れない場合は SOURCE_UNAVAILABLE（exit 2）**', () => {
    const r = run(['--manifest', tagManifest(), '--tag', 'v9.9.9-does-not-exist'])
    expect({ status: r.json.status, code: r.code }).toEqual({ status: 'SOURCE_UNAVAILABLE', code: 2 })
    // **不一致と読ませない**
    expect(String(r.json.note)).toContain('不一致ではない')
    expect(r.json.mismatches).toBeUndefined()
  })

  it('manifest が読めない場合は MANIFEST_UNAVAILABLE（exit 2）', () => {
    const r = run(['--manifest', 'artifacts/does-not-exist.json', '--tag', 'v0.2.0'])
    expect({ status: r.json.status, code: r.code }).toEqual({ status: 'MANIFEST_UNAVAILABLE', code: 2 })
  })

  it('**sha256 が合わない場合は MISMATCH（exit 1）**', () => {
    const p = tagManifest((d) => {
      const files = (d as { inputFiles: { recordedSha256: string }[] }).inputFiles
      files[0].recordedSha256 = 'a'.repeat(64)
    })
    const r = run(['--manifest', p, '--tag', 'v0.2.0'])
    expect({ status: r.json.status, code: r.code }).toEqual({ status: 'MISMATCH', code: 1 })
    const bad = mustBeNonEmpty(r.json.mismatches as { outcome: string }[], '不一致の明細')
    expect(bad[0].outcome).toBe('MISMATCH')
    // 取得失敗と終了コードが違うこと（**混ぜていない証拠**）
    expect(r.code).not.toBe(2)
  })

  it('source に無い入力は MISSING_IN_SOURCE として出る', () => {
    const p = tagManifest((d) => {
      const files = (d as { inputFiles: { path: string }[] }).inputFiles
      files[0].path = 'src/model/this-file-does-not-exist.ts'
    })
    const r = run(['--manifest', p, '--tag', 'v0.2.0'])
    expect(r.json.status).toBe('MISMATCH')
    const bad = r.json.mismatches as { outcome: string }[]
    expect(bad.some((b) => b.outcome === 'MISSING_IN_SOURCE')).toBe(true)
  })

  it('**記録漏れの入力を見つける**（digest が覆っていない入力）', () => {
    const p = tagManifest((d) => {
      const o = d as { inputFiles: { path: string }[]; inputFilesTotal: number }
      o.inputFiles = o.inputFiles.filter((f) => !f.path.startsWith('src/model/'))
      o.inputFilesTotal = o.inputFiles.length
    })
    const r = run(['--manifest', p, '--tag', 'v0.2.0'])
    expect(r.json.status).toBe('MISMATCH')
    const extra = mustBeNonEmpty(r.json.unrecordedInputCandidates as string[], '記録漏れの入力候補')
    expect(extra.every((x) => x.startsWith('src/model/'))).toBe(true)
  })
})

describe('§5-4 空振りを合格にしない', () => {
  it('**入力 0 件は NOTHING_TO_VERIFY（exit 2）**', () => {
    // 0 件でも「全件一致」は真になってしまう。それを通すほうが危ない
    const p = tagManifest((d) => {
      const o = d as { inputFiles: unknown[]; inputFilesTotal: number }
      o.inputFiles = []
      o.inputFilesTotal = 0
    })
    const r = run(['--manifest', p, '--tag', 'v0.2.0'])
    expect({ status: r.json.status, code: r.code }).toEqual({ status: 'NOTHING_TO_VERIFY', code: 2 })
    expect(String(r.json.reason)).toContain('何も検証していない')
  })

  it('引数が足りなければ止まる（既定で何かを検証したつもりにならない）', () => {
    const r = run(['--manifest', tagManifest()])
    expect(r.code).toBe(2)
    expect(r.json.status).toBe('SOURCE_UNAVAILABLE')
  })
})
