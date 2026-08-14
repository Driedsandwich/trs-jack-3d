/**
 * release に同梱する「検証の証拠」を作る。
 *   npm run release:evidence
 *
 * ## 何を解くのか（非阻害フォローアップ P2-7 / P2-8）
 *
 * v0.1.1 の release asset だけを受け取った側は、次を確かめられなかった。
 *
 *   - こちらで意味規則が通っているのか（`validate:profiles` の結果が入っていない）
 *   - `provenance.inputFiles[].sha256` が tag source の実ファイルと一致するのか
 *   - **tag 時点のテスト件数**（`test_counts.json` が入っておらず、
 *     報告の 260 件が tag の 258 件なのか main の値なのかを判別できなかった）
 *
 * どれも「こちらは知っているが渡していない」だけだった。渡す。
 *
 * ## 作るもの
 *
 *   artifacts/validation-results.json   … 検証の結果（判定は validateProfiles と同一実装）
 *   artifacts/source-input-manifest.json … 全 artifact の入力ファイルの和集合と sha256
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Ajv from 'ajv'
import { validateAll } from './validateProfiles.mjs'
import { RELEASE_ASSETS, SOURCE_ONLY_TARGETS } from './releaseAssets.mjs'
import { migrationFor } from './contractMigration.mjs'
import { buildSourceSnapshot } from './buildSourceSnapshot.mjs'
import { CLI_STATUSES, CLI_STATUS_EXIT, INTERNAL_FAILURE_EXIT } from './verifyReleaseSourceInputs.mjs'
import { assertExpressibleInSelfReport } from './selfReportStatus.mjs'

const ROOT = process.cwd()
const read = (p) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))
const sha256File = (p) => createHash('sha256').update(readFileSync(resolve(ROOT, p))).digest('hex')

/**
 * 入力の範囲定義（v0.3.0 フォローアップ P1-2）。
 * `scripts/provenance.ts` と `scripts/verifyReleaseSourceInputs.mjs` が読むのと同じファイル。
 * **無ければ止める。**範囲を書かずに evidence を作ると、受け手は記録漏れを確かめられない。
 */
const INPUT_SCOPE_FILE = 'source-input-scope.v1.json'
if (!existsSync(resolve(ROOT, INPUT_SCOPE_FILE))) {
  console.log(`**${INPUT_SCOPE_FILE} が無い。**入力の範囲を書けないので evidence を作らない。`)
  process.exit(1)
}
const inputScope = JSON.parse(readFileSync(resolve(ROOT, INPUT_SCOPE_FILE), 'utf8'))

/** 検証を回した記録の置き場（v0.3.0 フォローアップ P1-3） */
const SOURCE_VERIFICATION_PATH = 'artifacts/source-verification-result.json'
const ARTIFACT_DATE = process.env.ARTIFACT_DATE ?? new Date().toISOString().slice(0, 10)

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'UNKNOWN'
  }
}

/**
 * ## 生成の順番には理由がある
 *
 * 1. `source-input-manifest.json` を書く
 * 2. `trs-jack-3d-release-index.v1.json` を書く
 * 3. その 2 つを含めて `validateAll()` を回す
 * 4. `validation-results.json` を書く
 *
 * **`validation-results.json` を検証対象に入れていないのは、自分自身を記述できないからである。**
 * 対象に入れると、書かれる内容が「一つ前の自分」を指し、1 回の実行では収束しない。
 * 代わりに、書いた直後にその schema で検証して、通らなければ止める（下）。
 * 索引も同じ理由で対象外にしている（索引は他 asset の sha256 を持つので、自分の分は持てない）。
 *
 * ---------------------------------------------------------------------------
 * 1. 入力ファイルの一覧（tag source と突き合わせるためのもの）
 * ---------------------------------------------------------------------------
 */

/**
 * 全 artifact の `provenance.inputFiles` を集める。
 *
 * **同じパスが違う sha256 で現れたら、それは事故である。**
 * artifact ごとに生成時点がずれていて、片方が古い入力から作られている。
 * 黙って先勝ちにせず、両方を残して `consistent: false` を立てる。
 */
