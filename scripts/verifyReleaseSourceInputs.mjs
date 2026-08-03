/**
 * `source-input-manifest.json` の記録を、**tag の source と突き合わせて独立に検算する。**
 *
 *   npm run verify:release-source-inputs -- --manifest <file> --source <dir>
 *   npm run verify:release-source-inputs -- --manifest <file> --tag v0.2.0
 *   npm run verify:release-source-inputs -- --manifest <file> --tag v0.2.0 --fetch github
 *
 * ## 何のためか（v0.2.0 フォローアップ §5）
 *
 * release evidence は「こちらでは通っている」という**自己申告**である。
 * 受け手がそれを信じずに確かめるには、tag の source を自分で取って
 * `inputFiles[].sha256` を計算し直すしかない。その手順を機械にする。
 *
 * **自己申告と独立検証を混ぜない。**出力は両方を別項目に持つ。
 *
 * ## network は既定で使わない
 *
 * オーダーの要件は「network access なし」である。既定は
 * `--source <dir>`（受け手が展開済みの source）か
 * `--tag <tag>`（手元の git object から `git archive`）で、**どちらも通信しない。**
 * `--fetch github` を明示したときだけ取りに行く。
 *
 * ## 取れなかったのか、合わなかったのか
 *
 * **この 2 つを同じ「失敗」に潰さない。**
 * source が手に入らないのは検証していないだけで、不一致とは意味が違う。
 *
 *   OK                    … 全件一致                     (exit 0)
 *   MISMATCH              … 不一致か欠落がある            (exit 1)
 *   SOURCE_UNAVAILABLE    … source を取れなかった         (exit 2)
 *   MANIFEST_UNAVAILABLE  … manifest を読めなかった       (exit 2)
 *   NOTHING_TO_VERIFY     … 入力が 0 件で何も見ていない   (exit 2)
 *
 * ## read-only
 *
 * **ファイルへの書き込みを一切しない。**tar は展開せずメモリ上で読む。
 * 使う外部コマンドは `git archive` / `git rev-parse` / `gh api` だけで、いずれも読み取り専用。
 * `test/verifyReleaseSourceInputs.test.ts` が書き込み API を使っていないことを機械で固定している。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * 道具の版。**判定の意味を変えたら上げる。**
 *
 *   1 … 初版 (v0.2.0 フォローアップ §5)
 *   2 … 範囲定義 (source-input-scope.v1.json) から未記録入力を探すようにした。
 *       範囲定義が無い場合に既定へ戻さず performed:false を出す (v0.3.0 フォローアップ P1-2)
 */
export const TOOL_VERSION = 2

const ROOT = process.cwd()
const argv = process.argv.slice(2)
const argOf = (n, d = null) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const MANIFEST = argOf('manifest', 'artifacts/source-input-manifest.json')
const SOURCE_DIR = argOf('source')
const TAG = argOf('tag')
const FETCH = argOf('fetch', 'none')
const REPO = argOf('repo', 'Driedsandwich/trs-jack-3d')
/**
 * 入力の範囲定義。**既定では検証対象の source から読む**（その tag で有効だった範囲を使う）。
 * 範囲定義が入る前の tag (v0.3.0 以前) を検証するときだけ `--scope <file>` で外から渡す。
 */
const SCOPE_FILE = 'source-input-scope.v1.json'
const SCOPE_OVERRIDE = argOf('scope')

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const done = (payload, code) => {
  console.log(JSON.stringify(payload, null, 1))
  process.exit(code)
}

// ---------------------------------------------------------------------------
// tar をメモリ上で読む（**展開しない**。展開はファイル書き込みになる）
// ---------------------------------------------------------------------------

/**
 * USTAR の最小実装。512 バイトのヘッダとデータブロックが並ぶだけの形式である。
 * 長いパスの GNU 拡張 (`L` typeflag) にも対応する — src/model の階層で普通に出る。
 */
