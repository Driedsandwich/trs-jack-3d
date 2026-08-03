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

const ROOT = process.cwd()
const read = (p) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))
const sha256File = (p) => createHash('sha256').update(readFileSync(resolve(ROOT, p))).digest('hex')
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
  schemaVersion: 1,
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

// ---------------------------------------------------------------------------
// 4. 検証結果 — 上の 2 つを含めて回す
// ---------------------------------------------------------------------------

const shippedPaths = new Set(RELEASE_ASSETS.map((a) => a.path))
const sourceOnly = new Set(SOURCE_ONLY_TARGETS.map((t) => t.path))
const results = validateAll()
const failed = results.filter((r) => r.missing || r.schemaErrors.length || r.semanticErrors.length)

const validation = {
  schemaVersion: 1,
  generatedBy: 'npm run release:evidence',
  generatedAt: ARTIFACT_DATE,
  generatedFromCommit: git(['rev-parse', 'HEAD']),
  command: 'npm run validate:profiles',
  targetsTotal: results.length,
  targetsPassed: results.length - failed.length,
  allPassed: failed.length === 0,
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
  ['artifacts/half_plug_topology_profile.v2.trs_jack_trs.json', 'artifacts/sensitivity.trs_jack_trs.json'],
  ['artifacts/half_plug_topology_profile.v2.trs_jack_trrs.json', 'artifacts/sensitivity.trs_jack_trrs.json'],
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
  profileSchemaVersion: someProfile ? readIf('artifacts/half_plug_topology_profile.v2.trs_jack_trs.json').schemaVersion : 2,
  profileSchemaId: someProfile ? readIf('artifacts/half_plug_topology_profile.v2.trs_jack_trs.json').schemaId : null,
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
  ['artifacts/validation-results.json', 'schemas/validation-results.v1.schema.json'],
  [INDEX_PATH, 'schemas/trs-jack-3d-release-index.v1.schema.json'],
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
console.log(`  release-index               asset ${assets.length} 件 / 生成 commit ${index.artifactGenerationCommits.length} 種`)
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
console.log('  すべて整合している')