const byPath = new Map()
for (const { path } of RELEASE_ASSETS) {
  if (!existsSync(resolve(ROOT, path))) continue
  let a
  try {
    a = read(path)
  } catch {
    continue
  }
  for (const f of a.provenance?.inputFiles ?? []) {
    const e = byPath.get(f.path) ?? { path: f.path, role: f.role, recordedSha256: new Set(), consumedBy: [] }
    e.recordedSha256.add(f.sha256)
    e.consumedBy.push(path)
    byPath.set(f.path, e)
  }
}

const inputs = [...byPath.values()]
  .sort((a, b) => a.path.localeCompare(b.path))
  .map((e) => {
    const recorded = [...e.recordedSha256]
    const actual = existsSync(resolve(ROOT, e.path)) ? sha256File(e.path) : null
    return {
      path: e.path,
      role: e.role,
      recordedSha256: recorded.length === 1 ? recorded[0] : recorded,
      consistentAcrossArtifacts: recorded.length === 1,
      actualSha256AtBuild: actual,
      matchesWorkingTree: actual !== null && recorded.length === 1 && recorded[0] === actual,
      consumedBy: e.consumedBy.sort(),
    }
  })

const inconsistent = inputs.filter((x) => !x.consistentAcrossArtifacts)
const mismatched = inputs.filter((x) => !x.matchesWorkingTree)

const manifest = {
  schemaVersion: 2,
  contractMigration: migrationFor('source-input-manifest.v2'),
  generatedBy: 'npm run release:evidence',
  generatedAt: ARTIFACT_DATE,
  generatedFromCommit: git(['rev-parse', 'HEAD']),
  purpose:
    'release asset の provenance.inputFiles[].sha256 を、tag source の実ファイルと独立に検算するための一覧。'
    + '**この manifest 自身は証明ではない。**GitHub の tag source archive を取得して、'
    + 'ここに並ぶ path の sha256 を自分で計算し、突き合わせること。',
  inputFilesTotal: inputs.length,
  inconsistentAcrossArtifacts: inconsistent.length,
  mismatchedWithWorkingTreeAtBuild: mismatched.length,
  /**
   * **この一覧が「全部」なのかを受け手が確かめるための範囲（v0.3.0 フォローアップ P1-2）。**
   *
   * 件数と sha256 だけ渡しても、受け手は**記録漏れを見つけられない。**
   * 落ちている入力があっても、残った分は全部一致するからである。
   * 範囲を一緒に渡せば、受け手は自分の source を歩いて「載っていない入力」を自分で探せる。
   *
   * `notCovered` は **digest が覆えないもの**。「一致した」を「全部同じだった」と読ませない。
   */
  inputScope: {
    file: INPUT_SCOPE_FILE,
    sha256: sha256File(INPUT_SCOPE_FILE),
    recursiveDirectories: inputScope.recursiveDirectories,
    requiredExactFiles: inputScope.requiredExactFiles,
    allowedGeneratedInputs: inputScope.allowedGeneratedInputs,
    excludedOutputs: inputScope.excludedOutputs,
    notCovered: inputScope.notCovered,
    verifyCommand:
      `node scripts/verifyReleaseSourceInputs.mjs --manifest source-input-manifest.json --source <dir> --scope ${INPUT_SCOPE_FILE}`,
  },
  inputFiles: inputs,
  verificationRecipe: [
    'gh release download <tag>  # asset を取る',
    'git archive --format=tar <tag> | tar -x -C <dir>  # tag source を取る',
    'cd <dir> && while read -r sha path; do echo "$sha  $path"; done < <(jq -r \'.inputFiles[] | "\\(.recordedSha256) \\(.path)"\' source-input-manifest.json) | shasum -a 256 -c -',
  ],
  note:
    '**mismatchedWithWorkingTreeAtBuild が 0 でない場合、その artifact は現在の入力から作り直されていない。**'
    + 'release を作る前に該当の生成コマンドを回すこと（npm run check:stale が判定する）。',
}

