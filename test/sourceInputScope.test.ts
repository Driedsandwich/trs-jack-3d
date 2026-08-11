/**
 * 入力の範囲定義（v0.3.0 フォローアップ P1-2）。
 *
 * ## 何を直したのか
 *
 * 2026-08-03 まで、入力の範囲が**2 か所に別々に書かれていた。**
 *
 *   生成側 `scripts/provenance.ts`            … add() を並べた実際の入力
 *   検証側 `verifyReleaseSourceInputs.mjs`    … const INPUT_DIRS = ['src/data','src/model']
 *
 * 検証側が狭いので、**manifest から `scripts/`・`schemas/`・`package-lock.json` を落としても
 * exit 0 で素通りした**（入力 28 件のうち記録漏れを検出できるのは 8 件だけ）。
 *
 * ## なぜ自分で見つけられなかったか
 *
 * この機能には変異試験を 7 件書いて全部落としていた。だが**変異が全部 `INPUT_DIRS` の
 * 内側（`src/model/`）だった。**探索範囲そのものが仮定なので、内側から叩いても仮定は揺れない。
 * **変異が全部落ちること自体は、範囲が正しいことの証拠にならない。**
 *
 * だからここでは**範囲の外側から**変異を入れる。下の「回帰」がそれで、
 * 今日素通りした 4 件をそのまま並べてある。
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Ajv from 'ajv'
import { afterAll, describe, expect, it } from 'vitest'
import { INPUT_SCOPE_FILE, listInputs, listRobustnessInputs, listSensitivityInputs, loadInputScope, roleOfInput } from '../scripts/provenance'
import { mustBeNonEmpty, mustFind } from './_must'

const ROOT = resolve(__dirname, '..')
const R = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))
const SCOPE = loadInputScope(ROOT)

/**
 * **台帳も検証対象も「現在」に揃える。**
 *
 * v0.4.1 までは v0.3.0 tag の source に当てていた（作業ツリーの状態で成否が変わらないように）。
 * だが manifest が記述しているのは**現在の入力**なので、過去 tag に当てると
 * **その tag に無いファイルは落としても検出しようがない。**
 * v0.5.0 で入力が 1 件増えたとき、それを落としても OK が返って実際に空振りした。
 * ずれを隠さないよう、**無変異の対照**（下の「対照」）を先に置く。
 */
const MANIFEST_PATH = 'artifacts/source-input-manifest.json'

const tmps: string[] = []
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })))

/** 現在の manifest を一時ファイルへ出す（**script は書かない。テストが書く**） */
function tagManifest(mutate?: (d: Record<string, unknown>) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'scope-'))
  tmps.push(dir)
  const d = R(MANIFEST_PATH)
  mutate?.(d)
  const p = join(dir, 'manifest.json')
  writeFileSync(p, JSON.stringify(d))
  return p
}

