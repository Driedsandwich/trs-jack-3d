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
 * 使う外部コマンドは `git archive` / `git rev-parse` の 2 つだけで、どちらも読み取り専用。
 * `--fetch github` は Node 組み込みの `fetch` を GET で使うので、**外部コマンドを増やさない**
 * （v0.4.0 では `gh` を呼んでおり、受け手の環境に無くて使えなかった）。
 * `test/verifyReleaseSourceInputs.test.ts` が書き込み API を使っていないことを機械で固定している。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * 道具の版。**判定の意味を変えたら上げる。**
 *
 *   1 … 初版 (v0.2.0 フォローアップ §5)
 *   2 … 範囲定義 (source-input-scope.v1.json) から未記録入力を探すようにした。
 *       範囲定義が無い場合に既定へ戻さず performed:false を出す (v0.3.0 フォローアップ P1-2)
 *   3 … --fetch github を gh から Node の fetch へ替えた（外部コマンド依存を無くした）。
 *       toolVersion を全出口へ入れた。どちらも v0.4.0 で受け手が実際に困った点 (v0.4.1)
 *   4 … --source が tar.gz も受けるようにした (v0.5.0)
 *   5 … **信頼できない archive に対して安全にした (v0.6.0 P1)。**
 *       header checksum の検算・PAX を拾わない・.. と絶対パスを拒む・
 *       symlink と hardlink をファイルとして扱わない・資源上限。
 *       あわせて ARCHIVE_INVALID を SOURCE_UNAVAILABLE から分離した。
 *       **判定の意味が変わる**（v0.5.2 までなら読めていた archive が止まる）ので版を上げる
 *   6 … **外部監査 2026-08-06 の 3 件（こちらで再現してから直した）。**
 *       同じパスの entry が 2 回あると後勝ちで黙って通っていた → ARCHIVE_INVALID。
 *       ディレクトリ入力の symlink ループで生スタックトレースを吐いて落ちていた → lstat + 構造化 status。
 *       圧縮された入力そのものに上限が無く、相手が送ってきた量が全部メモリに載っていた → maxCompressedBytes。
 *       **1 件目は判定が変わる**（v6 で止まる archive が v5 では通った）ので版を上げる
 */
export const TOOL_VERSION = 6

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

/**
 * 出力して終わる。**`toolVersion` はここで入れる。**
 *
 * v0.4.0 では成功・不一致の出口にしか書いておらず、
 * `SOURCE_UNAVAILABLE` / `MANIFEST_UNAVAILABLE` / `NOTHING_TO_VERIFY` の 3 経路には
 * 入っていなかった。**受け手が記録を保存しても、どの版の道具の出力か分からない。**
 * 実際、下流が保存した `SOURCE_UNAVAILABLE` の記録には版が無かった。
 *
 * 各出口へ手で足すと、出口が増えたときにまた忘れる。**通り道で入れる。**
 */
const done = (payload, code) => {
  console.log(JSON.stringify({ toolVersion: TOOL_VERSION, ...payload }, null, 1))
  process.exit(code)
}

// ---------------------------------------------------------------------------
// tar をメモリ上で読む（**展開しない**。展開はファイル書き込みになる）
// ---------------------------------------------------------------------------

/**
 * **信頼できない archive を読むための制限。**（v0.6.0 P1）
 *
 * 値は v0.5.2 の実物を測ってから決めた（2026-08-06 実測）。
 *
 * ```
 * GitHub tarball v0.5.2   gz 9.76 MB → tar 15.09 MB（1.5 倍）
 *                          entry 268（ファイル 246 / ディレクトリ 21 / pax global 1）
 *                          最大 entry 1.33 MB ／ 最長パス 95 文字
 * ```
 *
 * **実物の 6〜20 倍に置く。**きつくすると正常な tarball を弾き、
 * 緩くすると上限の意味が無くなる。**上限を超える入力を実際に作って、
 * 止まることを試験している**（`test/tarHardening.test.ts`）。
 */
