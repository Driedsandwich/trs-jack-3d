/**
 * release asset を 1 か所へ集め、`SHA256SUMS` を作る。
 *   npm run release:stage -- --version v0.3.0
 *   npm run release:stage -- --version v0.3.0 --allow-local   (下見用)
 *
 * ## 何を防ぐか（非阻害フォローアップ P2-7）
 *
 * v0.1.1 では asset をその場で選んで並べ、**`event-sensitivity` schema を入れ忘れた。**
 * 一覧を `scripts/releaseAssets.mjs` に固め、ここはそれを機械的に写すだけにする。
 *
 * ## `local` な artifact は既定で拒む
 *
 * `artifactKind: 'local'` は「手元で作った」で、作業ツリーが汚れていても作れる。
 * それを release として配ると、受け手は再現できない。
 * 本番は clean checkout から `--release` 付きで作り直したものだけを使う。
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { RELEASE_ASSETS, REMOVED_SINCE_V011 } from './releaseAssets.mjs'

const ROOT = process.cwd()
const argv = process.argv.slice(2)
const argOf = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
/**
 * 既定の版数は **package.json から引く**（v0.4.0 で直書きをやめた）。
 *
 * 直書きにしていたので、採番のたびにここを手で直す必要があり、
 * **v0.4.0 へ上げたときに実際に忘れた**（テストが落ちて気づいた）。
 * 忘れうるものは持たせない。
 */
const VERSION = argOf('version', `v${JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version}`)
const ALLOW_LOCAL = argv.includes('--allow-local')
const OUT = resolve(ROOT, argOf('out', `dist/release/${VERSION}`))

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const read = (p) => JSON.parse(readFileSync(p, 'utf8'))
const git = (a) => {
  try {
    return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'UNKNOWN'
  }
}

// --- 揃っているか -----------------------------------------------------------
const missing = RELEASE_ASSETS.filter((a) => !existsSync(resolve(ROOT, a.path)))
if (missing.length) {
  console.log('**次の asset が存在しない。**')
  for (const m of missing) console.log(`  ${m.path}`)
  process.exit(1)
}

// **同名になる asset があると、片方が黙って上書きされる**
const names = RELEASE_ASSETS.map((a) => basename(a.path))
const dup = names.filter((n, i) => names.indexOf(n) !== i)
if (dup.length) {
  console.log(`**配布名が重複している: ${[...new Set(dup)].join(', ')}**`)
  process.exit(1)
}

/**
 * --- テストが通っていない artifact を配らせない（v0.4.1・P0-1/P0-2）-----------
 *
 * **v0.4.0 で実際にやってしまった。**テストが 2 件落ちている時点で `test:count` を回し、
 * 直したあと取り直さなかった。件数は変わらなかったので `total` の突き合わせは通り、
 * `allPassed: false` のまま公開した。
 *
 * **生成は止めない。**止めると「件数の照合が落ちている間は件数を更新できない」という
 * 循環に戻る（`scripts/testCount.mjs` の冒頭に経緯がある）。
 * 循環が起きるのは*生成*側で、*配布*側で止めればどちらの問題も起きない。
 * だからここで拒む。
 *
 * `--allow-not-ready` は形だけ確かめたいときの逃げ道で、**配ってはいけない。**
 */
const ALLOW_NOT_READY = argv.includes('--allow-not-ready')
const TEST_COUNTS = 'artifacts/test_counts.json'
if (existsSync(resolve(ROOT, TEST_COUNTS))) {
  const tc = read(resolve(ROOT, TEST_COUNTS))
  const reasons = []
  if (tc.allPassed !== true) reasons.push(`allPassed が ${JSON.stringify(tc.allPassed)}`)
  if (tc.failed !== undefined && tc.failed !== 0) reasons.push(`failed が ${tc.failed}`)
  if (tc.exitCode !== undefined && tc.exitCode !== 0) reasons.push(`exitCode が ${tc.exitCode}`)
  if (reasons.length) {
    console.log(`**${TEST_COUNTS} がテストの成功を示していない: ${reasons.join(' / ')}**`)
    console.log('  この artifact を配ると、受け手は「テストが落ちたまま出した」と読む。')
    console.log('  テストを直してから npm run test:count を**取り直す**こと。')
    console.log('  (件数が同じでも取り直しは要る。v0.4.0 はここを飛ばして allPassed: false を公開した)')
    console.log('  形だけ確かめたい場合は --allow-not-ready を付ける（**配ってはいけない**）。')
    if (!ALLOW_NOT_READY) process.exit(1)
    console.log('  --allow-not-ready が付いているので続行する。')
  }
} else {
  console.log(`**${TEST_COUNTS} が無い。**npm run test:count を回すこと。`)
  if (!ALLOW_NOT_READY) process.exit(1)
}