/** verifier を走らせる。**落ちても JSON は出る** */
function verify(args: string[]): { code: number; json: Record<string, never> } {
  try {
    const out = execFileSync('node', ['scripts/verifyReleaseSourceInputs.mjs', ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
    return { code: 0, json: JSON.parse(out) }
  } catch (e) {
    const err = e as { status?: number; stdout?: string }
    return { code: err.status ?? -1, json: JSON.parse(String(err.stdout ?? '{}')) }
  }
}

/** 記録から paths を落とした manifest で検証する */
function dropAndVerify(drop: (path: string) => boolean, scope = INPUT_SCOPE_FILE) {
  const p = tagManifest((d) => {
    const o = d as { inputFiles: { path: string }[]; inputFilesTotal: number }
    o.inputFiles = o.inputFiles.filter((f) => !drop(f.path))
    o.inputFilesTotal = o.inputFiles.length
  })
  // **作業ツリーを source にする。**manifest が記述しているのは現在の入力なので、
  // 過去 tag の source に当てると「その tag に無いファイル」を検出しようがない
  // （v0.5.0 で contract-migration.v1.json を落としても OK が返り、実際に空振りした）。
  return verify(['--manifest', p, '--source', ROOT, '--scope', scope])
}

// ---------------------------------------------------------------------------

describe('P1-2-1 範囲定義そのもの', () => {
  it('schema に適合する', () => {
    const ajv = new Ajv({ allErrors: true, strict: false })
    const ok = ajv.compile(R('schemas/source-input-scope.v1.schema.json'))(SCOPE)
    expect({ ok, errors: ajv.errors }).toEqual({ ok: true, errors: null })
  })

  it('**範囲定義自身が入力に入っている**（入らないと範囲を変えても digest が動かない）', () => {
    expect(SCOPE.requiredExactFiles).toContain(INPUT_SCOPE_FILE)
    expect(SCOPE.commonInputs).toContain(INPUT_SCOPE_FILE)
  })

  it('generators は requiredExactFiles の射影である（別の一覧になっていない）', () => {
    const required = new Set(SCOPE.requiredExactFiles)
    const gens = mustBeNonEmpty(Object.entries(SCOPE.generators), '生成器の定義')
    for (const [key, g] of gens) {
      expect(required, `generators.${key}.schema`).toContain(g.schema)
      expect(required, `generators.${key}.generator`).toContain(g.generator)
    }
  })

  it('**notCovered が空でない**（覆えないものは必ずある。無いと書いたら嘘になる）', () => {
    const nc = mustBeNonEmpty(SCOPE.notCovered, '覆っていない範囲')
    // 「対象外」とだけ書いて済ませていないこと
    for (const x of nc) expect(x.consequence.length, JSON.stringify(x)).toBeGreaterThan(10)
  })

  it('allowedGeneratedInputs は excludedOutputs の下にある（例外として意味を持つ）', () => {
    const allowed = mustBeNonEmpty(SCOPE.allowedGeneratedInputs, '例外の生成物入力')
    for (const p of allowed) expect(SCOPE.excludedOutputs.some((d) => p.startsWith(`${d}/`)), p).toBe(true)
  })
})

describe('P1-2-2 生成側と検証側が同じ範囲を読む', () => {
  it('生成側の入力一覧が範囲定義とちょうど一致する', () => {
    const union = new Set<string>()
    for (const v of [listInputs(ROOT, 'trs_jack_trs'), listInputs(ROOT, 'trs_jack_trrs'), listSensitivityInputs(ROOT), listRobustnessInputs(ROOT)])
      v.forEach((f) => union.add(f.path))

    const expected = new Set([...SCOPE.requiredExactFiles, ...SCOPE.allowedGeneratedInputs])
    for (const d of SCOPE.recursiveDirectories)
      for (const p of union) if (p.startsWith(`${d}/`)) expected.add(p)

    expect([...union].filter((p) => !expected.has(p)), '入力にあるが範囲外').toEqual([])
    expect([...expected].filter((p) => !union.has(p)), '範囲内なのに入力に無い').toEqual([])
  })

  it('**検証側に範囲の直書きが残っていない**（残ると片方だけずれる）', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/verifyReleaseSourceInputs.mjs'), 'utf8')
    expect(src).not.toMatch(/INPUT_DIRS\s*=\s*\[/)
    expect(src).toContain('source-input-scope.v1.json')
  })

  /**
   * ファイル名は 3 か所に書かれている（`.mjs` から `.ts` を import できないため）。
   * **名前がずれたら、evidence が範囲を書かないまま作られる。**
   */
  it('範囲定義のファイル名が生成側・検証側・evidence で一致する', () => {
    const files = ['scripts/provenance.ts', 'scripts/verifyReleaseSourceInputs.mjs', 'scripts/buildReleaseEvidence.mjs']
    for (const f of files) {
      const src = readFileSync(resolve(ROOT, f), 'utf8')
      expect(src, `${f} が ${INPUT_SCOPE_FILE} を参照していない`).toContain(`'${INPUT_SCOPE_FILE}'`)
    }
    // schemaId の版と実ファイル名の版が揃っていること
    expect(INPUT_SCOPE_FILE).toContain(SCOPE.schemaId.split('.').pop())
  })

  /**
   * **role を足したら schema の enum も足す。**
   *
   * 2026-08-03、範囲定義を入力に加えたときに `input-scope` という role が増えたが、
   * artifact schema の enum に足し忘れた。**再生成するまで気づかなかった。**
   *
   * しかも「enum があるか」を調べた自分の検出コードが `type: 'string'` を条件にしていて、
   * enum だけ書かれたノードを取りこぼし、**「role に enum は無い」と誤って読んだ。**
   * 検出条件が狭いと、無いものが無いのか見えていないのかが区別できない。
   *
   * だからここでは**実際に生成される role を全部集めて**、enum に載っているかを機械で見る。
   */
  it('**生成される role が artifact schema の enum に全部載っている**', () => {
    const produced = new Set<string>()
    for (const v of [listInputs(ROOT, 'trs_jack_trs'), listInputs(ROOT, 'trs_jack_trrs'), listSensitivityInputs(ROOT), listRobustnessInputs(ROOT)])
      v.forEach((f) => produced.add(f.role))
    mustBeNonEmpty([...produced], '生成される role')
    // **`other` が出たら、範囲に入っているのに分類できていない入力がある**
    expect([...produced], 'roleOfInput が分類できない入力がある').not.toContain('other')

    /** schema の中から role の enum を引く。**引けなければ落とす**（見つからないを合格にしない） */
    const roleEnum = (schemaPath: string): string[] => {
      const walk = (o: unknown): string[] | null => {
        if (Array.isArray(o)) return o.map(walk).find(Boolean) ?? null
        if (o && typeof o === 'object') {
          const e = (o as { enum?: unknown }).enum
          if (Array.isArray(e) && e.includes('model-code')) return e as string[]
          return Object.values(o).map(walk).find(Boolean) ?? null
        }
        return null
      }
      const e = walk(R(schemaPath))
      if (!e) throw new Error(`${schemaPath} に role の enum が見つからない`)
      return e
    }

    // **現役の schema だけ。**v1 は過去の release の契約なので触らない
    for (const s of [
      'schemas/half-plug-topology-profile.v3.schema.json',
      'schemas/event-sensitivity.v2.schema.json',
      'schemas/topology-robustness.v3.schema.json',
    ]) {
      const allowed = roleEnum(s)
      for (const r of produced) expect(allowed, `${s} の enum に role "${r}" が無い`).toContain(r)
    }
  })

  it('role は範囲定義から導かれる（手で書かない）', () => {
    expect(roleOfInput(SCOPE, INPUT_SCOPE_FILE)).toBe('input-scope')
    expect(roleOfInput(SCOPE, 'package-lock.json')).toBe('lockfile')
    expect(roleOfInput(SCOPE, 'src/model/topology.ts')).toBe('model-code')
    expect(roleOfInput(SCOPE, 'schemas/topology-robustness.v3.schema.json')).toBe('schema')
    expect(roleOfInput(SCOPE, mustFind(SCOPE.allowedGeneratedInputs, () => true, '例外入力'))).toBe('sensitivity-input')
  })

  it('**範囲定義が読めなければ落ちる**（既定値へ黙って戻さない）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noscope-'))
    tmps.push(dir)
    expect(() => loadInputScope(dir)).toThrow(/範囲定義/)
  })

  /**
   * **必須の入力が消えたら落ちる。**黙って飛ばすと、その入力抜きの digest ができる。
   * 値だけ変わって理由が残らないので、あとから追えない。
   */
  it('**必須入力が読めなければ生成側が落ちる**（欠けた digest を黙って作らない）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'partial-'))
    tmps.push(dir)
    // 範囲定義だけ置いて、他の必須入力（package-lock.json 等）は置かない
    writeFileSync(join(dir, INPUT_SCOPE_FILE), readFileSync(resolve(ROOT, INPUT_SCOPE_FILE)))
    writeFileSync(join(dir, 'contract-migration.v1.json'), readFileSync(resolve(ROOT, 'contract-migration.v1.json')))
    expect(() => listInputs(dir, 'trs_jack_trs')).toThrow(/必須の入力/)
  })
})

