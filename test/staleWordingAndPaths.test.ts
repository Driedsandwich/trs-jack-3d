/**
 * **言い切った文言と、指したパスが、いまも本当か（v0.6.15・外部監査 2026-08-12 P1-D）。**
 *
 * ## なぜ要るか
 *
 * v0.6.11 から v0.6.14 まで、**同じ形の欠陥を 4 版連続で出した。**
 * 境界や一覧を 2 か所に持ち、片方だけ直す。直さなかった側は誰も検査していないので、
 * **ずれても何も落ちない。**外部監査が毎回それを拾って返してきた。
 *
 * v0.6.14 でも 3 つ残していた。実測（2026-08-14）:
 *
 * ```
 * scripts/verifyReleaseSourceInputs.mjs  CLI_STATUS_META の 12 行上に 8 status の手書き一覧
 *                                        （「同じ境界は 1 か所で持つ」と書いた同じコメント塊の中）
 * scripts/verifyReleaseSourceInputs.mjs  受け手向けのエラー文が scripts/reasonCodes.mjs を指す
 *                                        （そのファイルは v0.6.14 で消した。**実在しない**）
 * SECURITY.md                            「v0.3.0 より前の tag」（正しくは v0.4.0 より前）
 * ```
 *
 * **変異対照（2026-08-14）**: SECURITY.md の版数を `v0.9.9 より前` に書き換えて全試験を回すと
 * **1236 件すべて緑**だった。文言は 1 か所も検査されていなかった。
 *
 * ## この試験の考え方
 *
 * 直す場所を列挙するのをやめ、**主張のほうを列挙して全面へ当てる。**
 * 除外は語句で推測せず、**パスを名指しで宣言する**——そして
 * **宣言した除外が本当にまだその語句を含むかも確かめる。**
 * 含まなくなった除外を残すと、次に同じ語句が live 側へ戻ってきたとき静かに見逃す。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mustBeNonEmpty } from './_must'

const ROOT = resolve(__dirname, '..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')

/**
 * **いま有効だと主張しているファイル。**
 * ここに無いものは検査しない——なので「足し忘れ」は下の非空振り検査で見る。
 */
const LIVE_FILES = [
  'scripts/verifyReleaseSourceInputs.mjs',
  'scripts/buildReleaseEvidence.mjs',
  'scripts/checkDocNumbers.mjs',
  'scripts/selfReportStatus.mjs',
  'SECURITY.md',
  'README.md',
  'CONTRIBUTING.md',
  'docs/TEST_RESULTS.md',
  'docs/VERIFICATION_PLAN.md',
  'schemas/source-verifier-cli-result.v1.schema.json',
] as const

/**
 * **もう直せない記録。**公開済み release 本文と正誤表は、当時の誤りごと残すのが仕様である
 * （`docs/ERRATA.md` の運用節）。**書き換えたら「いつ何が直ったか」が消える。**
 */
const FROZEN_RECORDS = [
  'docs/ERRATA.md',
  'docs/release/v0.6.11-notes.md',
  'docs/release/v0.6.12-notes.md',
  'docs/release/v0.6.14-notes.md',
  'docs/release/verify-tool-v16-notes.md',
  'docs/release/v0.6.11-chatgpt-prompt.md',
  'docs/release/v0.6.13-chatgpt-prompt.md',
  'docs/release/v0.6.14-chatgpt-prompt.md',
  'test/sourceVerifierCliResult.test.ts',
  'test/staleWordingAndPaths.test.ts',
] as const

/** live 側に在ってはいけない言い方と、なぜ誤りか */
const FORBIDDEN_PHRASES = [
  {
    phrase: 'v0.3.0 より前',
    why: '範囲定義（inputScope）が入ったのは v0.4.0。v0.3.0 自身も「範囲が無い側」に含まれる',
  },
] as const

describe('言い切った文言が、いまも本当か', () => {
  it.each(FORBIDDEN_PHRASES)('live なファイルに「$phrase」が無い（$why）', ({ phrase }) => {
    const hits = LIVE_FILES.filter((f) => read(f).includes(phrase))
    expect(hits, `**古い言い方が残っている**: ${hits.join(', ')}`).toEqual([])
  })

  /**
   * **除外のほうが陳腐化していないか。**
   * 語句を含まなくなった記録を除外に残すと、**その語句が live へ戻っても静かに通る。**
   */
  it.each(FORBIDDEN_PHRASES)('「$phrase」を免除した記録が、いまもその語句を含む', ({ phrase }) => {
    const stillQuoting = FROZEN_RECORDS.filter((f) => existsSync(resolve(ROOT, f)) && read(f).includes(phrase))
    expect(
      mustBeNonEmpty(stillQuoting, `「${phrase}」を引用している記録`).length,
      '**免除する記録が 1 つも語句を含まない＝免除が不要になっている**',
    ).toBeGreaterThan(0)
  })

  /** **非空振り**: 検査が本当に本文を読んでいる */
  it('**この検査が空振りしていない**（存在する語句なら見つかる）', () => {
    const canary = LIVE_FILES.filter((f) => read(f).includes('v0.4.0 より前'))
    expect(canary.length, '訂正後の言い方すら見つからない＝本文を読めていない').toBeGreaterThan(0)
    expect(LIVE_FILES.filter((f) => read(f).includes('絶対に出てこない語句ZZZ'))).toEqual([])
  })
})

/**
 * **指したパスが実在するか。**
 * v0.6.14 は、受け手が読むエラー文で `scripts/reasonCodes.mjs` を指していた。
 * **そのファイルは同じ版で消してある。**「登録しろ」と言われた受け手は、無い場所を開くことになる。
 */
describe('文中で指したリポジトリ内のパスが実在するか', () => {
  const PATH_TOKEN = /(?:scripts|test|schemas|artifacts)\/[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:mjs|ts|json|txt)/g

  it.each(LIVE_FILES)('%s が指すパスがすべて実在する', (file) => {
    const tokens = [...new Set(read(file).match(PATH_TOKEN) ?? [])]
    const missing = tokens.filter((t) => !existsSync(resolve(ROOT, t)))
    expect(missing, `**実在しないパスを指している**: ${missing.join(', ')}`).toEqual([])
  })

  it('**この検査が空振りしていない**（実在するパスを実際に拾えている）', () => {
    const all = LIVE_FILES.flatMap((f) => read(f).match(PATH_TOKEN) ?? [])
    expect(mustBeNonEmpty([...new Set(all)], 'live なファイルが指すパス').length)
      .toBeGreaterThanOrEqual(20)
    // 実在しない名前を混ぜたら落ちること（検出器そのものの対照）
    const fake = 'scripts/thisFileDoesNotExist.mjs'
    expect(fake.match(PATH_TOKEN), '検出器がこの形を拾えない').toEqual([fake])
    expect(existsSync(resolve(ROOT, fake))).toBe(false)
  })
})