function readTar(buf) {
  const files = new Map()
  let off = 0
  let longName = null
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break
    const str = (s, l) => header.subarray(s, s + l).toString('utf8').replace(/\0.*$/, '').trim()
    const name = longName ?? (str(345, 155) ? `${str(345, 155)}/${str(0, 100)}` : str(0, 100))
    const size = parseInt(str(124, 12) || '0', 8) || 0
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    const dataStart = off + 512
    const data = buf.subarray(dataStart, dataStart + size)
    off = dataStart + Math.ceil(size / 512) * 512
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/, '')
      continue
    }
    longName = null
    if (type === '0') files.set(name, data)
  }
  return files
}

/** GitHub の tarball は `<repo>-<sha>/` を頭に付ける。剥がす */
function stripTopLevel(files) {
  const names = [...files.keys()]
  if (!names.length) return files
  const first = names[0].split('/')[0]
  if (!names.every((n) => n.startsWith(`${first}/`))) return files
  return new Map(names.map((n) => [n.slice(first.length + 1), files.get(n)]))
}

// ---------------------------------------------------------------------------
// source の取得（3 経路。どれを使ったかを必ず出力に残す）
// ---------------------------------------------------------------------------

function loadFromDir(dir) {
  const abs = resolve(ROOT, dir)
  if (!existsSync(abs)) return { error: `source ディレクトリが無い: ${dir}` }
  const files = new Map()
  const walk = (rel) => {
    for (const n of readdirSync(join(abs, rel) || abs).sort()) {
      const r = rel ? `${rel}/${n}` : n
      if (n === 'node_modules' || n === '.git') continue
      if (statSync(join(abs, r)).isDirectory()) walk(r)
      else files.set(r, readFileSync(join(abs, r)))
    }
  }
  walk('')
  /**
   * **展開した tarball を直接渡せるようにする（v0.3.0 フォローアップ P1-3）。**
   *
   * GitHub の release ページに付く "Source code (tar.gz)" を展開すると
   * `Driedsandwich-trs-jack-3d-<sha>/` という階層が 1 枚できる。
   * 受け手がそこを剥がし忘れると **29 件すべてが MISSING_IN_SOURCE になり、
   * 「壊れている」と読めてしまう。**単一の親しか無いときだけ剥がす
   * （リポジトリの root は複数の親を持つので、そちらは何も起きない）。
   */
  const stripped = stripTopLevel(files)
  return { files: stripped, origin: `directory:${dir}${stripped === files ? '' : ' (先頭の 1 階層を剥がした)'}` }
}

