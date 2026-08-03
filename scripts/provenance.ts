/**
 * artifact が「どの入力から作られたか」を記録する。
 *
 * ## なぜ revision だけでは足りないか
 *
 * 2026-08-03 の統合オーダー P0-1 の指摘。監査時の HEAD は `ba58b4c` だったのに、
 * コミット済み profile は `sourceRevision: 5adf454` を持っていた。
 * その間にモデルデータが変わっていたので、**`sourceRevision` が実際の生成入力を
 * 表していなかった。**
 *
 * かといって `sourceRevision === HEAD` を要求してはいけない。
 * **artifact を含めてコミットすると HEAD が変わるので、自己参照になる。**
 * 生成した瞬間に正しかった値が、コミットした瞬間に「古い」と判定されてしまう。
 *
 * ## そこで入力そのものを指紋にする
 *
 * `inputDigest` は**入力ファイルの中身だけ**から作る。artifact は入力ではないので、
 * artifact だけを作り直してコミットしても digest は変わらない。
 * 逆に、寸法を 1 文字でも直せば必ず変わる。
 *
 *   - `generatedFromCommit` … 生成時点の source commit。**一致の要求はしない**（参考値）
 *   - `workingTreeDirty`    … **入力ファイル**に未コミットの変更があるか
 *   - `inputDigest`         … 何から作ったかの一意な指紋。**こちらで固定する**
 *
 * Half-Plug Lab 側は `generatedFromCommit` ではなく `inputDigest` で固定してください。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

/**
 * 生成器の版。**出力の形（項目・意味）を変えたら上げる。**
 * データが変わっただけでは上げない（それは inputDigest が表す）。
 *
 *   1 … 初版
 *   2 … eventId / eventIdentity / spreadStatus を追加、jackBasis.detail を追加 (2026-08-03)
 *   3 … provenance を追加 (2026-08-03)
 *   4 … 感度 artifact にも provenance を付け、profile の sensitivitySummary へ
 *       eventSpreadAvailable / globalSummaryAvailable を追加 (2026-08-03・非阻害オーダー P1-1/P1-3)
 */
export const GENERATOR_VERSION = 4

export interface InputFile {
  path: string
  sha256: string
  role: string
}

export interface Provenance {
  generatorVersion: number
  generatedFromCommit: string
  workingTreeDirty: boolean
  revisionOverride: boolean
  artifactKind: 'local' | 'release'
  inputDigestAlgorithm: 'sha256'
  inputDigest: string
  inputDigestScope: string
  /**
   * digest に混ぜた**ファイル以外の入力**。無い場合は項目ごと出さない。
   *
   * **値を記録しないと第三者が digest を再計算できない。**
   * 「先頭に setting 行を置く」と説明だけ書いても、その中身が分からなければ再現不能で、
   * 再計算できない digest は provenance の役に立たない。
   */
  inputSettings?: Record<string, string>
  inputFiles: InputFile[]
  command: string
  artifactDate: string
}

const sha256 = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex')

/** ディレクトリ配下を決定的な順で列挙する（readdir の順に依存しない） */
function walk(root: string, dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(root, dir)).sort()) {
    const rel = join(dir, name)
    if (statSync(join(root, rel)).isDirectory()) out.push(...walk(root, rel))
    else out.push(rel)
  }
  return out
}

/**
 * digest の対象。**ここに artifact の出力先を入れてはいけない**（自己参照になる）。
 *
 * `artifacts/sensitivity.json` だけは例外で、**入力として読んでいる**ので入れる
 * （events[].spreadMm の元データ）。感度解析を回し直せば digest が変わるのが正しい。
 */