export const TAR_LIMITS = {
  maxEntries: 5000,            // 実測 268 の約 19 倍
  maxEntryBytes: 8 << 20,      // 8 MB。実測の最大 1.33 MB の約 6 倍
  maxTotalBytes: 256 << 20,    // 256 MB。実測 15.09 MB の約 17 倍。gunzip の上限にも使う
  maxPathLength: 1024,         // 実測の最長 95 の約 10 倍
  fetchTimeoutMs: 60_000,      // 取得が返らないまま止まらないため
  /**
   * **圧縮された入力そのものの上限（v0.6.1）。**
   *
   * v0.6.0 は展開後にしか上限が無く、`readFileSync` / `arrayBuffer()` で
   * **入力を全部メモリへ載せてから**判定していた。
   * 実測（2026-08-06）: 120 MB の入力を渡すと最大 RSS 165 MB、1 MB のときは 45 MB。
   * **相手が送ってきた量がそのまま常駐する。**
   * 64 MB は実物の source tarball 9.76 MB の約 6.5 倍。
   */
  maxCompressedBytes: 64 << 20,
}

/** archive が壊れている／敵対的であることを表す。**取れなかった（SOURCE_UNAVAILABLE）とは別物** */
export class ArchiveInvalid extends Error {
  constructor(reason, detail = {}) {
    super(reason)
    this.name = 'ArchiveInvalid'
    this.detail = detail
  }
}

/** ヘッダの checksum を検算する。checksum 欄を空白 8 個で埋めた状態の総和 */
function headerChecksumOk(header) {
  const stored = /^[0-7]+/.exec(header.subarray(148, 156).toString('ascii'))
  if (!stored) return false
  let sum = 0
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]
  return parseInt(stored[0], 8) === sum
}

/**
 * **パスが archive の外へ出ないことを確かめる。**
 *
 * `..` を含む・絶対パス・Windows 風の区切りを拒む。
 * 展開はしないので直ちに書き込まれるわけではないが、
 * **この Map は受け手が manifest のパスで引く。**外を指す名前を入れた時点で、
 * 「source の中にあった」という主張が嘘になる。
 */
function assertSafePath(name) {
  if (name.length > TAR_LIMITS.maxPathLength) {
    throw new ArchiveInvalid(`entry のパスが長すぎる (${name.length} > ${TAR_LIMITS.maxPathLength})`, { name: name.slice(0, 80) })
  }
  if (name.startsWith('/')) throw new ArchiveInvalid('絶対パスの entry がある', { name })
  if (/^[A-Za-z]:/.test(name)) throw new ArchiveInvalid('ドライブレターつきの entry がある', { name })
  if (name.includes('\\')) throw new ArchiveInvalid('バックスラッシュを含む entry がある', { name })
  if (name.split('/').includes('..')) throw new ArchiveInvalid('.. を含む entry がある（archive の外を指す）', { name })
}

/**
 * USTAR を読む。**展開しない**（メモリ上の Map にするだけ）。
 *
 * v0.5.2 までは「512 バイトずつ読んで typeflag が `0` なら拾う」だけだった。
 * 外部監査の P1 で指摘されたとおり、**信頼できない archive に対して無防備**だった。
 * v0.6.0 で次を足した。**どれも実物の壊れた tar で試験している。**
 *
 * | 何 | 何をする |
 * |---|---|
 * | header checksum | 合わなければ `ArchiveInvalid` |
 * | PAX (`x` / `g`) | **中身をファイルとして拾わない。**上書き指示にも従わない |
 * | GNU long name (`L`) | 受けるが、長さ上限を超えたら止める |
 * | `..` / 絶対パス / `\` | `ArchiveInvalid` |
 * | symlink (`2`) / hardlink (`1`) | **ファイルとして扱わない**（読み飛ばす） |
 * | ディレクトリ (`5`) など | 読み飛ばす |
 * | entry 数・サイズ・総量 | 上限を超えたら止める |
 *
 * **PAX の上書き指示に従わないのは意図的である。**`path=` を honor すると、
 * checksum を通った名前とは別の名前で登録できてしまう。
 * 実物の GitHub tarball は `pax_global_header` を 1 個持つだけで、
 * ファイル名の上書きには使っていない（実測）。
 */
