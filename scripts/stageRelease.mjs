/**
 * release asset を 1 か所へ集め、`SHA256SUMS` を作る。
 *   npm run release:stage -- --version v0.2.0
 *   npm run release:stage -- --version v0.2.0 --allow-local   (下見用)
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
const VERSION = argOf('version', 'v0.2.0')
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

// --- 集める -----------------------------------------------------------------
mkdirSync(OUT, { recursive: true })
const rows = []
for (const a of RELEASE_ASSETS) {
  const src = resolve(ROOT, a.path)
  const dst = resolve(OUT, basename(a.path))
  copyFileSync(src, dst)
  rows.push({ name: basename(a.path), sha256: sha256(src), role: a.role })
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
  '# **この版は schemaVersion 2 です。v1 とは非互換です。**',
  '# 対応表は profile の contractMigration にあります。',
  '# v1 を期待する実装は schemaVersion を見て停止してください（沈黙より停止のほうが安全です）。',
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