writeFileSync(resolve(ROOT, 'artifacts/source-input-manifest.json'), JSON.stringify(manifest, null, 1) + '\n')

/**
 * **写しは manifest の直後に作る。**
 * 写しは manifest の入力一覧を読み、index は写しの sha256 を読むので、
 * この順でないと片方が必ず古いものを見る（実測で ENOENT になった）。
 */
buildSourceSnapshot(ROOT)

// ---------------------------------------------------------------------------
// 2. 検証を実際に回した記録（v0.3.0 フォローアップ P1-3）
//
// **これは自己申告である。**作った側が作った側を検証した記録でしかない。
// それでも配る理由は、**判定の境界を受け手に見せるため**——
// 「取れなかった」「合わなかった」「そもそも探していない」が別物であることは、
// 実際の出力を 1 つ見るのがいちばん早い。
//
// 突き合わせ先は**作業ツリー**であって tag の source ではない。
// tag はこの時点でまだ存在しない（evidence をコミットしてから打つ）ので、
// 原理的にここでは検証できない。受け手が同梱の script を tag に対して回すこと。
// ---------------------------------------------------------------------------

const VERIFIER = 'scripts/verifyReleaseSourceInputs.mjs'
let verifyOut
try {
  verifyOut = JSON.parse(execFileSync('node', [
    VERIFIER,
    '--manifest', 'artifacts/source-input-manifest.json',
    '--source', '.',
    '--scope', INPUT_SCOPE_FILE,
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }))
} catch (e) {
  // **落ちても JSON は出る。**status を握りつぶさずそのまま記録する
  verifyOut = JSON.parse(String(e.stdout ?? '{}'))
  if (!verifyOut.status) {
    console.log(`\n  **${VERIFIER} が JSON を出さずに失敗した。**`)
    console.log(`    ${String(e.message).split('\n')[0]}`)
    process.exit(1)
  }
}

/**
 * **終了コードは道具から引く（v0.6.12）。**
 * ここに手書きしていた 5 件は、道具が 8 種類返すようになったあとも 5 件のままだった。
 */
const EXIT_OF = CLI_STATUS_EXIT

/**
 * **道具が出した status を、この自己申告 artifact が表現できるか。**（外部監査 2026-08-06 P0-D）
 *
 * `verifyReleaseSourceInputs.mjs` は v5 から `ARCHIVE_INVALID` を出すが、
 * 同梱している `source-verification-result.v1.schema.json` の enum には入っていない
 * （**入れると言語が広がって v2 になり、下流が止まる**ので v0.6.x では入れていない
 * → `docs/SCHEMA_VERSIONING_POLICY.md`・判定は `schemaLanguageDiff.mjs` で実測済み）。
 *
 * **表現できない status を、近い値へ丸めて出すことは絶対にしない。**
 * 丸めると「archive が壊れていた」が「取れなかった」に化けて、受け手が読み分けられなくなる。
 * ここで止めて、**版を上げるかどうかを人が決める。**
 *
 * **v0.6.12: 判定は `selfReportStatus.mjs` へ切り出し、schema の enum を正本にした。**
 * ここに手で並べていた 5 値は、試験がソースの正規表現で拾って比べていた——
 * **書き方を変えれば拾えなくなる検査**だった。関門は投げる関数にしたので、試験が実際に踏める。
 */