/**
 * **その証拠が「いまのもの」か（v0.6.16・外部監査 2026-08-14 P0-1）。**
 *
 * v0.6.15 は **v0.6.14 のテスト証拠（1236 件・commit 1c79e059）で `READY` を名乗って
 * 公開された。**上の検査は `allPassed` しか見ておらず、
 * `check:vacuity` は下限としてしか見ず、`check:doc-numbers` は
 * **古い文書と古い artifact が一致するので通した。**
 *
 * **一致は現在性の証拠にならない。**ここで実際に測り直して突き合わせる。
 */
{
  const { checkTestEvidenceCurrent } = await import('./checkTestEvidenceCurrent.mjs')
  console.log('\n  テスト証拠がいまのものか、実際に測り直して確かめる…')
  const { problems, live, recorded } = checkTestEvidenceCurrent(ROOT)
  if (problems.length) {
    console.log(`**${TEST_COUNTS} が実測と違う（配ろうとしている証拠が古い）。**`)
    console.log(`  実測 ${live?.total ?? '-'} 件 / 記録 ${recorded?.total ?? '-'} 件`
      + `（記録は ${recorded?.generatedAt ?? '-'} ／ ${String(recorded?.generatedFromCommit ?? '-').slice(0, 12)}）`)
    for (const p of problems.slice(0, 10)) console.log(`  ${p}`)
    if (problems.length > 10) console.log(`  … ほか ${problems.length - 10} 件`)
    console.log('  npm run test:count を回し直してから、もう一度 release:evidence を回すこと。')
    if (!ALLOW_NOT_READY) process.exit(1)
    console.log('  --allow-not-ready が付いているので続行する。')
  } else {
    console.log(`  実測 ${live.total} 件 / ${Object.keys(live.byFile).length} ファイル — 記録と全欄一致\n`)
  }
}

/**
 * release evidence 側の判定とも突き合わせる。
 * **evidence が「配布可」と言っていないものを配らない。**
 */
const VALIDATION = 'artifacts/validation-results.json'
if (existsSync(resolve(ROOT, VALIDATION))) {
  const vr = read(resolve(ROOT, VALIDATION))
  if (vr.releaseReadinessStatus !== undefined && vr.releaseReadinessStatus !== 'READY') {
    console.log(`**${VALIDATION} の releaseReadinessStatus が ${vr.releaseReadinessStatus} である。**`)
    for (const r of vr.releaseReadinessReasons ?? []) console.log(`  ${r}`)
    console.log('  npm run release:evidence を回し直すこと。')
    if (!ALLOW_NOT_READY) process.exit(1)
    console.log('  --allow-not-ready が付いているので続行する。')
  }
}

// --- local な artifact を拒む ------------------------------------------------
const localOnes = RELEASE_ASSETS.filter((a) => {
  if (!a.path.startsWith('artifacts/')) return false
  try {
    return read(resolve(ROOT, a.path)).provenance?.artifactKind === 'local'
  } catch {
    return false
  }
})
if (localOnes.length && !ALLOW_LOCAL) {
  console.log(`**artifactKind: 'local' の artifact が ${localOnes.length} 件ある。**`)
  for (const a of localOnes) console.log(`  ${a.path}`)
  console.log('\n  clean checkout から --release 付きで作り直すこと。')
  console.log('  形だけ確かめたい場合は --allow-local を付ける（配布してはいけない）。')
  process.exit(1)
}

/**
 * --- 索引の tag 情報は**ここで埋める** ------------------------------------------
 *
 * **artifact は、自分を含む commit の hash を持てない。**
 * 索引をコミットしてから tag を打つので、生成時点では tag も commit も存在しない。
 * リポジトリに置く索引は `null` のままが正しい（分からないものを埋めない）。
 *
 * 配布物では受け手が「どの tag のものか」を引けたほうがよいので、
 * **staged copy にだけ** `--commit` の値を書き込む。リポジトリ側は触らない。
 */