describe('P1-2-3 回帰 — 2026-08-03 に素通りした 4 件', () => {
  /**
   * **`rc !== 0` だけで判定しない。**落としたパスが
   * `unrecordedInputCandidates` に名指しで出ていることまで見る。
   * 別の理由で落ちていたら、この検査は何も守っていない。
   */
  /**
   * **件数は台帳から引く。**数字を直書きすると、入力が増えたときに
   * 「数字を書き換えて緑にする」作業になり、検査の意味が薄れる
   * （v0.5.0 で contract-migration.v1.json が入力に増えて実際にずれた）。
   */
  const MANIFEST_INPUTS = (R('artifacts/source-input-manifest.json').inputFiles as { path: string }[]).map((f) => f.path)

  const CASES: [string, (p: string) => boolean][] = [
    ['src/model/（範囲の内側。当時も検出できた）', (p) => p.startsWith('src/model/')],
    ['scripts/（生成器本体。**当時は exit 0**）', (p) => p.startsWith('scripts/')],
    ['schemas/（**当時は exit 0**）', (p) => p.startsWith('schemas/')],
    ['package-lock.json（**当時は exit 0**）', (p) => p === 'package-lock.json'],
    ['contract-migration.v1.json（v0.5.0 で増えた入力）', (p) => p === 'contract-migration.v1.json'],
  ]

  it('対照: 何も落とさなければ OK（台帳と作業ツリーが揃っている）', () => {
    // ここが MISMATCH なら、下の変異試験は「別の理由で落ちている」ことになる
    const r = dropAndVerify(() => false)
    expect({ status: r.json.status, code: r.code }).toEqual({ status: 'OK', code: 0 })
  })

  for (const [name, drop] of CASES)
    it(`記録漏れを検出する: ${name}`, () => {
      const expected = MANIFEST_INPUTS.filter(drop)
      // 落とす対象が 0 件なら、この検査は何も落としていない（空振り）
      mustBeNonEmpty(expected, `${name} に該当する記録済み入力`)
      const r = dropAndVerify(drop)
      expect({ status: r.json.status, code: r.code }).toEqual({ status: 'MISMATCH', code: 1 })
      const extra = mustBeNonEmpty(r.json.unrecordedInputCandidates as unknown as string[], '未記録の入力候補')
      expect([...extra].sort()).toEqual([...expected].sort())
    })

  it('**変異なしなら通る**（何でも MISMATCH にする検査になっていない）', () => {
    const r = verify(['--manifest', tagManifest(), '--source', ROOT, '--scope', INPUT_SCOPE_FILE])
    expect({ status: r.json.status, code: r.code }).toEqual({ status: 'OK', code: 0 })
    expect(r.json.unrecordedInputCandidates).toEqual([])
    // **件数は台帳から引く。**直書きすると入力が増えたときに数字合わせになる
    const total = (R(MANIFEST_PATH).inputFiles as unknown[]).length
    expect(total, '台帳の入力が 0 件').toBeGreaterThan(0)
    expect((r.json.independentVerification as { checked: number }).checked).toBe(total)
  })

  /**
   * **範囲定義が本当に効いているか。**
   * 範囲から `src/model` を外せば、`src/model` を落とす変異は検出されなくなるはず。
   * ならなければ、範囲定義を読んでいるふりをして別のどこかで判定している。
   */
  it('**範囲を狭めると、その分だけ検出されなくなる**（範囲定義が判定を動かしている証拠）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'narrow-'))
    tmps.push(dir)
    const narrow = { ...SCOPE, recursiveDirectories: SCOPE.recursiveDirectories.filter((d) => d !== 'src/model') }
    const p = join(dir, 'narrow-scope.json')
    writeFileSync(p, JSON.stringify(narrow))

    /**
     * **狭めた範囲は、まず manifest との照合で弾かれる（v0.6.11・外部監査 P0-A）。**
     *
     * v0.6.10 まで `--scope` は中身を確かめずに受け取っていたので、
     * **範囲を狭めるだけで「漏れ 0 件」を作れた。**いまは manifest の
     * `inputScope.sha256` と完全一致しなければ、探索そのものを実行しない。
     */
    const pinnedCut = dropAndVerify((x) => x.startsWith('src/model/'), p)
    expect(pinnedCut.json.status).toBe('VERIFICATION_INCOMPLETE')
    expect((pinnedCut.json.unrecordedInputDetection as { stableReasonCode: string }).stableReasonCode)
      .toBe('SCOPE_SHA256_MISMATCH')

    /**
     * **それでも「範囲定義が判定を動かしている」ことは示す。**
     * 範囲を記録していない manifest（古い tag と同じ形）へ明示のフラグで渡すと、
     * 狭めたぶんだけ候補が消える——**判定は範囲を読んで出ている。**
     */
    const unpinned = (scope: string) => {
      const m = tagManifest((d) => {
        const o = d as { inputFiles: { path: string }[], inputFilesTotal: number, inputScope?: unknown }
        o.inputFiles = o.inputFiles.filter((f) => !f.path.startsWith('src/model/'))
        o.inputFilesTotal = o.inputFiles.length
        delete o.inputScope
      })
      return verify(['--manifest', m, '--source', ROOT, '--scope', scope, '--allow-unpinned-scope'])
    }
    const wide = unpinned(INPUT_SCOPE_FILE)
    const cut = unpinned(p)
    const n = (r: { json: Record<string, unknown> }) => (r.json.unrecordedInputCandidates as string[]).length
    expect(n(wide), '広い範囲では src/model の落としを検出する').toBeGreaterThan(0)
    expect(n(cut), '範囲から外せば検出されなくなる').toBe(0)
    expect({ wide: wide.json.status, cut: cut.json.status })
      .toEqual({ wide: 'MISMATCH', cut: 'VERIFICATION_INCOMPLETE' })
  })
})