try {
  assertExpressibleInSelfReport(verifyOut.status, ROOT)
} catch (e) {
  console.error(`\n  ✗ ${e.message}\n    理由: ${verifyOut.reason ?? '(なし)'}\n`)
  process.exit(1)
}
const iv = verifyOut.independentVerification ?? {}
const sourceVerification = {
  schemaVersion: 1,
  schemaId: 'trs-jack-3d-source-verification-result.v1',
  isSelfReport: true,
  replacesRecipientVerification: false,
  note:
    '**これは自己申告である。**こちらのリポジトリで verify:release-source-inputs を回した結果でしかなく、'
    + '受け手の独立検証を置き換えない。**突き合わせ先は生成時の作業ツリーであって tag の source ではない。**'
    + 'tag は evidence をコミットした後に打つので、この時点では存在しない。'
    + '受け手は同梱の verifyReleaseSourceInputs.mjs を tag に対して回すこと（howToVerifyYourself を参照）。',
  tool: { script: VERIFIER, toolVersion: verifyOut.toolVersion ?? null, sha256: sha256File(VERIFIER) },
  sourceOrigin: verifyOut.origin ?? 'unknown',
  generatedFromCommit: git(['rev-parse', 'HEAD']),
  /** **null が正しい。**artifact は自分を含む commit の hash を持てない（索引の releaseCommit と同じ理由） */
  releaseCommit: null,
  generatedAt: ARTIFACT_DATE,
  status: verifyOut.status,
  exitCode: EXIT_OF[verifyOut.status] ?? 2,
  unrecordedInputDetection: {
    performed: verifyOut.unrecordedInputDetection?.performed ?? false,
    scopeSource: verifyOut.unrecordedInputDetection?.scopeSource ?? null,
  },
  counts: {
    checked: iv.checked ?? 0,
    matched: iv.matched ?? 0,
    mismatched: iv.mismatched ?? 0,
    missingInSource: iv.missingInSource ?? 0,
    unrecordedInputCandidates: iv.unrecordedInputCandidates ?? 0,
    selfReferencingInputs: iv.selfReferencingInputs ?? 0,
  },
  howToVerifyYourself: [
    '# bundle に同梱してある script をそのまま使う（通信しない）',
    'node verifyReleaseSourceInputs.mjs --manifest source-input-manifest.json --source <展開した source> --scope source-input-scope.v1.json',
    '# 手元に tag があるなら（これも通信しない）',
    'node verifyReleaseSourceInputs.mjs --manifest source-input-manifest.json --tag <tag> --scope source-input-scope.v1.json',
    '# 明示したときだけ GitHub から source を取る',
    'node verifyReleaseSourceInputs.mjs --manifest source-input-manifest.json --tag <tag> --fetch github --scope source-input-scope.v1.json',
    /**
     * **道具の一覧から作る（v0.6.12）。**手で並べていたときは 5 種類のまま止まり、
     * `VERIFICATION_INCOMPLETE`（v0.6.11 の目玉）を受け手に伝えないまま出荷した。
     * **配布物に載る列挙は、権威から生成する。**
     */
    `# status は ${CLI_STATUSES.map((s) => `${s}(${CLI_STATUS_EXIT[s]})`).join(' / ')}。`,
    `# 終了コード ${INTERNAL_FAILURE_EXIT} は **この道具の欠陥** で、検証の結果ではありません（JSON を出さずに止まります）。`,
    '# **取れなかった(2) と 合わなかった(1) を同じ失敗に潰さないこと。**',
    '# **unrecordedInputDetection.performed が false なら「候補 0 件」ではなく「探していない」。**',
  ],
}
writeFileSync(resolve(ROOT, SOURCE_VERIFICATION_PATH), JSON.stringify(sourceVerification, null, 1) + '\n')

// ---------------------------------------------------------------------------
// 4. 検証結果 — 上の 2 つを含めて回す
// ---------------------------------------------------------------------------

const shippedPaths = new Set(RELEASE_ASSETS.map((a) => a.path))
const sourceOnly = new Set(SOURCE_ONLY_TARGETS.map((t) => t.path))
const results = validateAll()
const failed = results.filter((r) => r.missing || r.schemaErrors.length || r.semanticErrors.length)

/**
 * **schema 検証と「配ってよいか」を別の名前で出す（v0.4.1・P0-2）。**
 *
 * v0.4.0 では `validation-results.json` が 11/11 PASS でありながら、
 * `test_counts.json` は `allPassed: false` だった。**両者を突き合わせていなかった。**
 * artifact の形が正しいことと、release として出してよいことは別の判定である。
 */