function loadFromLocalTag(tag) {
  try {
    execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}`], { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] })
  } catch {
    return { error: `tag ${tag} が手元に無い（fetch していないか、存在しない）` }
  }
  try {
    const tar = execFileSync('git', ['archive', '--format=tar', tag], { cwd: ROOT, maxBuffer: 1 << 30 })
    return { files: readTar(tar), origin: `git-archive:${tag}` }
  } catch (e) {
    return { error: `git archive に失敗: ${e.message}` }
  }
}

function loadFromGithub(tag) {
  try {
    const gz = execFileSync('gh', ['api', `repos/${REPO}/tarball/${tag}`], { cwd: ROOT, maxBuffer: 1 << 30 })
    return { files: stripTopLevel(readTar(gunzipSync(gz))), origin: `github-tarball:${REPO}@${tag}` }
  } catch (e) {
    return { error: `GitHub から取得できなかった: ${String(e.message).split('\n')[0]}` }
  }
}

// ---------------------------------------------------------------------------

const manifestAbs = resolve(ROOT, MANIFEST)
if (!existsSync(manifestAbs)) {
  done({ status: 'MANIFEST_UNAVAILABLE', manifest: MANIFEST, reason: 'manifest が無い' }, 2)
}
let manifest
try {
  manifest = JSON.parse(readFileSync(manifestAbs, 'utf8'))
} catch (e) {
  done({ status: 'MANIFEST_UNAVAILABLE', manifest: MANIFEST, reason: `manifest を読めない: ${e.message}` }, 2)
}

const loaded = SOURCE_DIR
  ? loadFromDir(SOURCE_DIR)
  : FETCH === 'github' && TAG
    ? loadFromGithub(TAG)
    : TAG
      ? loadFromLocalTag(TAG)
      : { error: '--source か --tag のどちらかが要る' }

if (loaded.error) {
  // **不一致ではない。**取れなかっただけで、検証は「していない」
  done({
    status: 'SOURCE_UNAVAILABLE',
    reason: loaded.error,
    manifest: MANIFEST,
    tag: TAG,
    fetch: FETCH,
    note: '**これは不一致ではない。**source を取れなかったので、検証していない。'
      + 'network を使わずに確かめるなら --source <展開済みディレクトリ> を渡すこと。',
  }, 2)
}

const src = loaded.files

// ---------------------------------------------------------------------------
// 突き合わせ
// ---------------------------------------------------------------------------

const results = []
for (const f of manifest.inputFiles ?? []) {
  const recorded = Array.isArray(f.recordedSha256) ? null : f.recordedSha256
  const data = src.get(f.path)
  if (data === undefined) {
    results.push({ path: f.path, outcome: 'MISSING_IN_SOURCE', recordedSha256: f.recordedSha256, actualSha256: null })
    continue
  }
  const actual = sha256(data)
  results.push({
    path: f.path,
    outcome: recorded === null
      ? 'RECORDED_INCONSISTENT'
      : actual === recorded ? 'MATCH' : 'MISMATCH',
    recordedSha256: f.recordedSha256,
    actualSha256: actual,
  })
}

// ---------------------------------------------------------------------------
// 記録漏れの検出（v0.3.0 フォローアップ P1-2）
// ---------------------------------------------------------------------------

/**
 * **範囲定義は生成側と共有する。**
 *
 * 2026-08-03 まで、ここには `['src/data','src/model']` が直書きされていた。
 * 生成側 (`provenance.ts`) が読む入力はもっと広かったので、
 * **manifest から `scripts/`・`schemas/`・`package-lock.json` を落としても素通りした**
 * （入力 28 件のうち検出できたのは 8 件だけ）。
 *
 * **見つからなければ既定値へ戻さない。**戻すと範囲が狭いまま黙って動く——塞いだはずの穴に戻る。
 */
function loadScope() {
  if (SCOPE_OVERRIDE) {
    try {
      return { scope: JSON.parse(readFileSync(resolve(ROOT, SCOPE_OVERRIDE), 'utf8')), origin: `override:${SCOPE_OVERRIDE}` }
    } catch (e) {
      return { error: `--scope ${SCOPE_OVERRIDE} を読めない: ${e.message}` }
    }
  }
  const buf = src.get(SCOPE_FILE)
  if (buf === undefined)
    return {
      error: `検証対象の source に ${SCOPE_FILE} が無い`
        + '（v0.3.0 以前の tag には入っていない）。--scope <file> で明示すれば検出できる。',
    }
  try {
    return { scope: JSON.parse(buf.toString('utf8')), origin: `source:${SCOPE_FILE}` }
  } catch (e) {
    return { error: `${SCOPE_FILE} を parse できない: ${e.message}` }
  }
}

const recordedPaths = new Set((manifest.inputFiles ?? []).map((f) => f.path))
const loadedScope = loadScope()
const scope = loadedScope.scope ?? null

/**
 * **記録されていない入力候補。**範囲定義の中にあるのに manifest へ載っていないファイルは、
 * digest が覆っていない。モデル・生成器・schema・lockfile のどれを足し忘れても出る。
 */
let extra = []
/** 出力にしてはいけないものを入力に記録している＝自己参照の事故 */
let selfReferencing = []
if (scope) {
  const inScope = new Set()
  for (const d of scope.recursiveDirectories ?? [])
    for (const p of src.keys()) if (p.startsWith(`${d}/`)) inScope.add(p)
  for (const p of [...(scope.requiredExactFiles ?? []), ...(scope.allowedGeneratedInputs ?? [])])
    if (src.has(p)) inScope.add(p)
  extra = [...inScope].filter((p) => !recordedPaths.has(p)).sort()

  const allowed = new Set(scope.allowedGeneratedInputs ?? [])
  selfReferencing = [...recordedPaths]
    .filter((p) => (scope.excludedOutputs ?? []).some((d) => p.startsWith(`${d}/`)) && !allowed.has(p))
    .sort()
}

/**
 * **0 件を検証して「OK」と言わない。**
 * manifest が空なら、この実行は何も確かめていない。通すほうが危ない。
 */
if (!results.length) {
  done({
    status: 'NOTHING_TO_VERIFY',
    origin: loaded.origin,
    manifest: MANIFEST,
    reason: 'manifest の inputFiles が 0 件。**この実行は何も検証していない。**',
  }, 2)
}

const counts = results.reduce((m, r) => ({ ...m, [r.outcome]: (m[r.outcome] ?? 0) + 1 }), {})
const bad = results.filter((r) => r.outcome !== 'MATCH')
const status = bad.length || extra.length || selfReferencing.length ? 'MISMATCH' : 'OK'

/**
 * **記録漏れの検出をやったのか、やらなかったのか。**
 *
 * 範囲定義が無いときに黙って「候補 0 件」と出すと、受け手には
 * 「探して見つからなかった」と読める。**探していないなら探していないと書く。**
 */
const detection = scope
  ? {
      performed: true,
      scopeSource: loadedScope.origin,
      scopeSchemaId: scope.schemaId,
      recursiveDirectories: scope.recursiveDirectories ?? [],
      requiredExactFiles: (scope.requiredExactFiles ?? []).length,
      allowedGeneratedInputs: (scope.allowedGeneratedInputs ?? []).length,
      excludedOutputs: scope.excludedOutputs ?? [],
    }
  : {
      performed: false,
      scopeSource: null,
      reason: loadedScope.error,
      note: '**記録漏れの検出はしていない。**既定の範囲へ戻すことは意図的にしていない——'
        + '狭い範囲のまま黙って通すのが、この範囲定義で塞いだ穴そのものだから。'
        + `sha256 の突き合わせ（${results.length} 件）は実施済みで、そちらの結果は有効である。`,
    }

done({
  status,
  toolVersion: TOOL_VERSION,
  origin: loaded.origin,
  networkUsed: loaded.origin.startsWith('github-tarball'),
  manifest: MANIFEST,
  tag: TAG,
  /** manifest 自身が名乗っている数（**自己申告**） */
  selfReported: {
    inputFilesTotal: manifest.inputFilesTotal,
    inconsistentAcrossArtifacts: manifest.inconsistentAcrossArtifacts,
    mismatchedWithWorkingTreeAtBuild: manifest.mismatchedWithWorkingTreeAtBuild,
    generatedFromCommit: manifest.generatedFromCommit,
  },
  /** ここで実際に計算し直した結果（**独立検証**） */
  independentVerification: {
    checked: results.length,
    matched: counts.MATCH ?? 0,
    mismatched: counts.MISMATCH ?? 0,
    missingInSource: counts.MISSING_IN_SOURCE ?? 0,
    recordedInconsistent: counts.RECORDED_INCONSISTENT ?? 0,
    unrecordedInputCandidates: extra.length,
    selfReferencingInputs: selfReferencing.length,
  },
  unrecordedInputDetection: detection,
  mismatches: bad,
  unrecordedInputCandidates: extra,
  /** 出力を入力として記録している＝artifact を作り直すたびに digest が変わる */
  selfReferencingInputs: selfReferencing,
  /** **digest が覆っていない範囲。**「一致した」を「全部同じだった」と読ませない */
  notCoveredByDigest: scope?.notCovered ?? null,
  notes: [
    '**自己申告 (selfReported) と独立検証 (independentVerification) を分けてある。**'
      + '前者は manifest がそう名乗っているだけで、後者がこの実行で計算し直した結果である。',
    'unrecordedInputCandidates は範囲定義 (source-input-scope.v1.json) の中にあるのに'
      + ' manifest へ載っていないファイル。**digest が覆っていない入力**を意味する。'
      + '**範囲は生成側 (provenance.ts) と共有している。**',
    'notCoveredByDigest は、範囲定義が「覆えない」と自己申告しているもの'
      + '（Node のバージョン・ロケール・環境変数など）。**一致は、これらが同じだったことを意味しない。**',
    'この検証はファイルを 1 つも書かない。tar は展開せずメモリ上で読んでいる。',
  ],
}, status === 'OK' ? 0 : 1)
