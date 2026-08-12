/**
 * 検証を回した記録と、受け手が自分で回せる状態（v0.3.0 フォローアップ P1-3）。
 *
 * ## 何を守るか
 *
 * v0.3.0 では「入力 28 件を自分で検算せよ」と作業指示に書いておきながら、
 * **その script も tag source も bundle に入っていなかった。**
 * 受け手は当然 `SOURCE_UNAVAILABLE` を返してきた——欠陥はこちらの指示にあった。
 *
 * だからここで見るのは 2 つ。
 *
 *   1. **配ったものだけで受け手が検算に着手できるか**（道具・範囲定義・手順が揃っているか）
 *   2. **記録が自己申告だと自分で名乗っているか**（独立検証の代わりに読ませない）
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Ajv from 'ajv'
import { afterAll, describe, expect, it } from 'vitest'
import { RELEASE_ASSETS } from '../scripts/releaseAssets.mjs'
import { CLI_STATUSES, CLI_STATUS_EXIT } from '../scripts/verifyReleaseSourceInputs.mjs'
import { assertExpressibleInSelfReport } from '../scripts/selfReportStatus.mjs'
import { mustBeNonEmpty, mustFind } from './_must'

const ROOT = resolve(__dirname, '..')
const R = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))
const ARTIFACT = 'artifacts/source-verification-result.json'
const VERIFIER = 'scripts/verifyReleaseSourceInputs.mjs'
const result = R(ARTIFACT)

const tmps: string[] = []
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('P1-3-1 記録そのもの', () => {
  it('schema に適合する', () => {
    const ajv = new Ajv({ allErrors: true, strict: false })
    const ok = ajv.compile(R('schemas/source-verification-result.v1.schema.json'))(result)
    expect({ ok, errors: ajv.errors }).toEqual({ ok: true, errors: null })
  })

  it('**自己申告だと自分で名乗っている**（独立検証の代わりに読ませない）', () => {
    expect(result.isSelfReport).toBe(true)
    expect(result.replacesRecipientVerification).toBe(false)
    expect(String(result.note)).toContain('自己申告')
    expect(String(result.note)).toContain('置き換えない')
  })

  it('**突き合わせ先が tag ではないことを書いてある**（作業ツリーである）', () => {
    expect(String(result.sourceOrigin)).toMatch(/^directory:/)
    expect(String(result.note)).toContain('tag の source ではない')
    // tag はこの時点で存在しないので null が正しい（索引の releaseCommit と同じ理由）
    expect(result.releaseCommit).toBeNull()
  })

  it('**0 件を検証して OK と言っていない**', () => {
    expect(result.status).toBe('OK')
    expect(result.counts.checked).toBeGreaterThan(0)
    expect(result.counts.checked).toBe(result.counts.matched)
    expect(result.exitCode).toBe(0)
  })

  it('**記録漏れの探索を実行したと書いてある**（していないなら候補 0 件に意味が無い）', () => {
    expect(result.unrecordedInputDetection.performed).toBe(true)
    expect(String(result.unrecordedInputDetection.scopeSource)).toContain('source-input-scope.v1.json')
    expect(result.counts.unrecordedInputCandidates).toBe(0)
    expect(result.counts.selfReferencingInputs).toBe(0)
  })

  it('件数が入力一覧と一致する（別々の数を持たない）', () => {
    expect(result.counts.checked).toBe(R('artifacts/source-input-manifest.json').inputFilesTotal)
  })

  it('**記録した道具が実物と同じ**（違えば、これは今の道具の出力ではない）', () => {
    expect(result.tool.script).toBe(VERIFIER)
    const actual = execFileSync('shasum', ['-a', '256', VERIFIER], { cwd: ROOT, encoding: 'utf8' }).split(' ')[0]
    expect(result.tool.sha256).toBe(actual)
    expect(result.tool.toolVersion).toBeGreaterThanOrEqual(2)
  })

  it('**受け手が自分で回す手順が入っている**（無いとただの自慢になる）', () => {
    const how = mustBeNonEmpty(result.howToVerifyYourself as string[], '受け手向けの手順')
    const joined = how.join('\n')
    expect(joined).toContain('verifyReleaseSourceInputs.mjs')
    expect(joined).toContain('--scope')
    expect(joined).toMatch(/潰さない/)
  })

  /**
   * **手順書の status 一覧が、道具の一覧と過不足なく一致する（v0.6.12）。**
   *
   * v0.6.11 まで、ここは `toContain('SOURCE_UNAVAILABLE')` という**1 語のべた書き**だった。
   * だから**その 1 語さえ残っていれば、一覧が古くても偽の値が混じっていても緑**だった。
   * 実際に出荷された v0.6.11 の手順書は 5 種類しか書いておらず、
   * **`VERIFICATION_INCOMPLETE`（その版の目玉）を受け手に伝えていなかった。**
   *
   * 検査は「含む」ではなく**集合の一致**で書く。含む検査は、足りない側を捕まえられない。
   */
  it('**status の一覧が道具の一覧と過不足なく一致する**（配布物に古い列挙を載せない）', () => {
    const line = mustBeNonEmpty(
      (result.howToVerifyYourself as string[]).filter((l) => l.includes('status は')),
      '手順書の status 行',
    )
    expect(line.length, 'status を説明する行が 2 本以上ある（どちらを読むか決まらない）').toBe(1)
    const named = [...line[0].matchAll(/([A-Z][A-Z_]+)\((\d)\)/g)].map((m) => [m[1], Number(m[2])] as const)
    expect(named.map(([s]) => s).sort(), '手順書の status が道具の一覧と違う')
      .toEqual([...CLI_STATUSES].sort())
    // 終了コードまで一致していること（名前だけ合っていても、受け手は数で分岐する）
    expect(Object.fromEntries(named), '手順書の終了コードが道具と違う').toEqual(CLI_STATUS_EXIT)
  })
})