const tcPath = 'artifacts/test_counts.json'
const tc = existsSync(resolve(ROOT, tcPath)) ? read(tcPath) : null
const readinessReasons = []
if (failed.length) readinessReasons.push(`validate:profiles が ${failed.length} 件不適合`)
if (!tc) readinessReasons.push(`${tcPath} が無い`)
else {
  if (tc.allPassed !== true) readinessReasons.push(`${tcPath} の allPassed が ${JSON.stringify(tc.allPassed)}`)
  if (tc.failed !== undefined && tc.failed !== 0) readinessReasons.push(`${tcPath} の failed が ${tc.failed}`)
  if (tc.exitCode !== undefined && tc.exitCode !== 0) readinessReasons.push(`${tcPath} の exitCode が ${tc.exitCode}`)
  readinessReasons.push(...staleTestEvidenceReasons(tc))
}

/**
 * **テスト証拠が古くなっていないか（v0.6.16・外部監査 2026-08-14 P0-1）。**
 *
 * v0.6.15 は **v0.6.14 の証拠（1236 件・commit `1c79e059`）で `READY` を名乗って
 * 公開された。**この関数が無かったので、`allPassed: true` だけを見て通していた。
 *
 * **ここでテストを回し直さない。**この工程は `test_counts.json` が指す成果物を
 * これから書くところなので、いま測ると「まだ書いていない索引と食い違う」失敗を
 * 数えてしまい、二度と `READY` にできなくなる。
 * **実測での突き合わせは配布の門（`release:stage`）が行う。**
 *
 * ここが見るのは**由来**だけである——「その証拠を取ってから、テストの結果を
 * 変えうるファイルが動いていないか」。v0.6.15 では `test/` が 4 コミットぶん
 * 動いていたので、これだけで止められた。
 */
function staleTestEvidenceReasons(tc) {
  const at = tc.generatedFromCommit
  if (!at || at === 'UNKNOWN') return [`${tcPath} が生成時の commit を記録していない`]
  /** その commit が履歴にあるか。無ければ比べようがない */
  try {
    execFileSync('git', ['cat-file', '-e', `${at}^{commit}`], { cwd: ROOT, stdio: 'ignore' })
  } catch {
    return [`${tcPath} の generatedFromCommit (${at.slice(0, 12)}) が履歴に無い`]
  }
  /** **テストの結果を変えうる範囲**。artifact と文書はここに入れない（循環するため） */
  const WATCHED = ['test/', 'src/', 'scripts/', 'schemas/', 'package.json', 'package-lock.json', 'vitest.config.ts']
  let changed
  try {
    changed = execFileSync('git', ['diff', '--name-only', `${at}..HEAD`, '--', ...WATCHED], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean)
  } catch {
    return [`${tcPath} の generatedFromCommit (${at.slice(0, 12)}) と HEAD を比べられない`]
  }
  /** **コミットしていない変更も同じ穴。**証拠を取ったあとに手元で触っていれば、証拠は古い */
  let dirty = []
  try {
    dirty = execFileSync('git', ['status', '--porcelain', '--', ...WATCHED], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean).map((l) => l.slice(3))
  } catch { /* git が無い環境では諦める（上の cat-file で既に落ちている） */ }

  const reasons = []
  if (changed.length) {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
    reasons.push(
      `${tcPath} を取ってから、テストに効くファイルが ${changed.length} 件動いている`
      + `（${at.slice(0, 12)}..${head.slice(0, 12)}: ${changed.slice(0, 3).join(', ')}`
      + `${changed.length > 3 ? ` ほか ${changed.length - 3} 件` : ''}）。npm run test:count を取り直すこと`,
    )
  }
  if (dirty.length) {
    reasons.push(
      `テストに効くファイルに未コミットの変更が ${dirty.length} 件ある`
      + `（${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ` ほか ${dirty.length - 3} 件` : ''}）。`
      + `${tcPath} はその前の実行なので取り直すこと`,
    )
  }
  return reasons
}

