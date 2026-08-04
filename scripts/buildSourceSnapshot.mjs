/**
 * 通信が無い受け手のための、入力・生成器・schema の写しを作る。
 *   npm run release:snapshot
 *
 * ## なぜ要るか（v0.4.1 フォローアップ オーダー §2）
 *
 * v0.4.1 の受け手はネットワークが無く、`--fetch github` も
 * release ページの "Source code (tar.gz)" も取れず `SOURCE_UNAVAILABLE` になった。
 * 判定としては正しい（取れなかったことを不一致に潰していない）が、
 * **完全にオフラインの受け手は独立検算に着手できない。**
 *
 * ## なぜ tag source archive をそのまま添付しないか
 *
 * 実測した。
 *
 *   入力 29 件だけ                     0.45 MB
 *   入力 + scripts/ + schemas/         0.92 MB  ← これ
 *   tag source archive まるごと        8.94 MB
 *
 * 8.94 MB の内訳を見ると、増えるぶんは **docs/screenshots/*.png（1 枚 0.6〜0.7 MB）と
 * artifacts/contact_sweep.json（1.3 MB）** で、どれも受け手の検証には使われない。
 *
 * ## なぜ tar.gz ではなく JSON か
 *
 * **tar.gz は同じ入力から作っても毎回ハッシュが変わる**（mtime が入る。実測で不一致）。
 * release asset は sha256 で固定するので、再現しない形式は使えない。
 * JSON なら決定的で、schema で検証でき、限界を artifact 自身に書ける。
 *
 * ## これで何が言えて、何が言えないか
 *
 * 言える  : 記録した hash が、記録した中身と合っているか（自己整合）
 * 言えない: その中身が本当に tag の source かどうか
 *
 * **producer が写しと manifest を同時に偽れば一致する。**循環しない検証には
 * GitHub の tag source archive を使うこと（`independentVerificationRecipe` に手順）。
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const OUT = 'artifacts/source-snapshot.v1.json'
const MANIFEST = 'artifacts/source-input-manifest.json'
const ARTIFACT_DATE = process.env.ARTIFACT_DATE ?? new Date().toISOString().slice(0, 10)

const git = (root, args) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return 'UNKNOWN'
  }
}

/** 写しに入れる範囲。**入力だけでなく生成器と schema も入れる**（hash が何を指すか辿れるように） */
const RECURSIVE_DIRS = ['scripts', 'schemas', 'src/data', 'src/model']
const BASE_EXACT_FILES = ['source-input-scope.v1.json', 'contract-migration.v1.json', 'package.json', 'package-lock.json']

/**
 * **範囲定義が「生成物だが入力でもある」と認めた 3 件を足す。**
 * profile は感度 artifact を実際に読むので、これが無いと受け手は inputDigest を再計算できない。
 * 一覧を直書きせず範囲定義から引く（生成側と同じ 1 か所）。
 */
const exactFiles = (root) => {
  const scopePath = resolve(root, 'source-input-scope.v1.json')
  const scope = JSON.parse(readFileSync(scopePath, 'utf8'))
  return [...BASE_EXACT_FILES, ...(scope.allowedGeneratedInputs ?? [])]
}