function readTar(buf) {
  const files = new Map()
  let off = 0
  let longName = null
  let entries = 0
  let total = 0

  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break

    if (++entries > TAR_LIMITS.maxEntries) {
      throw new ArchiveInvalid(`entry が多すぎる (> ${TAR_LIMITS.maxEntries})`, { entries })
    }
    if (!headerChecksumOk(header)) {
      throw new ArchiveInvalid('ヘッダの checksum が合わない', { entryIndex: entries, offset: off })
    }

    const str = (a, l) => header.subarray(a, a + l).toString('utf8').replace(/\0.*$/, '').trim()
    const sizeField = str(124, 12)
    if (sizeField && !/^[0-7]+$/.test(sizeField)) {
      throw new ArchiveInvalid('size 欄が 8 進数ではない', { entryIndex: entries, sizeField })
    }
    const size = parseInt(sizeField || '0', 8) || 0
    if (size < 0 || !Number.isSafeInteger(size)) {
      throw new ArchiveInvalid('size 欄が扱える範囲を超えている', { entryIndex: entries, sizeField })
    }
    if (size > TAR_LIMITS.maxEntryBytes) {
      throw new ArchiveInvalid(`entry が大きすぎる (${size} > ${TAR_LIMITS.maxEntryBytes})`, { entryIndex: entries, name: str(0, 100) })
    }
    total += size
    if (total > TAR_LIMITS.maxTotalBytes) {
      throw new ArchiveInvalid(`展開後の総量が大きすぎる (> ${TAR_LIMITS.maxTotalBytes})`, { total })
    }

    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    const dataStart = off + 512
    if (dataStart + size > buf.length) {
      throw new ArchiveInvalid('entry のデータが archive の末尾を超えている', { entryIndex: entries, size })
    }
    const data = buf.subarray(dataStart, dataStart + size)
    off = dataStart + Math.ceil(size / 512) * 512

    // **PAX は拾わない。**上書き指示にも従わない（従うと checksum を通った名前と別名になりうる）
    if (type === 'x' || type === 'g') { longName = null; continue }

    if (type === 'L') {
      const decoded = data.toString('utf8').replace(/\0.*$/, '')
      assertSafePath(decoded)
      longName = decoded
      continue
    }

    const name = longName ?? (str(345, 155) ? `${str(345, 155)}/${str(0, 100)}` : str(0, 100))
    longName = null

    // **リンクはファイルとして扱わない。**中身が無いのに「source にあった」ことになる
    if (type === '1' || type === '2') continue
    if (type !== '0') continue

    if (!name) continue
    assertSafePath(name)
    /**
     * **同じパスが 2 回出てきたら止める（v0.6.1・外部監査 P1-A）。**
     *
     * v0.6.0 は `Map` へ入れるだけだったので**後の entry が黙って勝った**（実測: `dup.txt` が `SECOND` になる）。
     * 受け手は manifest のパスでこの Map を引くので、
     * **checksum を通った最初の中身とは別の中身を「source にあった」と読むことになる。**
     * 中身が同一でも拒む——同じ内容を 2 回入れる正当な理由が無く、
     * 「同一なら許す」にすると比較のぶんだけ判断が増える。
     */
    if (files.has(name)) {
      throw new ArchiveInvalid('同じパスの entry が 2 回ある（どちらが本物か決められない）', { name, entryIndex: entries })
    }
    files.set(name, data)
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

/** gunzip。**展開後のサイズに上限を置く**（zip bomb で落ちないため） */
function gunzipLimited(buf) {
  try {
    return gunzipSync(buf, { maxOutputLength: TAR_LIMITS.maxTotalBytes })
  } catch (e) {
    throw new ArchiveInvalid(`gzip を展開できない: ${String(e.message).split('\n')[0]}`)
  }
}

/**
 * **受け取りながら上限を効かせる（v0.6.1）。**
 *
 * `res.arrayBuffer()` は全部読み終えてから返すので、
 * **上限を超えていることが分かるのは、超えた量を受け取り終えた後**になる。
 * ここは chunk を数えながら読み、超えた時点で body を捨てる。
 *
 * @param res  fetch の Response
 * @param limit 受け取ってよい最大バイト数
 */
export async function readBodyLimited(res, limit) {
  if (!res.body) return Buffer.from(await res.arrayBuffer())
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel()
        throw new ArchiveInvalid(
          `受け取った本文が大きすぎる (> ${limit} バイト)`,
          { receivedBytes: total, limit },
        )
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock?.()
  }
  return Buffer.concat(chunks, total)
}

