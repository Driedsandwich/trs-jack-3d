/**
 * **検算ツールが「起動されたのに何もしない」状態にならないこと（v0.6.13）。**
 *
 * ## なぜ要るか
 *
 * v0.6.12 まで、入口の判定は `/verifyReleaseSourceInputs\.mjs$/` という
 * **ファイル名の正規表現**だった。受け手がコピーの名前を変えたり symlink を張ったりすると、
 * **何も出さずに `exit 0`** で終わる。
 *
 * ```
 * 実測（2026-08-12・修正前）
 *   verifyReleaseSourceInputs.mjs   exit 0 / 出力 4318 B
 *   renamed.mjs                     exit 0 / 出力    0 B   ← 無言
 *   link.mjs（symlink）             exit 0 / 出力    0 B   ← 無言
 * ```
 *
 * **終了コードだけを見る受け手には、合格と区別が付かない。**
 * これは「道具が落ちているときと、成功したときで出力が同じ」形そのものである。
 *
 * ## この試験の考え方
 *
 * **実際に別名でコピーし、symlink を張って走らせる。**
 * ソースを読んで `realpathSync` という語が在ることを確かめても、
 * **走らせなければ「走る」ことは分からない。**
 * 逆に「import では走らない」ことも実際に import して確かめる——
 * ここが壊れると、parser を直接呼ぶ他の試験がまとめて落ちる。
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CLI_RESULT_SCHEMA_ID } from '../scripts/verifyReleaseSourceInputs.mjs'

const ROOT = resolve(__dirname, '..')
const VERIFIER = resolve(ROOT, 'scripts/verifyReleaseSourceInputs.mjs')
const MANIFEST = 'artifacts/source-input-manifest.json'

const tmps: string[] = []
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })))

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'verifier-entry-'))
  tmps.push(d)
  return d
}

/** 実際に走らせて、終了コードと標準出力の両方を返す */
function run(script: string, args: string[] = ['--manifest', MANIFEST, '--source', '.']): { code: number, out: string } {
  try {
    return { code: 0, out: execFileSync('node', [script, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }) }
  } catch (e) {
    const err = e as { status?: number, stdout?: string }
    return { code: err.status ?? -1, out: String(err.stdout ?? '') }
  }
}

describe('検算ツールの入口 — 名前を変えても黙らない', () => {
  /**
   * **(1) 別名でも symlink でも走る。**
   * どちらも v0.6.12 では出力 0 バイトだった。
   */
  it.each([
    ['同じ名前でコピー', 'verifyReleaseSourceInputs.mjs', 'copy'],
    ['**別名でコピー**', 'renamed.mjs', 'copy'],
    ['**symlink で別名**', 'link.mjs', 'symlink'],
  ])('%s（%s）でも JSON を出す', (_label, name, how) => {
    const d = tmpDir()
    const canonical = join(d, 'verifyReleaseSourceInputs.mjs')
    copyFileSync(VERIFIER, canonical)
    const target = join(d, name)
    if (target !== canonical) {
      if (how === 'symlink') symlinkSync(canonical, target)
      else copyFileSync(VERIFIER, target)
    }

    const r = run(target)
    expect(r.out.length, `${name}: **無言で終わった**（終了コードだけ見る受け手には合格に見える）`)
      .toBeGreaterThan(0)
    const j = JSON.parse(r.out)
    expect(j.schemaId).toBe(CLI_RESULT_SCHEMA_ID)
    expect(j.status, `${name}: status が出ていない`).toBeTypeOf('string')
  })

  /**
   * **この試験が空振りしていない。**
   *
   * 入口を名前で判定する版（v0.6.12 の書き方）を作って走らせ、**そちらでは無言になる**
   * ことを見る。これが落ちるなら、上の 3 件は「何をしても通る」検査でしかない。
   */
  it('**空振りしていない**（名前で判定する版に戻すと、別名で無言になる）', () => {
    const d = tmpDir()
    const src = execFileSync('cat', [VERIFIER], { encoding: 'utf8' })
    const OLD_GUARD = "const RUN_AS_CLI = typeof process.argv[1] === 'string' "
      + "&& /verifyReleaseSourceInputs\\.mjs$/.test(process.argv[1])"
    // 入口だけを v0.6.12 の書き方へ差し戻す
    const reverted = src.replace(/const RUN_AS_CLI = \(\(\) => \{[\s\S]*?\}\)\(\)/, OLD_GUARD)
    expect(reverted, '**差し戻しが入っていない**（この対照は何も言っていない）').not.toBe(src)
    expect(reverted).toContain('/verifyReleaseSourceInputs\\.mjs$/')

    const renamed = join(d, 'renamed.mjs')
    writeFileSync(renamed, reverted)
    const r = run(renamed)
    expect(r.out.length, '名前で判定する版なのに出力が出た（対照が成立していない）').toBe(0)
    expect(r.code, '無言なのに終了コードが 0 でない').toBe(0)

    // 対照の対照: 同じ差し戻し版でも、正規の名前なら走る
    const canonical = join(d, 'verifyReleaseSourceInputs.mjs')
    writeFileSync(canonical, reverted)
    expect(run(canonical).out.length, '差し戻し版が正規名でも走らない（壊れている）').toBeGreaterThan(0)
  })

  /**
   * **(2) 正規の名前での出力は変わっていない。**
   * 入口を直しただけなので、**判定は 1 バイトも動かない**（`toolVersion` を上げない根拠）。
   */
  it('**正規の名前での出力は、別名で走らせた出力と同じ**', () => {
    const d = tmpDir()
    const canonical = join(d, 'verifyReleaseSourceInputs.mjs')
    const renamed = join(d, 'renamed.mjs')
    copyFileSync(VERIFIER, canonical)
    copyFileSync(VERIFIER, renamed)
    const a = run(canonical), b = run(renamed)
    expect(b.out, '別名での出力が正規名と違う').toBe(a.out)
    expect(b.code).toBe(a.code)
    // 空振り防止: 引数を変えれば出力は変わる
    const other = run(canonical, ['--manifest', MANIFEST, '--source', '/nonexistent'])
    expect(other.out, '引数を変えても同じ出力（比較が効いていない）').not.toBe(a.out)
  })

  /**
   * **(3) module として import しても CLI は走らない。**
   * ここが壊れると、parser を直接呼ぶ試験が `process.exit` でまとめて落ちる。
   */
  it('**import しても CLI は走らない**（走ると他の試験がまとめて落ちる）', async () => {
    const m = await import('../scripts/verifyReleaseSourceInputs.mjs')
    expect(m.TOOL_VERSION).toBeGreaterThanOrEqual(16)
    expect(m.CLI_STATUSES.length).toBe(8)
    // **この試験ファイル自身が import した時点で走っていたら、ここへ到達していない**
    expect(typeof m.readArchiveBuffer).toBe('function')
  })
})
