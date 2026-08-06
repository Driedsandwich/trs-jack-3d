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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
    const ALLOWED = ['git archive', 'git rev-parse']
    for (const c of calls) expect(ALLOWED, `${c} は読み取り専用の一覧に無い`).toContain(c)
  })

  /**
   * **受け手に道具の前提を増やさない（v0.4.1）。**
   *
   * v0.4.0 では `--fetch github` が `gh api` を呼んでいた。
   * 下流の環境に `gh` が無く `spawnSync gh ENOENT` になり、
   * **配った検証ツールの network 経路が使えなかった。**
   * Node 18 以降は `fetch` が組み込みなので、外部コマンドは要らない。
   */
  it('**`gh` に依存していない**（受け手の環境に無くても使える）', () => {
    expect(SRC).not.toMatch(/execFileSync\(\s*'gh'/)
    expect(SRC).not.toMatch(/'gh api'/)
    // 取得は組み込みの fetch を GET で使う（read-only の性質は変わらない）
    expect(SRC).toMatch(/await fetch\(/)
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

  /**
   * **`--scope` を渡さないと、この検査は空振りする**（v0.3.0 フォローアップ P1-2）。
   *
   * v0.2.0 の source には範囲定義が入っていないので、範囲を外から渡さないかぎり
   * 記録漏れの検出は**実行されない**。実行していないのに「候補 0 件」を合格の根拠にすると、
   * それは 0 件を見て安心する典型的な空振りになる。
   * だから `performed` を先に見て、そのうえで 0 件を見る。
   */
  it('記録漏れの入力候補が 0 件（**検出を実行したうえで** 0 件）', () => {
    const out = run(['--manifest', tagManifest(), '--tag', 'v0.2.0', '--scope', 'source-input-scope.v1.json'])
    expect((out.json.unrecordedInputDetection as { performed: boolean }).performed).toBe(true)
    expect(out.json.unrecordedInputCandidates).toEqual([])
    expect(out.json.status).toBe('OK')
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

  /**
   * **範囲定義が要る**（v0.3.0 フォローアップ P1-2）。
   * v0.2.0 の source には入っていないので `--scope` で渡す。
   *
   * この検査は 2026-08-03 まで `src/model/` を落とす変異しか見ておらず、
   * **範囲の外（`scripts/`・`schemas/`・`package-lock.json`）は素通りしていた。**
   * 範囲の外側からの変異は `test/sourceInputScope.test.ts` の回帰に入れてある。
   */
  it('**記録漏れの入力を見つける**（digest が覆っていない入力）', () => {
    const p = tagManifest((d) => {
      const o = d as { inputFiles: { path: string }[]; inputFilesTotal: number }
      o.inputFiles = o.inputFiles.filter((f) => !f.path.startsWith('src/model/'))
      o.inputFilesTotal = o.inputFiles.length
    })
    const r = run(['--manifest', p, '--tag', 'v0.2.0', '--scope', 'source-input-scope.v1.json'])
    expect(r.json.status).toBe('MISMATCH')
    const extra = mustBeNonEmpty(r.json.unrecordedInputCandidates as string[], '記録漏れの入力候補')
    expect(extra.every((x) => x.startsWith('src/model/'))).toBe(true)
  })
})

/**
 * **どの出口にも版が入っていること（v0.4.1）。**
 *
 * v0.4.0 では成功・不一致の出口にしか `toolVersion` が無く、
 * 下流が保存した `SOURCE_UNAVAILABLE` の記録には版が入っていなかった。
 * **記録を受け取った側が、どの版の道具の出力か判別できない。**
 */
/**
 * **`--source` に tar.gz を渡せる（v0.5.0）。**
 *
 * v0.4.1 までは展開済みディレクトリしか受けなかったのに、
 * release notes と snapshot の手順書は `--source src.tar.gz` と書いていた。
 * **書いてある手順が ENOTDIR で落ちていた。**
 */
describe('§5-3c --source に archive を渡せる', () => {
  /**
   * **同じ中身から dir と tar.gz を作って比べる。**
   *
   * 最初は `git archive HEAD` を使っていたが、それは**コミット済みの中身**なので、
   * 作業ツリーに未コミットの入力変更があると manifest と食い違って MISMATCH になった
   * （v0.5.1 の実装中に実際に落ちた）。archive loader を試したいのに、
   * コミット状態でテストの成否が変わるのは筋が悪い。
   *
   * 代わりに **source snapshot artifact から中身を復元**する。
   * manifest が記録した 30 入力はすべてここに入っているので、
   * dir 経路と archive 経路が**同じ中身**を見ていることを保証できる。
   */
  const work = mkdtempSync(join(tmpdir(), 'srcarch-'))
  tmps.push(work)
  const srcDir = join(work, 'src')
  /** GitHub の tarball と同じく、展開すると 1 枚かぶる親ディレクトリ */
  const TOP = 'Driedsandwich-trs-jack-3d-abc1234'
  const tgz = join(work, 'src.tar.gz')

  it('前提: snapshot から中身を復元し、tar.gz に固められる', () => {
    const snap = JSON.parse(readFileSync(resolve(ROOT, 'artifacts/source-snapshot.v1.json'), 'utf8'))
    expect(snap.files.length, '写しが空').toBeGreaterThan(30)
    // **GitHub の tarball と同じ形にする。**展開すると親ディレクトリが 1 枚かぶる
    for (const f of snap.files as { path: string, content: string }[]) {
      const dest = join(srcDir, TOP, f.path)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, f.content)
    }
    // 記録された入力が復元先に全部あること（無いと下の比較が空振りする）
    const manifest = JSON.parse(readFileSync(resolve(ROOT, 'artifacts/source-input-manifest.json'), 'utf8'))
    const missing = (manifest.inputFiles as { path: string }[]).filter((f) => !existsSync(join(srcDir, TOP, f.path)))
    expect(missing.map((f) => f.path), '写しに無い入力').toEqual([])

    /**
     * **`COPYFILE_DISABLE=1` が要る。**macOS の tar は AppleDouble (`._*`) を混ぜる。
     * 混ざると stripTopLevel が「共通の親が 1 枚」と判定できなくなり、
     * 30 件すべてが missingInSource になる（v0.5.1 の実装中に実際に踏んだ）。
     */
    execFileSync('tar', ['czf', tgz, '-C', srcDir, TOP], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    expect(statSync(tgz).size, 'archive が空').toBeGreaterThan(1000)
  })

  it('tar.gz を渡すと展開済みディレクトリと同じ判定になる', () => {
    const args = (src: string) => ['--manifest', 'artifacts/source-input-manifest.json', '--source', src, '--scope', 'source-input-scope.v1.json']
    const fromDir = run(args(join(srcDir, TOP)))
    const fromTgz = run(args(tgz))
    expect(fromDir.json.status, `dir 経路が失敗した: ${JSON.stringify(fromDir.json).slice(0, 300)}`).toBe('OK')
    expect(fromTgz.json.status, `archive 経路が失敗した: ${JSON.stringify(fromTgz.json).slice(0, 300)}`).toBe('OK')
    // **origin だけが違い、判定は同じ**であること
    expect(fromTgz.json.independentVerification).toEqual(fromDir.json.independentVerification)
    expect(String(fromTgz.json.origin)).toContain('archive:')
    expect(String(fromDir.json.origin)).toContain('directory:')
  })

  /**
   * **v0.6.0 で ARCHIVE_INVALID を分けた（TOOL_VERSION 5）。**
   * v0.5.2 までは「取れなかった」も「取れたが壊れている」も SOURCE_UNAVAILABLE だった。
   * 受け手が記録を保存しても、**通信の問題なのか改竄なのかを読み分けられない。**
   */
  it('壊れた archive は ARCHIVE_INVALID（取れなかったのとは別に扱う）', () => {
    const broken = join(mkdtempSync(join(tmpdir(), 'brokenarch-')), 'src.tar.gz')
    writeFileSync(broken, Buffer.from('これは tar.gz ではない'))
    const r = run(['--manifest', 'artifacts/source-input-manifest.json', '--source', broken])
    expect(r.json.status).toBe('ARCHIVE_INVALID')
    expect(String(r.json.reason)).toContain('gzip')
    expect(String(r.json.note)).toContain('不一致ではない')
  })

  it('**存在しない archive は SOURCE_UNAVAILABLE のまま**（2 つを取り違えていない）', () => {
    const r = run(['--manifest', 'artifacts/source-input-manifest.json', '--source', '/no/such/src.tar.gz'])
    expect(r.json.status).toBe('SOURCE_UNAVAILABLE')
  })
})

describe('§5-3b すべての出口に toolVersion が入る', () => {
  /**
   * **tag に固定しない。**最初は `--tag v0.4.0` と書いたが、
   * 次の版で lockfile が変わった瞬間に `MISMATCH` になった（この検査が見たいのは版ではない）。
   * 現在の作業ツリーと突き合わせれば、どの版でも `OK` になる。
   */
  const EXITS: [string, string[]][] = [
    ['OK', ['--manifest', 'artifacts/source-input-manifest.json', '--source', '.', '--scope', 'source-input-scope.v1.json']],
    ['SOURCE_UNAVAILABLE', ['--manifest', 'artifacts/source-input-manifest.json', '--tag', 'v9.9.9-does-not-exist']],
    ['MANIFEST_UNAVAILABLE', ['--manifest', 'artifacts/does-not-exist.json', '--source', '.']],
  ]
  for (const [want, args] of EXITS)
    it(`${want} の出力に toolVersion がある`, () => {
      const r = run(args)
      expect(r.json.status).toBe(want)
      expect(r.json.toolVersion, `${want} に版が無い`).toBeGreaterThanOrEqual(3)
    })

  it('NOTHING_TO_VERIFY の出力にも toolVersion がある', () => {
    const p = tagManifest((d) => {
      const o = d as { inputFiles: unknown[]; inputFilesTotal: number }
      o.inputFiles = []
      o.inputFilesTotal = 0
    })
    const r = run(['--manifest', p, '--tag', 'v0.2.0'])
    expect(r.json.status).toBe('NOTHING_TO_VERIFY')
    expect(r.json.toolVersion).toBeGreaterThanOrEqual(3)
  })

  it('**各出口へ手で書かず、done() が入れている**（出口が増えても忘れない）', () => {
    expect(SRC).toMatch(/const done = \([^)]*\) => \{[\s\S]{0,200}toolVersion: TOOL_VERSION/)
    // 個別の done 呼び出しに toolVersion を書き足していないこと
    const perCall = [...SRC.matchAll(/done\(\{[\s\S]{0,120}?toolVersion/g)]
    expect(perCall).toHaveLength(0)
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