describe('P1-2-4 検出していないときに黙らない', () => {
  it('**範囲定義が無い source では performed: false と書く**（候補 0 件と言わない）', () => {
    /**
     * **ここだけ v0.3.0 の実物を使う。**
     * 作業ツリーには範囲定義が必ず入っているので、「範囲定義が無い source」を
     * 現在のツリーからは作れない。v0.3.0 はそれが実在した最後の release である。
     * 台帳も v0.3.0 のものを使う（source と揃えないと別の理由で落ちる）。
     */
    const old = JSON.parse(execFileSync('git', ['show', 'v0.3.0:artifacts/source-input-manifest.json'], { cwd: ROOT, encoding: 'utf8' }))
    const dir = mkdtempSync(join(tmpdir(), 'oldscope-'))
    tmps.push(dir)
    const mp = join(dir, 'manifest.json')
    writeFileSync(mp, JSON.stringify(old))

    const r = verify(['--manifest', mp, '--tag', 'v0.3.0'])
    const d = r.json.unrecordedInputDetection as unknown as { performed: boolean; reason: string; note: string }
    expect(d.performed).toBe(false)
    expect(d.reason).toContain(INPUT_SCOPE_FILE)
    // **既定へ戻していないことを書いてあること**
    expect(d.note).toContain('既定の範囲へ戻すことは意図的にしていない')
    // sha256 の検算は有効。両方を潰さない
    expect((r.json.independentVerification as { checked: number }).checked).toBe(old.inputFiles.length)
  })

  it('範囲定義があるときは performed: true と出所を書く', () => {
    const r = verify(['--manifest', tagManifest(), '--source', ROOT, '--scope', INPUT_SCOPE_FILE])
    const d = r.json.unrecordedInputDetection as unknown as { performed: boolean; scopeSource: string }
    expect(d.performed).toBe(true)
    expect(d.scopeSource).toContain(INPUT_SCOPE_FILE)
  })

  it('**覆っていない範囲を出力に載せる**（一致を全件保証と読ませない）', () => {
    const r = verify(['--manifest', tagManifest(), '--source', ROOT, '--scope', INPUT_SCOPE_FILE])
    const nc = mustBeNonEmpty(r.json.notCoveredByDigest as unknown as { what: string }[], '覆っていない範囲')
    expect(nc.map((x) => x.what).join(' / ')).toMatch(/Node/)
  })
})

