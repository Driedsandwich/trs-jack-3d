/**
 * **2 つの証拠を結び直す関門の検査（v0.6.17・外部監査 P1-B / P1-D）。**
 *
 * ## なぜ要るか
 *
 * v0.6.16 は、`validation-results.testEvidence` に
 * 「どの `test_counts.json` を根拠にしたか」を sha256・commit・日付で**書いてはいた。**
 * だが、**名乗った先の実物と突き合わせる工程がどこにも無かった。**
 *
 * ```
 * release:stage の鮮度検査   test_counts.json しか見ない
 * READY の検査               validation-results.json の文字列しか見ない
 * ```
 *
 * **片方だけ作り直した状態は、どちらの検査も単体では通る。**
 *
 * ## 変異を関門へ直接当てる理由
 *
 * `npm run release:stage` を丸ごと回して確かめようとすると、
 * **手前の鮮度検査が先に落ちて全件が同じ exit 1 になる**（2026-08-15 に実測）。
 * それは「この関門が効いた」の証拠にならない——落ちた理由が別だからである。
 * だから関門を関数に切り出し、ここでは**その関数へ直接**当てる。
 * 関門が stage から呼ばれていること自体は、下の別の it が見る。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EVIDENCE_FIELDS, crossBindTestEvidence, summarizeVitestReport, testInputPaths,
} from '../scripts/measureTests.mjs'
import { mustBeNonEmpty } from './_must'

const ROOT = resolve(__dirname, '..')
const TC = 'artifacts/test_counts.json'
const VR = 'artifacts/validation-results.json'

const read = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o))
const shaOf = (o: unknown) => createHash('sha256').update(Buffer.from(`${JSON.stringify(o, null, 1)}\n`)).digest('hex')
const shaFile = (p: string) => createHash('sha256').update(readFileSync(resolve(ROOT, p))).digest('hex')

describe('testEvidence の cross-binding', () => {
  const tc0 = read(TC)
  const vr0 = read(VR)
  const sha0 = shaFile(TC)

  it('**対照: いまの 2 つは結び付いている**（何にでも鳴る検査ではない）', () => {
    expect(crossBindTestEvidence(tc0, vr0, sha0), '現行の artifact が食い違っている').toEqual([])
  })

  /**
   * 監査（外部・2026-08-15）が挙げた 5 種類に、`testEvidence` ごと消す形を足した 6 種類。
   * **どれも「片方だけ動かす」形である。**
   */
  const MUTANTS: readonly (readonly [string, () => [any, any, string], string])[] = [
    ['test_counts だけ更新', () => {
      const tc = clone(tc0); tc.total += 1
      return [tc, vr0, shaOf(tc)]
    }, 'testCountsSha256'],
    ['validation だけ更新', () => {
      const vr = clone(vr0); vr.testEvidence.total += 1
      return [tc0, vr, sha0]
    }, 'total'],
    ['SHA だけ偽装', () => {
      const vr = clone(vr0); vr.testEvidence.testCountsSha256 = '0'.repeat(64)
      return [tc0, vr, sha0]
    }, 'testCountsSha256'],
    ['commit だけ偽装', () => {
      const vr = clone(vr0); vr.testEvidence.testCountsGeneratedFromCommit = 'a'.repeat(40)
      return [tc0, vr, sha0]
    }, 'testCountsGeneratedFromCommit'],
    ['date だけ偽装', () => {
      const vr = clone(vr0); vr.testEvidence.testCountsGeneratedAt = '2020-01-01'
      return [tc0, vr, sha0]
    }, 'testCountsGeneratedAt'],
    ['testEvidence ごと消す', () => {
      const vr = clone(vr0); vr.testEvidence = null
      return [tc0, vr, sha0]
    }, 'testEvidence が無い'],
  ]

  it.each(MUTANTS.map((m) => [m[0], m] as const))(
    '**%s → 止まる**',
    (_n, [, mk, phrase]) => {
      const [tc, vr, sha] = mk()
      const problems = crossBindTestEvidence(tc, vr, sha)
      mustBeNonEmpty(problems, 'この変異で挙がった問題')
      /**
       * **「落ちた」ではなく「この理由で落ちた」まで見る。**
       * 別の欄がついでにずれて落ちているなら、その変異は当の検査を踏んでいない。
       */
      expect(problems.join('\n'), `別の理由で止まっている: ${problems.join(' / ')}`).toContain(phrase)
    },
  )

  it('**その関門が release:stage から呼ばれている**（書いただけになっていない）', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/stageRelease.mjs'), 'utf8')
    expect(src, 'stage が cross-binding を呼んでいない').toContain('crossBindTestEvidence(')
    expect(src, 'import されていない').toMatch(/import \{[^}]*crossBindTestEvidence[^}]*\} from '\.\/measureTests\.mjs'/)
  })
})