/**
 * archive を読む共通の入口。**例外を「壊れている」と「取れない」に分けて返す。**
 * 受け手が保存した記録から、どちらだったかを後で読めるようにするため。
 */
export function readArchiveBuffer(buf, { gzip }) {
  try {
    return { files: stripTopLevel(readTar(gzip ? gunzipLimited(buf) : buf)) }
  } catch (e) {
    if (e instanceof ArchiveInvalid) return { error: e.message, kind: 'ARCHIVE_INVALID', detail: e.detail }
    return { error: `archive を読めない: ${String(e.message).split('\n')[0]}`, kind: 'ARCHIVE_INVALID' }
  }
}

// ---------------------------------------------------------------------------
// source の取得（3 経路。どれを使ったかを必ず出力に残す）
// ---------------------------------------------------------------------------

/**
 * **`--source` は tar.gz も受ける（v0.5.0）。**
 *
 * v0.4.1 までは展開済みディレクトリしか受けなかったが、
 * release notes と snapshot の手順書は `--source src.tar.gz` と書いていた。
 * **書いてある手順が動かない**状態だったので、受けられるようにした。
 * GitHub の tarball と同じく、単一の親ディレクトリは剥がす。
 */
function loadFromArchive(path) {
  const abs = resolve(ROOT, path)
  if (!existsSync(abs)) return { error: `source archive が無い: ${path}`, kind: 'SOURCE_UNAVAILABLE' }
  let buf
  try {
    /**
     * **読む前に大きさを見る（v0.6.1・外部監査 P1-C）。**
     * `readFileSync` してから判定すると、判定するころには全部メモリに載っている。
     */
    const size = statSync(abs).size
    if (size > TAR_LIMITS.maxCompressedBytes) {
      return {
        error: `source archive が大きすぎる (${size} > ${TAR_LIMITS.maxCompressedBytes} バイト)`,
        kind: 'ARCHIVE_INVALID',
        detail: { path, size, limit: TAR_LIMITS.maxCompressedBytes },
      }
    }
    buf = readFileSync(abs)
  } catch (e) {
    return { error: `source archive を読めない (${path}): ${e.message}`, kind: 'SOURCE_UNAVAILABLE' }
  }
  const r = readArchiveBuffer(buf, { gzip: /\.(tgz|tar\.gz)$/i.test(path) })
  return r.error ? r : { files: r.files, origin: `archive:${path}` }
}