describe('P1-2-5 自己参照の検出', () => {
  it('**出力を入力に記録していたら MISMATCH**', () => {
    const p = tagManifest((d) => {
      const o = d as { inputFiles: Record<string, unknown>[]; inputFilesTotal: number }
      o.inputFiles.push({
        path: 'artifacts/topology-robustness.trs_jack_trrs.json',
        role: 'generator',
        recordedSha256: 'a'.repeat(64),
        consistentAcrossArtifacts: true,
        actualSha256AtBuild: 'a'.repeat(64),
        matchesWorkingTree: true,
        consumedBy: ['artifacts/topology-robustness.trs_jack_trrs.json'],
      })
      o.inputFilesTotal = o.inputFiles.length
    })
    const r = verify(['--manifest', p, '--source', ROOT, '--scope', INPUT_SCOPE_FILE])
    expect(r.json.status).toBe('MISMATCH')
    const self = mustBeNonEmpty(r.json.selfReferencingInputs as unknown as string[], '自己参照の入力')
    expect(self).toContain('artifacts/topology-robustness.trs_jack_trrs.json')
  })

  it('例外に挙げた感度 artifact は自己参照として扱わない', () => {
    const r = verify(['--manifest', tagManifest(), '--source', ROOT, '--scope', INPUT_SCOPE_FILE])
    expect(r.json.selfReferencingInputs).toEqual([])
    // 実際に感度 artifact が記録されていること（例外が空振りしていない）
    const paths = R('artifacts/source-input-manifest.json').inputFiles.map((f: { path: string }) => f.path)
    for (const p of SCOPE.allowedGeneratedInputs) expect(paths).toContain(p)
  })
})

describe('P1-2-6 配布に入っている', () => {
  it('**範囲定義と schema が release asset にある**（受け手が自分で範囲を歩けること）', async () => {
    const { RELEASE_ASSETS } = await import('../scripts/releaseAssets.mjs')
    const paths = RELEASE_ASSETS.map((a) => a.path)
    expect(paths).toContain(INPUT_SCOPE_FILE)
    expect(paths).toContain('schemas/source-input-scope.v1.schema.json')
  })
})