/**
 * **数え方は 1 か所しかない（v0.6.17・外部監査 P1-D）。**
 *
 * v0.6.16 まで、`testCount.mjs`（書く側）が `measureTests.mjs` と同じ集計を
 * **別に実装していた。**値がたまたま一致していたので、どの検査も鳴らない。
 */
describe('測定の一本化', () => {
  it('testCount.mjs が唯一の集計器を使っている', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/testCount.mjs'), 'utf8')
    expect(src, '集計器を import していない').toContain('summarizeVitestReport')
    /** **自前で数え直していないこと。**この 3 つは以前ここに直書きされていた */
    expect(src, 'byFile を自前で組み立て直している').not.toContain('f.assertionResults.length')
    expect(src, 'skip を自前で数え直している').not.toContain("a.status === 'skipped'")
    expect(src, 'allPassed を自前で決めている').not.toContain('r.numFailedTests === 0 && exitCode === 0')
  })

  it('集計器は純関数（同じ報告からは同じ値）', () => {
    const report = {
      testResults: [
        { name: '/x/a.test.ts', assertionResults: [{ status: 'passed' }, { status: 'skipped' }] },
        { name: '/x/b.test.ts', assertionResults: [{ status: 'passed' }] },
      ],
      numFailedTests: 0,
      numFailedTestSuites: 0,
    }
    const a = summarizeVitestReport(report, 0)
    const b = summarizeVitestReport(report, 0)
    expect(a).toEqual(b)
    expect(a.total, '合計').toBe(3)
    expect(a.skipped, 'skip').toBe(1)
    expect(a.allPassed, '成否').toBe(true)
    /** **終了コードが効いていること。**0 決め打ちなら落ちた run を「通った」と数える */
    expect(summarizeVitestReport(report, 1).allPassed, 'exitCode を見ていない').toBe(false)
  })

  it('比べる欄の一覧が空でない', () => {
    expect(mustBeNonEmpty([...EVIDENCE_FIELDS], '比べる欄').length).toBeGreaterThanOrEqual(6)
  })
})

/**
 * **由来の検査が見る範囲（v0.6.17・外部監査 P1-E）。**
 * 手で並べると増えたときに落とす——実際 `tsconfig.scripts.json` が抜けていた。
 */
describe('provenance の範囲', () => {
  it('tsconfig 系を実在から拾っている（手書きの一覧になっていない）', () => {
    const paths = testInputPaths(ROOT)
    const tracked = execFileSync('git', ['ls-files', '--', 'tsconfig*.json'], { cwd: ROOT, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean)
    mustBeNonEmpty(tracked, '追跡されている tsconfig')
    for (const t of tracked) expect(paths, `${t} が範囲に入っていない`).toContain(t)
  })

  it('artifact と文書を範囲に入れていない（循環するため）', () => {
    const paths = testInputPaths(ROOT)
    for (const p of ['artifacts/', 'docs/', 'README.md']) {
      expect(paths, `${p} を入れると証拠の生成が収束しない`).not.toContain(p)
    }
  })

  it('src / test / scripts / schemas を落としていない', () => {
    const paths = testInputPaths(ROOT)
    for (const p of ['src/', 'test/', 'scripts/', 'schemas/', 'package-lock.json']) {
      expect(paths, `${p} が範囲から落ちている`).toContain(p)
    }
  })
})
