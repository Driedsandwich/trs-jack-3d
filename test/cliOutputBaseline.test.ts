/**
 * **CLI の出力が、core / CLI 分離の前から 1 バイトも動いていないこと（v0.6.18）。**
 *
 * ## なぜ基準を repo へ入れたか
 *
 * 分離は「**何も変えない**」変更である。だが「変えていない」はそれ自体では確かめられない
 * ——**分離する前に基準を取っておかないと、あとで何と比べればよいか分からない。**
 * 作業領域に置くと、報告した証拠を誰も再現できないので、基準そのものを配布 source へ入れる。
 *
 * ## byte で比べる（JSON として比べない）
 *
 * `JSON.parse` して深く比べると**キーの順序が変わっても通る。**
 * 受け手は文字列として受け取り、`diff` を取り、digest を計算するので、こちらも byte で比べる。
 *
 * ## この試験は重い（9 経路ぶん node を起動する）
 *
 * それでも入れるのは、**分離のあとで誰かが「ついでに」出力へ手を入れたときに
 * 気づける場所が他に無い**ため。CI も `npm run check:cli-output` で同じものを回す。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BASELINE_PATH, allBaselineRoutes, diffBaseline, measureAll } from '../scripts/cliOutputBaseline.mjs'
import { mustBeNonEmpty } from './_must'

const ROOT = resolve(__dirname, '..')
const recorded = JSON.parse(readFileSync(resolve(ROOT, BASELINE_PATH), 'utf8'))

describe('CLI 出力の基準', () => {
  it('**全 9 経路が、分離前の基準と byte 一致する**', () => {
    const live = measureAll(ROOT)
    const problems = diffBaseline(live, recorded)
    expect(problems, problems.join('\n')).toEqual([])
  }, 180_000)

  it('基準が空振りしていない（経路が実在し、注入も混ざっている）', () => {
    mustBeNonEmpty(recorded.routes, '基準の経路')
    expect(recorded.routes.length, '経路が痩せている').toBeGreaterThanOrEqual(9)
    /** 注入なしの普通の経路と、注入した経路の**両方**が入っていること */
    const injected = recorded.routes.filter((r: { injected: string | null }) => r.injected !== null)
    const plain = recorded.routes.filter((r: { injected: string | null }) => r.injected === null)
    expect(injected.length, '注入した経路が 1 件も無い').toBeGreaterThanOrEqual(5)
    expect(plain.length, '注入なしの経路が 1 件も無い').toBeGreaterThanOrEqual(3)
    /** **`OK` の経路が入っていること。**異常系だけ固定しても、普通の出力の変化に気づけない */
    expect(recorded.routes.some((r: { exitCode: number }) => r.exitCode === 0), 'OK の経路が無い').toBe(true)
  })

  /**
   * **比べ方に判別力があること。**
   * `diffBaseline` が常に空を返す実装でも、上の試験は通ってしまう。
   */
  it('対照: 基準を 1 か所変えると、そこを名指しで検出する', () => {
    /** **道具は動かさない。**ここで確かめたいのは比べ方の判別力だけなので、基準を実測の側に置く */
    const live = recorded.routes
    const broken = structuredClone(recorded)
    const before = broken.routes[0].stdoutSha256
    broken.routes[0].stdoutSha256 = (before[0] === 'f' ? 'a' : 'f') + before.slice(1)
    expect(broken.routes[0].stdoutSha256, '変異が当たっていない').not.toBe(before)

    const problems = diffBaseline(live as never, broken)
    expect(problems.length, '変異を検出していない').toBeGreaterThan(0)
    expect(problems.join('\n'), 'どの経路のどの欄かを言っていない').toContain('stdoutSha256')
    expect(problems.join('\n')).toContain(recorded.routes[0].label)
  })

  it('対照: 経路が消えたら検出する', () => {
    const fewer = recorded.routes.slice(1)
    const problems = diffBaseline(fewer as never, recorded)
    expect(problems.join('\n'), '経路が消えたのに黙っている').toContain('実測に無い')
  })

  /**
   * **基準がいつ・どの版から取られたか。**
   * 分離のあとで取り直すと「変えていない」の証明にならないので、
   * **取り直したら気づける**ように、取得元の commit と道具の digest を持たせてある。
   */
  it('基準は、取得元の commit と道具の digest を持っている', () => {
    expect(recorded.takenFromCommit, '取得元の commit が無い').toMatch(/^[0-9a-f]{40}$/)
    expect(recorded.toolSha256, '取得時の道具の digest が無い').toMatch(/^[0-9a-f]{64}$/)
    expect(recorded.takenAt, '取得日が無い').toMatch(/^\d{4}-\d{2}-\d{2}$/)
    /** その commit が履歴に実在すること（作り話でないこと） */
    expect(() => execFileSync('git', ['cat-file', '-e', `${recorded.takenFromCommit}^{commit}`],
      { cwd: ROOT, stdio: 'ignore' })).not.toThrow()
  })

  /**
   * **分離で digest が変わるのは道具のほうだけ。**
   * 基準の `toolSha256` は**分離前**の値なので、いまの道具とは違って当然である。
   * ここが一致してしまったら、それは分離が入っていないということ。
   */
  it('道具は分離で変わっている（基準は分離前のものである）', () => {
    const now = createHash('sha256')
      .update(readFileSync(resolve(ROOT, 'scripts/verifyReleaseSourceInputs.mjs'))).digest('hex')
    expect(now, '道具が分離前と同じ（分離が入っていない）').not.toBe(recorded.toolSha256)
  })

  it('経路の表は 1 か所から来ている（2 つ目の一覧を作っていない）', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/cliOutputBaseline.mjs'), 'utf8')
    expect(src, '注入経路を自前で持っている').toContain("from '../test/_cliRoutes.mjs'")
    const keep: string[] = []
    try {
      const labels = allBaselineRoutes(keep).map((r: { label: string }) => r.label)
      expect(new Set(labels).size, 'label が重複している').toBe(labels.length)
    } finally {
      for (const d of keep) rmSync(d, { recursive: true, force: true })
    }
  })
})