const validation = {
  schemaVersion: 2,
  contractMigration: migrationFor('validation-results.v2'),
  generatedBy: 'npm run release:evidence',
  generatedAt: ARTIFACT_DATE,
  generatedFromCommit: git(['rev-parse', 'HEAD']),
  command: 'npm run validate:profiles',
  targetsTotal: results.length,
  targetsPassed: results.length - failed.length,
  allPassed: failed.length === 0,
  /** artifact の**形と意味**が正しいか。テストの成否とは別 */
  artifactValidationStatus: failed.length === 0 ? 'PASS' : 'FAIL',
  /**
   * **release として配ってよいか。**形の検証に加えて、テストが通っていることまで見る。
   * `npm run release:stage` がこれを門にする。
   */
  releaseReadinessStatus: readinessReasons.length === 0 ? 'READY' : 'NOT_READY',
  releaseReadinessReasons: readinessReasons,
  /**
   * **どの証拠を根拠にしたかを、値ごと名指しする（v0.6.16・外部監査 P0-1）。**
   * v0.6.15 まで件数しか写しておらず、**その件数がどの版のものかは記録に無かった。**
   * 受け手は「1236 件」を見ても、それが配布物と同じ版の実行かを確かめられなかった。
   */
  testEvidence: tc
    ? {
        total: tc.total,
        failed: tc.failed ?? null,
        skipped: tc.skipped,
        exitCode: tc.exitCode ?? null,
        allPassed: tc.allPassed,
        testCountsSha256: sha256File(tcPath),
        testCountsGeneratedFromCommit: tc.generatedFromCommit ?? null,
        testCountsGeneratedAt: tc.generatedAt ?? null,
      }
    : null,
  /** **配布する対象と、しない対象を分けて数える（v0.2.0 フォローアップ §3）。** */
  distributedTargets: results.filter((r) => shippedPaths.has(r.artifact)).length,
  sourceOnlyTargets: results.filter((r) => !shippedPaths.has(r.artifact)).length,
  results: results.map((r) => ({
    artifact: r.artifact,
    schema: r.schema,
    missing: r.missing,
    /** **bundle に入っているか。**受け手が「全対象を独立再検証できる」と読まないようにする */
    distribution: shippedPaths.has(r.artifact) ? 'RELEASE_ASSET' : 'SOURCE_ONLY',
    schemaErrorCount: r.schemaErrors.length,
    semanticErrorCount: r.semanticErrors.length,
    schemaErrors: r.schemaErrors,
    semanticErrors: r.semanticErrors,
  })),
  note:
    '**この結果は生成時点のこのリポジトリでの判定である。**受け手の環境で同じ判定になることは、'
    + '同梱の schema で自分で検証して確かめること。判定の実装は scripts/validateProfiles.mjs にある。'
    + '**distribution: SOURCE_ONLY の対象は bundle に入っていない**ので、受け手はそれを再検証できない。',
}
writeFileSync(resolve(ROOT, 'artifacts/validation-results.json'), JSON.stringify(validation, null, 1) + '\n')

// ---------------------------------------------------------------------------
// 4. release index — 下流が値を手で転記しないで済むようにする
//
// **validation-results.json より後に作る。**索引は全 asset の sha256 を持つので、
// 先に作ると「一つ前の validation-results」を指したまま固まる（2026-08-03 に実際に踏んだ）。
// ---------------------------------------------------------------------------