const walk = (ROOT, dir) => {
  const out = []
  for (const e of readdirSync(resolve(ROOT, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...walk(ROOT, p))
    else if (e.isFile()) out.push(p)
  }
  return out
}

/** 写しを作って書き出す。**問題があれば例外で落とす**（黙って空の写しを作らない） */
export function buildSourceSnapshot(ROOT = process.cwd()) {
// --- 入力の正本を読む。**無ければ止める**（何件入るはずかを言えないまま作らない） ---
if (!existsSync(resolve(ROOT, MANIFEST))) {
  throw new Error(`${MANIFEST} が無い。先に npm run release:evidence を回すこと`)
}
const manifest = JSON.parse(readFileSync(resolve(ROOT, MANIFEST), 'utf8'))
const recordedInputs = new Set((manifest.inputFiles ?? []).map((f) => f.path))
if (recordedInputs.size === 0) {
  throw new Error(`${MANIFEST} に入力が 1 件も無い。写しを作っても意味がない`)
}

const paths = [...new Set([...RECURSIVE_DIRS.flatMap((d) => walk(ROOT, d)), ...exactFiles(ROOT)])].sort()

const files = paths.map((p) => {
  const buf = readFileSync(resolve(ROOT, p))
  return {
    path: p,
    sha256: createHash('sha256').update(buf).digest('hex'),
    isRecordedInput: recordedInputs.has(p),
    bytes: buf.length,
    content: buf.toString('utf8'),
  }
})

// --- 記録された入力を取りこぼしていないか。**黙って欠けたら止める** ---
const missing = [...recordedInputs].filter((p) => !paths.includes(p))
if (missing.length > 0) {
  throw new Error(
    '記録された入力が写しに入っていない。受け手は inputDigest を再計算できない:\n'
      + missing.map((m) => `  ${m}`).join('\n')
      + '\n  scripts/buildSourceSnapshot.mjs の RECURSIVE_DIRS / BASE_EXACT_FILES を直すこと。',
  )
}

const snapshot = {
  schemaVersion: 1,
  schemaId: 'trs-jack-3d-source-snapshot.v1',
  generatedBy: 'npm run release:snapshot',
  generatedAt: ARTIFACT_DATE,
  generatedFromCommit: git(ROOT, ['rev-parse', 'HEAD']),

  isSelfConsistencyOnly: true,
  producerClaimOnly:
    '**これは producer の申告である。**こちらが渡したファイルを、こちらが記録した hash と'
    + '照合するだけなので、producer が写しと manifest を同時に偽れば一致する。'
    + '受け手の独立検証を置き換えない。',
  replacesRecipientVerification: false,
  isSourceOfTruthForInputDigest: false,
  inputDigestSourceOfTruth: 'artifacts/source-input-manifest.json',

  whatThisProves:
    '記録した sha256 が、記録した中身と合っていること（自己整合）。'
    + 'および、source-input-manifest.json の inputFiles[].recordedSha256 を'
    + '受け手の手元で計算し直して突き合わせられること。',
  whatThisDoesNotProve:
    'この中身が本当に該当 tag の source であること。**それはこの写しでは確かめられない。**'
    + '循環しない検証には GitHub の tag source archive を使うこと。',

  independentVerificationRecipe: [
    '# 通信がある受け手は、写しではなく tag source を使うこと（循環しない）',
    'curl -sL -o src.tar.gz https://github.com/Driedsandwich/trs-jack-3d/archive/refs/tags/<TAG>.tar.gz',
    'node verifyReleaseSourceInputs.mjs --manifest source-input-manifest.json \\',
    '  --source src.tar.gz --scope source-input-scope.v1.json',
    '# あるいは、この写しを使う場合（自己整合の確認まで）',
    'node -e "const s=require(\'./source-snapshot.v1.json\'),c=require(\'crypto\');'
      + 'let ng=0;for(const f of s.files){const h=c.createHash(\'sha256\').update(Buffer.from(f.content,\'utf8\')).digest(\'hex\');'
      + 'if(h!==f.sha256){ng++;console.log(\'MISMATCH\',f.path)}}'
      + 'console.log(s.files.length+\' 件中 \'+ng+\' 件が不一致\');process.exit(ng?1:0)"',
  ],

  excluded: [
    { what: 'docs/screenshots/*.png', why: '検証に使わない。tag source archive の 8.94 MB の大半がこれだった' },
    { what: 'artifacts/ 配下（この写し自身を含む）', why: '生成物であって入力ではない' },
    { what: 'src/ のうち src/data・src/model 以外（UI・描画）', why: 'artifact の生成に読み込まれない（source-input-scope.v1.json の notCovered と同じ範囲）' },
    { what: 'test/ 配下', why: '検証コードであって生成入力ではない' },
    { what: 'node_modules', why: 'package-lock.json で固定される。写しに入れる意味がない' },
  ],

  recordedInputsTotal: files.filter((f) => f.isRecordedInput).length,
  filesTotal: files.length,
  files,
}

writeFileSync(resolve(ROOT, OUT), `${JSON.stringify(snapshot, null, 1)}\n`)

const bytes = statSync(resolve(ROOT, OUT)).size
console.log(`${OUT} を書き出した`)
console.log(`  ファイル ${snapshot.filesTotal} 件 / うち記録済み入力 ${snapshot.recordedInputsTotal} 件`)
console.log(`  ${bytes.toLocaleString()} bytes = ${(bytes / 1048576).toFixed(2)} MB`)
console.log('  **自己整合の確認まで。**独立検証には tag source archive を使うこと')
return { path: OUT, bytes, filesTotal: snapshot.filesTotal, recordedInputsTotal: snapshot.recordedInputsTotal }
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('buildSourceSnapshot.mjs')
if (invokedDirectly) buildSourceSnapshot(process.cwd())