const INDEX_REL = 'artifacts/trs-jack-3d-release-index.v1.json'
const COMMIT = argOf('commit', null)
let stagedIndex = null
if (existsSync(resolve(ROOT, INDEX_REL))) {
  const idx = read(resolve(ROOT, INDEX_REL))
  const tag = idx.releaseTag ?? VERSION
  const commit = idx.releaseCommit ?? COMMIT
  if (!commit) {
    console.log('**tag が指す commit が分からない。**')
    console.log('  索引の releaseCommit は null のままで正しい（自分を含む commit の hash は持てない）。')
    console.log(`  配布時に渡すこと: npm run release:stage -- --version ${VERSION} --commit $(git rev-parse HEAD)`)
    process.exit(1)
  }
  if (tag !== VERSION) {
    console.log(`**release index の tag (${tag}) が --version (${VERSION}) と違う。**`)
    process.exit(1)
  }
  stagedIndex = { ...idx, releaseTag: tag, releaseCommit: commit }
}

// --- 集める -----------------------------------------------------------------
mkdirSync(OUT, { recursive: true })
const rows = []
for (const a of RELEASE_ASSETS) {
  const src = resolve(ROOT, a.path)
  const dst = resolve(OUT, basename(a.path))
  if (a.path === INDEX_REL && stagedIndex) {
    // **配布する索引にだけ tag を書き込む。**リポジトリ側は null のまま
    writeFileSync(dst, JSON.stringify(stagedIndex, null, 1) + '\n')
  } else {
    copyFileSync(src, dst)
  }
  rows.push({ name: basename(a.path), sha256: sha256(dst), role: a.role })
}

// --- SHA256SUMS --------------------------------------------------------------
const profiles = RELEASE_ASSETS.filter((a) => a.path.includes('half_plug_topology_profile'))
  .map((a) => read(resolve(ROOT, a.path)))

const header = [
  `# trs-jack-3d ${VERSION} — release asset の sha256`,
  '#',
  '# **固定には inputDigest を使ってください。**',
  '# ファイル単位の sha256 は「この配布物が改変されていないか」を見るためのものです。',
  '#',
  /**
   * **版は artifact から引く。**直書きしていたら v0.4.1 まで「schemaVersion 2」のまま残り、
   * v0.5.0 で 3 になっても気づけなかった（README が v0.1.1〜v0.4.0 で古い版を案内し続けたのと同じ型）。
   */
  `# **この版の profile は schemaVersion ${profiles[0]?.schemaVersion ?? '不明'} です。`
    + `v${(profiles[0]?.schemaVersion ?? 1) - 1} とは非互換です。**`,
  '# 対応表は profile の contractMigration.history と、同梱の contract-migration.v1.json にあります。',
  '# 旧版を期待する実装は schemaVersion を見て停止してください（沈黙より停止のほうが安全です）。',
  '#',
  ...profiles.map((p) => `# ${p.variantId.padEnd(14)} inputDigest = ${p.provenance.inputDigest}\n#                profileId   = ${p.profileId}`),
  '#',
  `# generatedFromCommit = ${profiles[0]?.provenance?.generatedFromCommit ?? git(['rev-parse', 'HEAD'])}`,
  `# artifactKind        = ${profiles[0]?.provenance?.artifactKind ?? '不明'}`,
  '#',
  '# v0.1.1 から外したもの（消えた理由）:',
  ...REMOVED_SINCE_V011.map((r) => `#   ${r.name ?? r.path} — ${r.reason}`),
  '#',
  '# 検算: shasum -a 256 -c SHA256SUMS',
  '',
].join('\n')

writeFileSync(
  resolve(OUT, 'SHA256SUMS'),
  header + rows.map((r) => `${r.sha256}  ${r.name}`).sort().join('\n') + '\n',
)

console.log(`\n  ${VERSION} の asset を ${rows.length} 件そろえた`)
for (const [role, n] of Object.entries(rows.reduce((m, r) => ({ ...m, [r.role]: (m[r.role] ?? 0) + 1 }), {})))
  console.log(`    ${role.padEnd(12)} ${n} 件`)
console.log(`  ${OUT}`)
if (ALLOW_LOCAL && localOnes.length) console.log('\n  **--allow-local で作った。配布してはいけない。**')