export function listInputs(root: string, variantSlug?: string): InputFile[] {
  const files: InputFile[] = []
  const add = (path: string, role: string) => {
    try {
      files.push({ path, sha256: sha256(readFileSync(resolve(root, path))), role })
    } catch {
      // 読めないものは記録しない。存在しない入力は digest に影響させない
    }
  }
  add('schemas/half-plug-topology-profile.v2.schema.json', 'schema')
  add('scripts/exportHalfPlugProfile.ts', 'generator')
  add('scripts/provenance.ts', 'generator')
  for (const f of walk(root, 'src/data')) add(f, 'model-data')
  for (const f of walk(root, 'src/model')) add(f, 'model-code')
  add('package-lock.json', 'lockfile')
  /**
   * **感度 artifact は variant のものだけを入力にする（統合フォローアップ P1-2）。**
   *
   * 2026-08-03 まで、全 variant が単一の `artifacts/sensitivity.json` を入力にしていた。
   * そのため **3極の感度を測り直しただけで 4極 profile の ID まで変わって**いた。
   * 中身が変わっていないのに ID が変わるのは、受け手に無駄な引き直しをさせる。
   *
   * variantSlug を渡さない場合は、どの感度 artifact も入力にしない
   * （check:stale のように variant を跨いで digest を比べる用途で使う）。
   */
  if (variantSlug) {
    add(`artifacts/sensitivity.${variantSlug}.json`, 'sensitivity-input')
    // 3極 profile は総合解析も使う (プラトー間隔・Tip 橋絡しきい値・挿抜力)
    if (variantSlug === 'trs_jack_trs') add('artifacts/sensitivity.json', 'sensitivity-input')
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * **感度 artifact の入力**（非阻害フォローアップ P1-1）。
 *
 * profile 用の `listInputs` とは対象が違う。感度 artifact は
 * `scripts/sensitivityEvents.ts` がモデルを振って作るので、schema も exporter も入力ではない。
 *
 * **ここに `artifacts/sensitivity.*.json` を入れてはいけない**（自分自身が入力になる）。
 * profile 側は感度 artifact を入力として読むので入れて正しいが、向きが逆である。
 */
export function listSensitivityInputs(root: string): InputFile[] {
  return listGeneratorInputs(root, 'schemas/event-sensitivity.v1.schema.json', 'scripts/sensitivityEvents.ts')
}

/**
 * 目標トポロジーの頑健性 artifact の入力（非阻害フォローアップ P1-4）。
 * 感度 artifact と同じ形。schema と生成器だけが違う。
 */
export function listRobustnessInputs(root: string): InputFile[] {
  return listGeneratorInputs(root, 'schemas/topology-robustness.v2.schema.json', 'scripts/searchTopologyRobustness.ts')
}

/** モデルを振って作る artifact の共通入力。**出力先は絶対に入れない** */
function listGeneratorInputs(root: string, schemaPath: string, generatorPath: string): InputFile[] {
  const files: InputFile[] = []
  const add = (path: string, role: string) => {
    try {
      files.push({ path, sha256: sha256(readFileSync(resolve(root, path))), role })
    } catch {
      // 読めないものは記録しない
    }
  }
  add(schemaPath, 'schema')
  add(generatorPath, 'generator')
  add('scripts/provenance.ts', 'generator')
  for (const f of walk(root, 'src/data')) add(f, 'model-data')
  for (const f of walk(root, 'src/model')) add(f, 'model-code')
  add('package-lock.json', 'lockfile')
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

const git = (root: string, args: string[]): string | null => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/**
 * **入力ファイルだけ**を見て未コミットの変更を判定する。
 *
 * 木全体を見てはいけない。artifact を作り直した直後は必ず artifact が dirty になるので、
 * 「入力は clean なのに release を拒否される」という使えない挙動になる。
 */
export function inputsAreDirty(root: string, files: InputFile[]): boolean {
  const out = git(root, ['status', '--porcelain', '--', ...files.map((f) => f.path)])
  return out === null ? false : out.length > 0
}

/**
 * release artifact を作ってよいかの判定。**規則だけを切り出してある。**
 *
 * `buildProvenance` の中に埋めたままだと、テストするのに
 * 「入力が汚れている git リポジトリ」を用意しないといけない。
 * 作業ツリーの状態でテストの成否が変わるので、規則をここへ出す。
 */
export function assertReleaseAllowed(release: boolean, dirty: boolean, detail = ''): void {
  if (!release || !dirty) return
  throw new Error(
    '入力ファイルに未コミットの変更がある。release artifact は clean な入力からしか作れない。\n'
      + '  変更をコミットしてから、もう一度 --release を付けて実行する。\n'
      + `  ${detail}`,
  )
}

export interface ProvenanceOptions {
  root: string
  /** 感度 artifact を variant 単位で入力に含めるためのスラグ */
  variantSlug?: string
  /** 既定 (profile 用 `listInputs`) ではなくこの一覧を入力とする。感度 artifact 用 */
  inputs?: InputFile[]
  /**
   * **ファイルに現れない variant 固有の設定**を digest に混ぜる。
   *
   * 感度 artifact は 3極も4極も同じスクリプト・同じモデルデータから作られるので、
   * ファイルの中身だけを指紋にすると **2 つの variant の digest が同一になる**。
   * それでは「どちらの解析か」を digest で固定できない
   * （非阻害オーダー P1-1 の「variant別input digest」要件）。
   */
  settings?: Record<string, string>
  command: string
  artifactDate: string
  release: boolean
  /** SOURCE_REVISION による上書きを許すか。通常モードでは許さない */
  allowRevisionOverride: boolean
  envRevision?: string
}

export function buildProvenance(o: ProvenanceOptions): Provenance {
  const inputFiles = o.inputs ?? listInputs(o.root, o.variantSlug)
  const head = git(o.root, ['rev-parse', 'HEAD']) ?? 'UNKNOWN'
  const dirty = inputsAreDirty(o.root, inputFiles)

  // --- revision の上書き ---------------------------------------------------
  // 素通しにすると、古い値を渡したまま「その改訂から作った」と名乗れてしまう。
  // 一致しているなら無害なので通す。食い違っていて許可も無いなら止める。
  let commit = head
  let override = false
  if (o.envRevision) {
    if (o.envRevision === head) {
      // 実際の HEAD と同じ。上書きとして扱う必要が無い
    } else if (o.allowRevisionOverride) {
      commit = o.envRevision
      override = true
    } else {
      throw new Error(
        `SOURCE_REVISION=${o.envRevision} が実際の HEAD (${head}) と食い違っている。\n`
          + '  古い改訂を名乗った artifact ができるので、通常モードでは受け付けない。\n'
          + '  意図してやる場合だけ --unsafe-revision-override を付ける。',
      )
    }
  }

  // --- release モードは clean な入力からしか作らせない -----------------------
  assertReleaseAllowed(o.release, dirty, git(o.root, ['status', '--porcelain', '--', ...inputFiles.map((f) => f.path)]) ?? '')

  // settings 行は先頭に置き、キーの昇順で並べる（並び順で digest が変わらないようにする）
  const settingLines = Object.entries(o.settings ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `setting  ${k}=${v}`)
  const manifest = [...settingLines, ...inputFiles.map((f) => `${f.sha256}  ${f.path}`)].join('\n')
  return {
    generatorVersion: GENERATOR_VERSION,
    generatedFromCommit: commit,
    workingTreeDirty: dirty,
    revisionOverride: override,
    artifactKind: o.release ? 'release' : 'local',
    inputDigestAlgorithm: 'sha256',
    inputDigest: sha256(manifest),
    inputDigestScope:
      (settingLines.length
        ? `先頭に "setting  <key>=<value>" を key 昇順で ${settingLines.length} 行置き、続けて `
        : '')
      + 'inputFiles を path の昇順に並べ、"<sha256>  <path>" を改行で連結した文字列の sha256。'
      + (settingLines.length
        ? 'setting 行は**ファイルに現れない variant 固有の設定**で、これが無いと variant 間で digest が同一になる。'
        : 'variant は含まない (profileId 側が持つ)。')
      + '**生成される artifact 自身は含まない。**',
    ...(settingLines.length ? { inputSettings: o.settings } : {}),
    inputFiles,
    command: o.command,
    artifactDate: o.artifactDate,
  }
}