function loadFromDir(dir) {
  const abs = resolve(ROOT, dir)
  if (!existsSync(abs)) return { error: `source ディレクトリが無い: ${dir}`, kind: 'SOURCE_UNAVAILABLE' }
  // ファイルを渡されたら archive として読む（**ENOTDIR で落とさない**）
  let rootStat
  try {
    rootStat = lstatSync(abs)
  } catch (e) {
    return { error: `source を読めない (${dir}): ${String(e.message).split('\n')[0]}`, kind: 'SOURCE_UNAVAILABLE' }
  }
  if (rootStat.isSymbolicLink()) {
    return { error: `source がシンボリックリンクである: ${dir}`, kind: 'ARCHIVE_INVALID', detail: { path: dir } }
  }
  if (!rootStat.isDirectory()) return loadFromArchive(dir)
  const files = new Map()
  const skippedLinks = []
  /**
   * **`lstatSync` で見る（v0.6.1・外部監査 P1-B）。**
   *
   * v0.6.0 は `statSync` でリンクを追っていたので、`loop -> .` を 1 本置くだけで
   * **`ELOOP` の生スタックトレースを吐いて exit 1**——構造化 JSON が 1 行も出なかった（実測）。
   * 受け手は「合わなかった」と「道具が落ちた」を出力から区別できない。
   *
   * リンクは**追わずに読み飛ばす**。archive 側（typeflag `1`/`2`）と同じ扱いで、
   * **中身が無いのに「source にあった」ことにしない**ためでもある。
   */
  const walk = (rel) => {
    for (const n of readdirSync(join(abs, rel) || abs).sort()) {
      const r = rel ? `${rel}/${n}` : n
      if (n === 'node_modules' || n === '.git') continue
      const st = lstatSync(join(abs, r))
      if (st.isSymbolicLink()) { skippedLinks.push(r); continue }
      if (st.isDirectory()) walk(r)
      else if (st.isFile()) files.set(r, readFileSync(join(abs, r)))
    }
  }
  try {
    walk('')
  } catch (e) {
    // **fs のエラーを構造化 status へ変える。**生の例外で落とすと出力が JSON でなくなる
    return {
      error: `source ディレクトリを走査できない (${dir}): ${String(e.message).split('\n')[0]}`,
      kind: 'SOURCE_UNAVAILABLE',
      detail: { code: e?.code ?? null, path: e?.path ?? null },
    }
  }
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
  return {
    files: stripped,
    origin: `directory:${dir}${stripped === files ? '' : ' (先頭の 1 階層を剥がした)'}`
      + (skippedLinks.length ? ` (symlink ${skippedLinks.length} 件を読み飛ばした)` : ''),
  }
}