const readIf = (p) => (existsSync(resolve(ROOT, p)) ? read(p) : null)
const profileEntries = {}
for (const [variantFile, sensFile] of [
  ['artifacts/half_plug_topology_profile.v3.trs_jack_trs.json', 'artifacts/sensitivity.trs_jack_trs.json'],
  ['artifacts/half_plug_topology_profile.v3.trs_jack_trrs.json', 'artifacts/sensitivity.trs_jack_trrs.json'],
]) {
  const prof = readIf(variantFile)
  const sens = readIf(sensFile)
  if (!prof || !sens) continue
  profileEntries[prof.variantId] = {
    filename: variantFile.split('/').pop(),
    profileId: prof.profileId,
    inputDigest: prof.provenance.inputDigest,
    sha256: sha256File(variantFile),
    generatedFromCommit: prof.provenance.generatedFromCommit,
    sensitivityAsset: {
      filename: sensFile.split('/').pop(),
      sha256: sha256File(sensFile),
      inputDigest: sens.provenance.inputDigest,
      generatedFromCommit: sens.provenance.generatedFromCommit,
    },
  }
}

const INDEX_PATH = 'artifacts/trs-jack-3d-release-index.v1.json'
const assets = RELEASE_ASSETS
  .filter((a) => a.path !== INDEX_PATH) // **索引は自分を含めない**（自己参照になる）
  .map((a) => {
    const e = { filename: a.path.split('/').pop(), sha256: sha256File(a.path), role: a.role }
    const j = a.path.endsWith('.json') && a.path.startsWith('artifacts/') ? readIf(a.path) : null
    const gc = j?.provenance?.generatedFromCommit ?? j?.generatedFromCommit
    if (gc) e.generatedFromCommit = gc
    if (j?.provenance?.inputDigest) e.inputDigest = j.provenance.inputDigest
    if (j?.profileId) e.profileId = j.profileId
    return e
  })
  .sort((a, b) => a.filename.localeCompare(b.filename))

/**
 * **生成 commit は 1 つではない。**release 工程が 2 段階なので、
 * profile と 感度・頑健性 は別の commit で作られる。
 * 単一の `artifactGenerationCommit` だけを見ると、片方が必ず食い違う。
 */
const byCommit = new Map()
for (const a of assets) {
  if (!a.generatedFromCommit) continue
  byCommit.set(a.generatedFromCommit, [...(byCommit.get(a.generatedFromCommit) ?? []), a.filename])
}
const someProfile = Object.values(profileEntries)[0]

const index = {
  schemaVersion: 1,
  generatedBy: 'npm run release:evidence',
  generatedAt: ARTIFACT_DATE,
  /**
   * **tag はこの時点では存在しない。**evidence を作り、それをコミットし、そのうえで tag を打つ。
   * 分からないものを埋めない。release 時に RELEASE_TAG / RELEASE_COMMIT で渡す。
   */
  releaseTag: process.env.RELEASE_TAG ?? null,
  releaseCommit: process.env.RELEASE_COMMIT ?? null,
  evidenceBuiltAtCommit: git(['rev-parse', 'HEAD']),
  artifactGenerationCommit: someProfile?.generatedFromCommit ?? git(['rev-parse', 'HEAD']),
  artifactGenerationCommits: [...byCommit.entries()]
    .map(([commit, list]) => ({ commit, assets: list.sort() }))
    .sort((a, b) => a.commit.localeCompare(b.commit)),
  profileSchemaVersion: someProfile ? readIf('artifacts/half_plug_topology_profile.v3.trs_jack_trs.json').schemaVersion : 2,
  profileSchemaId: someProfile ? readIf('artifacts/half_plug_topology_profile.v3.trs_jack_trs.json').schemaId : null,
  profiles: profileEntries,
  assets,
  notes: [
    '**この索引は release 工程の記録であって、証明ではない。**bytes の検算は SHA256SUMS で行うこと。',
    '**`releaseTag` / `releaseCommit` が null なら、まだ tag を打っていない。**'
      + 'evidence をコミットしてから tag を打つ順序なので、生成時点では知りようがない。'
      + '配布物には RELEASE_TAG / RELEASE_COMMIT を渡して作り直したものを入れること（release:stage が null を拒む）。',
    '**`releaseCommit` と `artifactGenerationCommit` は違う。**tag は artifact をコミットした後に打つので、'
      + 'artifact 自身は必ずそれより前の commit から作られる。一致を要求しないこと。',
    '**生成 commit は 1 つではない**（`artifactGenerationCommits` を見ること）。'
      + 'release 工程が 2 段階で、profile の入力に感度 artifact が含まれるため、先に感度を確定させる必要がある。',
    '**この索引自身の sha256 はここに無い**（自己参照になる）。SHA256SUMS が持っている。',
  ],
}
writeFileSync(resolve(ROOT, INDEX_PATH), JSON.stringify(index, null, 1) + '\n')