describe('P1-3-2 受け手が配布物だけで検算に着手できる', () => {
  const paths = RELEASE_ASSETS.map((a) => a.path)

  it('**検証ツールが bundle に入っている**（v0.3.0 では入っていなかった）', () => {
    expect(paths).toContain(VERIFIER)
  })

  it('検算に要る 3 点がそろっている（道具・入力一覧・範囲定義）', () => {
    for (const p of [VERIFIER, 'artifacts/source-input-manifest.json', 'source-input-scope.v1.json'])
      expect(paths, `${p} が配布一覧に無い`).toContain(p)
  })

  it('記録と、それを検証する schema も入っている', () => {
    expect(paths).toContain(ARTIFACT)
    expect(paths).toContain('schemas/source-verification-result.v1.schema.json')
  })

  it('**検証ツールが単体で動く**（リポジトリ内の他ファイルを import していない）', () => {
    const src = readFileSync(resolve(ROOT, VERIFIER), 'utf8')
    const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
    mustBeNonEmpty(imports, 'import 文')
    for (const i of imports) expect(i.startsWith('node:'), `${i} は node 標準ではない`).toBe(true)
  })

  /**
   * **GitHub は release ページへ "Source code (tar.gz)" を自動で付ける。**
   * 展開すると `<repo>-<sha>/` が 1 枚かぶる。受け手がそれを剥がし忘れると
   * **29 件すべてが MISSING_IN_SOURCE になり「壊れている」と読めてしまう。**
   */
  it('**展開した tarball をそのまま --source に渡せる**（先頭の 1 階層を剥がす）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'srcdir-'))
    tmps.push(dir)
    // tag の source を、tarball と同じ「1 階層かぶった」形で展開する
    const inner = join(dir, 'Driedsandwich-trs-jack-3d-abc1234')
    execFileSync('sh', ['-c', `mkdir -p '${inner}' && git archive --format=tar HEAD | tar -x -C '${inner}'`], { cwd: ROOT })

    const run = (d: string) => {
      try {
        return { code: 0, json: JSON.parse(execFileSync('node', [VERIFIER, '--manifest', 'artifacts/source-input-manifest.json', '--source', d, '--scope', 'source-input-scope.v1.json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })) }
      } catch (e) {
        const err = e as { status?: number; stdout?: string }
        return { code: err.status ?? -1, json: JSON.parse(String(err.stdout ?? '{}')) }
      }
    }
    const outer = run(dir) // 展開したまま渡す（1 階層かぶっている）
    const innerOut = run(inner) // 受け手が自分で剥がして渡した場合

    // **同じ結果になること。**これが剥がせている証拠であり、
    // 作業ツリーがコミット済みかどうかに左右されない
    expect(outer.json.independentVerification).toEqual(innerOut.json.independentVerification)
    expect(String(outer.json.origin)).toContain('剥がした')
    expect(String(innerOut.json.origin)).not.toContain('剥がした')

    // **全件 MISSING という壊れ方をしていないこと**（剥がし忘れるとこうなる）
    const iv = outer.json.independentVerification as { checked: number; missingInSource: number }
    expect(iv.checked).toBeGreaterThan(0)
    expect(iv.missingInSource, '剥がせていないと全件 missing になる').toBeLessThan(iv.checked)
  }, 60_000)

  it('リポジトリの root を渡したときは何も剥がさない（親が複数あるので）', () => {
    const out = execFileSync('node', [VERIFIER, '--manifest', 'artifacts/source-input-manifest.json', '--source', '.', '--scope', 'source-input-scope.v1.json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
    const j = JSON.parse(out)
    expect(String(j.origin)).not.toContain('剥がした')
    expect(j.status).toBe('OK')
  }, 60_000)
})

describe('P1-3-3 配布一覧の整合', () => {
  it('**配布物に重複した配布名が無い**（basename で並べるので上書きされる）', () => {
    const names = RELEASE_ASSETS.map((a) => a.path.split('/').pop())
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([])
  })

  it('索引が新しい asset を載せている', () => {
    const idx = R('artifacts/trs-jack-3d-release-index.v1.json')
    const filenames = (idx.assets as { filename: string }[]).map((a) => a.filename)
    for (const p of [ARTIFACT, VERIFIER, 'source-input-scope.v1.json'])
      expect(filenames, `${p} が索引に無い`).toContain(p.split('/').pop())
    // 索引自身は含まない（自己参照）
    expect(filenames).not.toContain('trs-jack-3d-release-index.v1.json')
  })

  it('道具の role が evidence でも schema でもなく tool になっている', () => {
    expect(mustFind(RELEASE_ASSETS, (a) => a.path === VERIFIER, '検証ツールの配布定義').role).toBe('tool')
  })
})

/**
 * **道具が出す status と、配布 schema が受ける status のずれ（外部監査 2026-08-06 P0-D）。**
 *
 * `verifyReleaseSourceInputs.mjs` は v5 から `ARCHIVE_INVALID` を出すが、
 * 同梱の `source-verification-result.v1.schema.json` の enum には入っていない。
 * **入れると受理する文書が増えて言語が広がるので v2 になり、下流の lock が止まる**
 * （`scripts/schemaLanguageDiff.mjs` で実測: enum 追加 = BUMP / description のみ = HOLD）。
 *
 * v0.6.1 で閉じたのは次の 3 つ。**版は上げていない。**
 *
 *   1. ずれの中身を schema 自身が書いている（受け手が読める）
 *   2. 生成器が、表現できない status を**近い値へ丸めずに止まる**
 *   3. ずれが `ARCHIVE_INVALID` 1 個だけであることを、ここで機械的に固定する
 */
describe('P1-3-4 status の契約 — 道具と schema のずれを隠さない', () => {
  const SCHEMA = 'schemas/source-verification-result.v1.schema.json'
  const enumOf = () => R(SCHEMA).properties.status.enum as string[]
  /**
   * 道具が出しうる status。**道具が名乗る一覧を読む（v0.6.11）。**
   *
   * v0.6.10 まではソースを正規表現で拾っていた。`status` の書き方を
   * 三項演算子へ変えただけで拾えなくなり、**「増えたら気づく」検査が空振りした。**
   * 一覧を道具側の定数にして、ここはそれを読むだけにする。
   */
  const emittedByTool = () => new Set<string>(CLI_STATUSES)

  it('**一覧が実際に出る status を覆っている**（飾りの定数になっていない）', () => {
    // 実際に走らせて出た status が、名乗っている一覧に必ず入っていること
    expect(CLI_STATUSES).toContain(String(result.status))
    expect(CLI_STATUSES.length, '一覧が空でない').toBeGreaterThanOrEqual(8)
  })

  it('道具は 8 種類の status を出す（読み取りが空振りしていない）', () => {
    const got = emittedByTool()
    expect([...got].sort()).toEqual([
      'ARCHIVE_INVALID', 'ARCHIVE_UNSUPPORTED', 'MANIFEST_UNAVAILABLE', 'MISMATCH',
      'NOTHING_TO_VERIFY', 'OK', 'SOURCE_UNAVAILABLE', 'VERIFICATION_INCOMPLETE',
    ])
  })

  /**
   * **ずれは 3 個（v0.6.7 で 1 個・v0.6.11 でもう 1 個増えた）。**
   *
   * この schema は**こちらが回した記録（自己申告）**の契約で、
   * その経路では作業ツリーを読むので `ARCHIVE_INVALID` も `ARCHIVE_UNSUPPORTED` も出ない。
   * `VERIFICATION_INCOMPLETE` も同じで、**こちらは範囲定義を必ず持っている**ので出ない。
   * **出ない status を enum へ足すと、schema が「出うる」と嘘をつく。**
   * 受け手向けの CLI 結果の契約は別に要る（監査 §7・まだ作っていない）。
   */
  it('**ずれは archive 系 2 個と VERIFICATION_INCOMPLETE の 3 個だけ**（4 個目が増えたらここで落ちる）', () => {
    const gap = [...emittedByTool()].filter((s) => !enumOf().includes(s)).sort()
    expect(gap).toEqual(['ARCHIVE_INVALID', 'ARCHIVE_UNSUPPORTED', 'VERIFICATION_INCOMPLETE'])
    // 逆向き: schema にあって道具が出さない status が無いこと
    expect(enumOf().filter((s) => !emittedByTool().has(s))).toEqual([])
  })

  it('ajv で実際に落ちる（enum が飾りでない）', () => {
    const ajv = new Ajv({ allErrors: true, strict: false })
    const validate = ajv.compile(R(SCHEMA))
    expect(validate({ ...result, status: 'ARCHIVE_INVALID' }), 'v1 が受けてしまっている').toBe(false)
    // 対照: 宣言済みの 5 値は通り、でたらめな値は落ちる
    for (const s of enumOf()) expect(validate({ ...result, status: s }), s).toBe(true)
    expect(validate({ ...result, status: 'NONSENSE' })).toBe(false)
  })

  it('**schema 自身が、表現できない status を名指しで書いている**', () => {
    const desc = R(SCHEMA).properties.status.description as string
    expect(desc).toContain('ARCHIVE_INVALID')
    expect(desc, 'なぜ入れていないかが書かれていない').toMatch(/v2|言語|下流/)
  })

  /**
   * **関門を実際に踏む（v0.6.12）。**
   *
   * v0.6.11 まで、ここは `buildReleaseEvidence.mjs` のソースを正規表現で読み、
   * `process.exit(1)` という文字列が近くに在ることと、手書きの 5 値が enum と同じことを
   * 見ていた。**書き方を変えれば拾えなくなる検査**で、しかも
   * 「止まる」ことそのものは一度も確かめていなかった。
   * いまは判定が投げる関数なので、**表現できない status を渡して実際に投げさせる。**
   */
  it('**生成器は、表現できない status を丸めずに止まる**', () => {
    /**
     * ここに `expressibleStatuses(ROOT)` と `enumOf()` の一致を書きかけたが、
     * **どちらも同じ schema を読むので絶対に落ちない**（実測: 行を消しても 25 件すべて緑）。
     * **守っているように見えて何も守っていない行**は置かない。
     * 一覧が 1 本になったことは、下の 2 つ（通す／投げる）の振る舞いで示す。
     */
    // 表現できる値は素通りする
    for (const s of enumOf()) expect(assertExpressibleInSelfReport(s, ROOT)).toBe(s)
    // 表現できない値は投げる——**丸めて返さない**
    for (const s of ['ARCHIVE_INVALID', 'ARCHIVE_UNSUPPORTED', 'VERIFICATION_INCOMPLETE']) {
      expect(() => assertExpressibleInSelfReport(s, ROOT), `${s} が素通りした`).toThrow(/丸めて出さない/)
    }
    // 対照: 存在しない status も止まる（allowlist であって denylist でない）
    expect(() => assertExpressibleInSelfReport('NONSENSE', ROOT)).toThrow()
  })

  it('現物の artifact は表現できる status を持っている', () => {
    expect(enumOf()).toContain(result.status)
  })
})