function loadFromLocalTag(tag) {
  try {
    execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}`], { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] })
  } catch {
    return { error: `tag ${tag} が手元に無い（fetch していないか、存在しない）`, kind: 'SOURCE_UNAVAILABLE' }
  }
  let tar
  try {
    tar = execFileSync('git', ['archive', '--format=tar', tag], { cwd: ROOT, maxBuffer: 1 << 30 })
  } catch (e) {
    return { error: `git archive に失敗: ${e.message}`, kind: 'SOURCE_UNAVAILABLE' }
  }
  const r = readArchiveBuffer(tar, { gzip: false })
  return r.error ? r : { files: r.files, origin: `git-archive:${tag}` }
}

/**
 * GitHub から tag の source を取る。**外部コマンドを使わない（v0.4.1）。**
 *
 * v0.4.0 では `gh api` を呼んでいた。下流の環境に `gh` が無く、
 * `spawnSync gh ENOENT` で `SOURCE_UNAVAILABLE` になった。
 * 判定としては正しい（取れなかったことを不一致に潰していない）が、
 * **検証ツールを配った意味が半分になる。**受け手に道具の前提を増やしてはいけない。
 *
 * Node 18 以降は `fetch` が組み込みなので、これで足りる。
 * GET しかしないので read-only の性質も変わらない。
 */
async function loadFromGithub(tag) {
  const url = `https://api.github.com/repos/${REPO}/tarball/${tag}`
  let res
  try {
    // **timeout を置く（v0.6.0 P1）。**返らない相手に当たると、道具が止まったまま戻らない
    res = await fetch(url, {
      headers: { 'user-agent': 'trs-jack-3d-verify', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(TAR_LIMITS.fetchTimeoutMs),
    })
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError'
    return {
      error: timedOut
        ? `GitHub からの応答が ${TAR_LIMITS.fetchTimeoutMs} ms 以内に来なかった (${url})`
        : `GitHub へ接続できなかった (${url}): ${String(e.message).split('\n')[0]}`,
      kind: 'SOURCE_UNAVAILABLE',
    }
  }
  if (!res.ok) return { error: `GitHub が ${res.status} ${res.statusText} を返した (${url})`, kind: 'SOURCE_UNAVAILABLE' }
  /**
   * **Content-Length は補助にしか使わない。**相手が付けてこないことも、嘘をつくこともある。
   * 付いていて上限を超えていれば、そこで body を読まずに終える。
   */
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > TAR_LIMITS.maxCompressedBytes) {
    return {
      error: `GitHub が申告した本文が大きすぎる (${declared} > ${TAR_LIMITS.maxCompressedBytes} バイト)`,
      kind: 'ARCHIVE_INVALID',
      detail: { declaredBytes: declared, limit: TAR_LIMITS.maxCompressedBytes },
    }
  }
  let gz
  try {
    /**
     * **`arrayBuffer()` を使わない（v0.6.1・外部監査 P1-C）。**
     * あれは相手が送ってきた量をそのまま全部メモリへ載せてから返す。
     * 上限に届いた時点で受け取りをやめる。
     */
    gz = await readBodyLimited(res, TAR_LIMITS.maxCompressedBytes)
  } catch (e) {
    if (e instanceof ArchiveInvalid) return { error: e.message, kind: 'ARCHIVE_INVALID', detail: e.detail }
    return { error: `本文を受け取れなかった: ${String(e.message).split('\n')[0]}`, kind: 'SOURCE_UNAVAILABLE' }
  }
  const r = readArchiveBuffer(gz, { gzip: true })
  return r.error ? r : { files: r.files, origin: `github-tarball:${REPO}@${tag}` }
}

// ---------------------------------------------------------------------------

/**
 * **import されたときは実行しない（v0.6.0）。**
 * `test/tarHardening.test.ts` が parser を直接呼ぶため。
 * 以前は import した時点で main が走り、`process.exit(2)` でテストごと落ちていた。
 */
const RUN_AS_CLI = typeof process.argv[1] === 'string' && /verifyReleaseSourceInputs\.mjs$/.test(process.argv[1])

if (RUN_AS_CLI) {
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

  const loaded = await (SOURCE_DIR
    ? loadFromDir(SOURCE_DIR)
    : FETCH === 'github' && TAG
      ? loadFromGithub(TAG)
      : TAG
        ? loadFromLocalTag(TAG)
        : { error: '--source か --tag のどちらかが要る' })

  if (loaded.error) {
    /**
     * **3 つを潰さない（v0.6.0 P1）。**
     *   SOURCE_UNAVAILABLE … 取れなかった（無い・繋がらない・timeout）。検証していない
     *   ARCHIVE_INVALID    … 取れたが archive が壊れているか敵対的。**中身を信用しない**
     *   MISMATCH           … 読めたが記録と合わない（下の突き合わせで出る）
     * v0.5.2 までは前 2 つが同じ SOURCE_UNAVAILABLE だった。
     * **受け手が記録を保存しても、通信の問題なのか改竄なのか読み分けられない。**
     */
    const kind = loaded.kind === 'ARCHIVE_INVALID' ? 'ARCHIVE_INVALID' : 'SOURCE_UNAVAILABLE'
    done({
      status: kind,
      reason: loaded.error,
      detail: loaded.detail ?? null,
      manifest: MANIFEST,
      tag: TAG,
      fetch: FETCH,
      note: kind === 'ARCHIVE_INVALID'
        ? '**これは不一致ではない。**archive そのものが壊れているか、安全に読めない形だったので、'
          + '中身を見ていない。渡した source を疑うこと。'
        : '**これは不一致ではない。**source を取れなかったので、検証していない。'
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
}