// --- 自分で書いた 2 つは、書いた直後に schema で検証する -----------------------
// 検証対象に入れられない（自己参照になる）ので、ここで見る。**黙って通さない。**
const ajv = new Ajv({ allErrors: true, strict: false })
let selfBad = 0
for (const [artifactPath, schemaPath] of [
  ['artifacts/validation-results.json', 'schemas/validation-results.v2.schema.json'],
  [INDEX_PATH, 'schemas/trs-jack-3d-release-index.v1.schema.json'],
  // 検証を回した記録も同じ扱い。**validateAll の対象に入れると、その回の自分自身を見ることになる**
  [SOURCE_VERIFICATION_PATH, 'schemas/source-verification-result.v1.schema.json'],
]) {
  const v = ajv.compile(read(schemaPath))
  if (!v(read(artifactPath))) {
    selfBad++
    console.log(`\n  **${artifactPath} が ${schemaPath} に適合しない**`)
    for (const e of (v.errors ?? []).slice(0, 8)) console.log(`    ${e.instancePath || '(root)'}: ${e.keyword} — ${e.message}`)
  }
}

// ---------------------------------------------------------------------------

console.log(`\n  validation-results.json     ${validation.targetsPassed}/${validation.targetsTotal} 適合`
  + ` (配布 ${validation.distributedTargets} / 非配布 ${validation.sourceOnlyTargets})`)
console.log(`  source-input-manifest.json  入力 ${inputs.length} 件`)
console.log(`  source-verification-result  ${sourceVerification.status}`
  + ` (検算 ${sourceVerification.counts.checked} 件 / 記録漏れ探索 ${sourceVerification.unrecordedInputDetection.performed ? '実行' : '**未実行**'})`
  + ' — **自己申告**')
console.log(`  release-index               asset ${assets.length} 件 / 生成 commit ${index.artifactGenerationCommits.length} 種`)
console.log(`  artifactValidation          ${validation.artifactValidationStatus}`)
console.log(`  releaseReadiness            ${validation.releaseReadinessStatus}`)
if (inconsistent.length) console.log(`  **artifact 間で sha256 が食い違う入力が ${inconsistent.length} 件**`)
if (mismatched.length) console.log(`  **作業ツリーと一致しない入力が ${mismatched.length} 件** (作り直しが要る)`)
if (!validation.allPassed) {
  console.log('\n**検証が通っていない。release evidence としては使えない。**')
  process.exit(1)
}
if (inconsistent.length || mismatched.length) process.exit(1)
if (selfBad) {
  console.log('\n**自分で書いた evidence が schema に適合しない。**')
  process.exit(1)
}
/**
 * **ここで止めない（v0.4.1・P0-2）。**
 *
 * テストが落ちていることを理由に evidence の生成を止めると、
 * 「件数の照合が落ちている間は件数を更新できない」という循環に戻る。
 * evidence には `releaseReadinessStatus: NOT_READY` と理由が入っているので、
 * **止めるのは配布側**（`npm run release:stage` が拒否する）。
 */
if (validation.releaseReadinessStatus !== 'READY') {
  console.log('\n**release として配れる状態ではない。**')
  for (const r of validation.releaseReadinessReasons) console.log(`  ${r}`)
  console.log('  evidence は書いた（判定を残すため）。**npm run release:stage が拒否する。**')
} else {
  console.log('  すべて整合している')
}
