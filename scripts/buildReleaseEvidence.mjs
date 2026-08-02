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
import { validateAll } from './validateProfiles.mjs'
import { RELEASE_ASSETS } from './releaseAssets.mjs'

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

// ---------------------------------------------------------------------------
// 1. 検証結果
// ---------------------------------------------------------------------------

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
  results: results.map((r) => ({
    artifact: r.artifact,
    schema: r.schema,
    missing: r.missing,
    schemaErrorCount: r.schemaErrors.length,
    semanticErrorCount: r.semanticErrors.length,
    // **件数だけでなく本文も出す。**0 件なら空配列で、切り捨てはしない
    schemaErrors: r.schemaErrors,
    semanticErrors: r.semanticErrors,
  })),
  note:
    '**この結果は生成時点のこのリポジトリでの判定である。**受け手の環境で同じ判定になることは、'
    + '同梱の schema で自分で検証して確かめること。判定の実装は scripts/validateProfiles.mjs にある。',
}

writeFileSync(resolve(ROOT, 'artifacts/validation-results.json'), JSON.stringify(validation, null, 1) + '\n')

// ---------------------------------------------------------------------------
// 2. 入力ファイルの一覧（tag source と突き合わせるためのもの）
// ---------------------------------------------------------------------------

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

console.log(`\n  validation-results.json   ${validation.targetsPassed}/${validation.targetsTotal} 適合`)
console.log(`  source-input-manifest.json  入力 ${inputs.length} 件`)
if (inconsistent.length) console.log(`  **artifact 間で sha256 が食い違う入力が ${inconsistent.length} 件**`)
if (mismatched.length) console.log(`  **作業ツリーと一致しない入力が ${mismatched.length} 件** (作り直しが要る)`)
if (!validation.allPassed) {
  console.log('\n**検証が通っていない。release evidence としては使えない。**')
  process.exit(1)
}
if (inconsistent.length || mismatched.length) process.exit(1)
console.log('  すべて整合している')
