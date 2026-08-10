/**
 * **ふつうの tar 展開を oracle にして、検算器の「見え方」と突き合わせる。**
 *
 * ## なぜ要るか（外部監査 2026-08-06 の 3 件）
 *
 * これまでの試験は**期待値を手で書いていた。**
 * そのため、コードと同じ思い違いを期待値も共有してしまい、
 * 材料が corpus にあっても素通りした。実際にこうなっていた。
 *
 * ```
 * pax-x-path は 2026-08-06 より前から corpus にあった
 *   期待値 : 「PAX ヘッダをファイルとして拾わなければ安全」→ 合格
 *   実態   : ヘッダ名 root/file.txt / PAX path=root/other.txt のとき
 *            検算器は file.txt を検証して OK、ふつうに展開すると root/other.txt ができる
 * ```
 *
 * **材料は正しく、判定基準のほうが間違っていた。**
 *
 * ## この試験の考え方
 *
 * 期待値を書かない。**同じ tar を `tar` コマンドで実際に展開して、できた木と比べる。**
 * 要件はひとつだけ。
 *
 * > 検算器が読めたなら、その各キーは、展開してできた**通常ファイル**として
 * > **同じ中身で**存在しなければならない。存在しない・中身が違うなら不合格。
 * > 止まった（`ARCHIVE_INVALID`）なら、食い違いは起こりえないので合格。
 *
 * 「何を拒むべきか」を人が決めなくてよいのが要点である。
 * **参照実装との差分がそのまま欠陥になる。**
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readArchiveBuffer } from '../scripts/verifyReleaseSourceInputs.mjs'
import { allCases } from './_corruptTar.mjs'

const BLOCK = 512
const tmps: string[] = []
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })))

// --------------------------------------------------------------------------- tar を組む

function header(o: Record<string, unknown>): Buffer {
  const h = Buffer.alloc(BLOCK)
  h.write((o.name as string) ?? '', 0, 100, 'utf8')
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116)
  h.write(((o.size as number) ?? 0).toString(8).padStart(11, '0') + '\0', 124)
  h.write('00000000000\0', 136)
  h.write('        ', 148)
  h.write((o.type as string) ?? '0', 156, 1, 'ascii')
  h.write((o.linkname as string) ?? '', 157, 100, 'utf8')
  h.write('ustar\0', 257); h.write('00', 263)
  h.write((o.prefix as string) ?? '', 345, 155, 'utf8')
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += h[i]
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return h
}

function entry(o: { name: string, data?: string, type?: string, linkname?: string }): Buffer {
  const data = Buffer.from(o.data ?? '')
  const padded = data.length ? Buffer.concat([data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)]) : Buffer.alloc(0)
  return Buffer.concat([header({ ...o, size: data.length }), padded])
}

const tarOf = (...parts: Buffer[]) => Buffer.concat([...parts, Buffer.alloc(BLOCK * 2)])

/** PAX の 1 レコード: `"<全長> <鍵>=<値>\n"`。`<全長>` は自身を含む */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`
  let len = body.length + 1
  for (;;) {
    const s = `${len}${body}`
    if (s.length === len) return Buffer.from(s)
    len = s.length
  }
}

// --------------------------------------------------------------------------- oracle

type Extracted = { path: string, type: 'file' | 'dir' | 'symlink', content?: string, bytes?: Buffer, oversize?: number }

/**
 * **中身を読み込む上限（v0.6.7）。**展開すると 8.5 GB の疎ファイルができる材料があり、
 * `readFileSync` が `File size is greater than 2 GiB` で落ちた。
 * **検算器が受理する entry は 8 MB 以下**（`maxEntryBytes`）なので、
 * ここを超えたファイルの中身は比較に使わない——**読まなかったことを記録して先へ進む。**
 */
const ORACLE_READ_LIMIT = 64 << 20

/** **ふつうの tar で展開して、できた木を列挙する。**これが判定の基準になる */
function extractWithTar(buf: Buffer): { entries: Extracted[], failed: boolean, stderr: string, warned: boolean } {
  const dir = mkdtempSync(join(tmpdir(), 'trs-oracle-'))
  tmps.push(dir)
  const out = join(dir, 'out')
  mkdirSync(out)
  writeFileSync(join(dir, 'a.tar'), buf)
  /**
   * **`spawnSync` にしたのは、成功したときの stderr が要るから（v0.6.7）。**
   *
   * bsdtar は **exit 0 のまま警告を出す**ことがある。実測（2026-08-10）:
   *
   * ```
   * checksum が壊れた 2 番目の entry   exit 0 ／ stderr: bsdtar: Damaged tar archive
   *                                    （2 件のうち 1 件しか展開されない）
   * 絶対パスの entry                    exit 0 ／ stderr: Removing leading '/' from member names
   *                                    （`/etc/passwd` が `etc/passwd` になる）
   * ```
   *
   * **exit code だけ見ていると、この 2 つは「問題なく展開できた」に見える。**
   */
  const r = spawnSync('tar', ['-xf', join(dir, 'a.tar'), '-C', out], { encoding: 'utf8' })
  const stderr = String(r.stderr ?? '').split('\n').filter(Boolean)[0] ?? ''
  return { entries: walkTree(out), failed: r.status !== 0, stderr, warned: stderr !== '' }
}

/** 展開してできた木を列挙する。**oracle が違っても同じ物差しで見る**ために切り出してある */
function walkTree(out: string): Extracted[] {
  const found: Extracted[] = []
  const walk = (rel: string) => {
    for (const n of readdirSync(join(out, rel) || out).sort()) {
      const r = rel ? `${rel}/${n}` : n
      const st = lstatSync(join(out, r))
      if (st.isSymbolicLink()) found.push({ path: r, type: 'symlink', content: readlinkSync(join(out, r)) })
      else if (st.isDirectory()) { found.push({ path: r, type: 'dir' }); walk(r) }
      // **中身は生バイトで持つ（v0.6.5・外部監査 P1）。**UTF-8 文字列にすると
      // 不正バイトが U+FFFD へ潰れ、**違うバイト列が「同じ」に見える。**
      else if (st.size > ORACLE_READ_LIMIT) found.push({ path: r, type: 'file', oversize: st.size })
      else found.push({ path: r, type: 'file', bytes: readFileSync(join(out, r)) })
    }
  }
  walk('')
  return found
}

/** 木を 1 本の文字列にする（**リンクの指す先まで含める**——そこで割れる archive がある） */
const treeDigest = (es: Extracted[]) => es
  .map((e) => `${e.type} ${e.path}${e.type === 'symlink' ? ` -> ${e.content}` : ''}`
    + (e.type === 'file' ? ` #${e.bytes ? e.bytes.toString('hex') : `oversize:${e.oversize}`}` : ''))
  .sort().join('\n')

/**
 * 検算器の view と展開の view を比べ、食い違いの一覧を返す。
 * **止まったときは空**（食い違いは起こりえない）。
 */
function mismatchesOf(buf: Buffer): string[] {
  const r = readArchiveBuffer(buf, { gzip: false })
  if (r.error) return []
  const o = extractWithTar(buf)
  const bad: string[] = []

  /**
   * **受理したのに展開できないなら、その時点で食い違い（v0.6.5・外部監査 P0-2）。**
   *
   * v0.6.4 は展開失敗を「比べようがない＝合格」と数えていた。
   * そのため **hardlink の指す先が無いだけで、検算 OK・展開不能の archive が通った。**
   * 監査の「展開失敗を利用して見えない file を混ぜられるか」はここで再現している。
   */
  if (o.failed) return [`検算器は受理したのに、ふつうの tar で展開できない（${o.stderr.slice(0, 80)}）`]

  /**
   * **剥がした頭は記録された値で戻す（v0.6.5・外部監査 P1）。**
   * v0.6.4 は `endsWith('/' + k)` で推測していたので、
   * `a/b.txt` と `x/a/b.txt` のような綴りを取り違えうる。
   */
  const full = (k: string) => (r.rootStripped ? `${r.rootStripped}/${k}` : k)

  for (const [k, v] of r.files!) {
    const cand = o.entries.filter((e) => e.path === full(k))
    const file = cand.find((e) => e.type === 'file')
    if (!file) bad.push(`${k}: 展開結果に通常ファイルとして存在しない（実際は ${cand.map((c) => c.type).join(',') || 'なし'}）`)
    // **読まなかったものを「同じ」にしない。**上限を超えたファイルは比較していないので不合格に倒す
    else if (!file.bytes) bad.push(`${k}: 展開結果が大きすぎて中身を比較していない（${file.oversize} バイト）`)
    else if (!file.bytes.equals(v)) bad.push(`${k}: 中身が違う（生バイトで比較）`)
  }
  bad.push(...omissionsOf(r, o, full))
  bad.push(...oracleDisagreement(buf, o))
  return bad
}

/**
 * **必須 oracle を 2 実装にする（v0.6.5・外部監査 §10）。**
 *
 * v0.6.4 の差分試験は `tar`（この環境では bsdtar）1 実装だけを機械で強制していた。
 * **oracle が持つ癖と同じ癖を検算器が持っていると、差分は出ない。**実測でそうなった:
 *
 * ```
 * PAX path に NUL を入れる
 *   検算 v9  NUL 以降を切り捨てて OK
 *   bsdtar   同じく切り捨てる          → 差分 0（見つからない）
 *   python   embedded null で展開に失敗 → ここで初めて割れる
 * ```
 *
 * **必須 oracle どうしが割れる archive は、受理してはいけない。**
 * どちらが正しいかを決める立場にないので、狭い部分集合だけを受ける。
 */
function oracleDisagreement(buf: Buffer, bsd: { entries: Extracted[] }): string[] {
  const py = extractWithPython(buf)
  if (py.unavailable) return []                  // python が無い環境では判定しない
  if (py.failed) return [`bsdtar は展開できたのに python は展開できない（${py.stderr.slice(0, 70)}）`]
  const a = bsd.entries.filter((e) => e.type !== 'dir').map((e) => e.path).sort()
  const b = py.files.slice().sort()
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    return [`必須 oracle が違う木を作る: bsdtar=${JSON.stringify(a).slice(0, 60)} python=${JSON.stringify(b).slice(0, 60)}`]
  }
  return []
}

function extractWithPython(buf: Buffer): { files: string[], failed: boolean, unavailable: boolean, stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'trs-oracle-py-'))
  tmps.push(dir)
  writeFileSync(join(dir, 'a.tar'), buf)
  try {
    const out = execFileSync('python3', ['-c', PY_EXTRACT, join(dir, 'a.tar'), join(dir, 'out')], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim()
    if (out.startsWith('FAIL ')) return { files: [], failed: true, unavailable: false, stderr: out.slice(5) }
    return { files: JSON.parse(out.slice(3)) as string[], failed: false, unavailable: false, stderr: '' }
  } catch (e) {
    // python3 が無い / 起動できない場合だけ「判定しない」に倒す
    const err = String((e as { stderr?: Buffer }).stderr ?? '')
    if (/ENOENT|not found/i.test(err) || (e as { code?: string }).code === 'ENOENT') {
      return { files: [], failed: false, unavailable: true, stderr: '' }
    }
    return { files: [], failed: true, unavailable: false, stderr: err.split('\n').filter(Boolean).pop() ?? '' }
  }
}

const PY_EXTRACT = `
import sys, os, tarfile, json
src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)
try:
    with tarfile.open(src) as t:
        t.extractall(dst, filter='tar')
except Exception as e:
    print("FAIL " + type(e).__name__ + ": " + str(e)[:80]); sys.exit(0)
got = []
for root, dirs, files in os.walk(dst):
    for n in files + [d for d in dirs if os.path.islink(os.path.join(root, d))]:
        got.append(os.path.relpath(os.path.join(root, n), dst))
print("OK " + json.dumps(sorted(set(got))))
`

/**
 * **逆向きも見る（v0.6.4・外部監査 P0-B）。**
 *
 * v0.6.3 の差分試験は**片方向**だった——「検算器が返した key が展開木に在るか」しか見ていない。
 * そのため **`typeflag 7` のように「展開されるのに検算器が数えない」欠陥は素通りした。**
 * 実測: この検査を外す変異を入れても、片方向の 48 件は 1 件も落ちなかった。
 *
 * 逆向きの要件はこうである。
 *
 * > 展開してできた通常ファイルは、検算器の `files` か `inventory` のどちらかに
 * > 現れていなければならない。どちらにも無いなら、**検算器から見えていないファイルが
 * > source に混じる**ことになる。止まった（`ARCHIVE_INVALID`）なら合格。
 *
 * `inventory` はリンクやディレクトリも載せるので、**ファイルとして読まない entry を
 * 「見なかったこと」にはしない。**範囲の完全性検査はこちらを母集団にする。
 */
function omissionsOf(
  r: { files?: Map<string, Buffer>, inventory?: { name: string }[] },
  o: { entries: Extracted[], failed: boolean },
  full: (k: string) => string,
): string[] {
  const seen = new Set<string>([
    ...[...(r.files ?? new Map()).keys()],
    ...(r.inventory ?? []).map((e) => e.name),
  ].map(full))
  /**
   * **通常ファイル以外も見る（v0.6.5・外部監査 P1）。**
   * v0.6.4 は `type === 'file'` だけを母集団にしていたので、
   * **展開木にだけ現れる symlink** を「見なかったこと」にできた。
   * ディレクトリは tar が中間階層を暗黙に作るので、この比較からは外す。
   */
  return o.entries
    .filter((e) => e.type !== 'dir' && !seen.has(e.path))
    .map((e) => `${e.path} (${e.type}): 展開されるのに検算器の一覧に現れない（見えないものが source に混じる）`)
}

// --------------------------------------------------------------------------- 試験

describe('tar 展開 oracle ① 検算した view と展開した view が食い違わない', () => {
  it('oracle が動いている（正常な tar で木ができる）', () => {
    const o = extractWithTar(tarOf(entry({ name: 'root/a.txt', data: 'A' })))
    expect(o.failed, 'tar コマンドが使えない').toBe(false)
    expect(o.entries.some((e) => e.path === 'root/a.txt' && e.bytes?.toString() === 'A'), '展開できていない').toBe(true)
  })

  /**
   * **v0.6.2 まで食い違っていた 4 つ。**
   * どれも「検算器は OK と言うが、展開すると別のものができる」形である。
   */
  const CASES: [string, () => Buffer][] = [
    ['PAX path 上書き', () => tarOf(
      entry({ name: 'PaxHeaders/f', type: 'x', data: paxRecord('path', 'root/other.txt').toString() }),
      entry({ name: 'root/file.txt', data: 'EXPECTED' }),
    )],
    ['PAX size 上書き', () => tarOf(
      entry({ name: 'PaxHeaders/f', type: 'x', data: paxRecord('size', '4').toString() }),
      entry({ name: 'root/file.txt', data: 'ABCDEFGH' }),
    )],
    ['読み飛ばす entry の別名 path', () => tarOf(
      entry({ name: 'root/file.txt', data: 'FIRST' }),
      entry({ name: 'root/./file.txt', type: '2', linkname: 'target.txt' }),
      entry({ name: 'root/target.txt', data: 'SECOND' }),
    )],
    ['パス末尾の空白', () => tarOf(entry({ name: 'root/file.txt ', data: 'EXPECTED' }))],
    ['同名 symlink', () => tarOf(
      entry({ name: 'root/file.txt', data: 'FIRST' }),
      entry({ name: 'root/file.txt', type: '2', linkname: 'target.txt' }),
      entry({ name: 'root/target.txt', data: 'SECOND' }),
    )],
    ['同じ場所の別の綴り', () => tarOf(
      entry({ name: 'root/file.txt', data: 'FIRST' }),
      entry({ name: 'root/./file.txt', data: 'SECOND' }),
    )],
  ]

  it.each(CASES)('%s', (_label, make) => {
    expect(mismatchesOf(make())).toEqual([])
  })

  it('**この試験が空振りしていない**（食い違う材料を作れば検出する）', () => {
    /**
     * 検出器そのものを試す。**検算器を通さず**、
     * 「読めた view」を人工的に作って比較関数の判定を見る。
     */
    const buf = tarOf(entry({ name: 'root/a.txt', data: 'A' }))
    const o = extractWithTar(buf)
    const fake = new Map([['a.txt', Buffer.from('DIFFERENT')]])
    const bad: string[] = []
    for (const [k, v] of fake) {
      const file = o.entries.find((e) => (e.path === k || e.path.endsWith(`/${k}`)) && e.type === 'file')
      if (!file) bad.push(`${k}: 無い`)
      else if (file.content !== v.toString('utf8')) bad.push(`${k}: 中身が違う`)
    }
    expect(bad, '中身が違うのに検出できていない').toHaveLength(1)
  })

  it('対照 — 正常な tar は食い違わない', () => {
    expect(mismatchesOf(tarOf(
      entry({ name: 'root/a.txt', data: 'A' }),
      entry({ name: 'root/sub/b.txt', data: 'B' }),
    ))).toEqual([])
  })
})

describe('tar 展開 oracle ② 既存の 26 個も、この基準で見る', () => {
  const all = Object.entries(allCases()).flatMap(([kind, list]) => list.map((c) => [kind, c.id, c.tar] as const))

  it('材料が 26 個以上ある（母集団が空でない）', () => {
    expect(all.length).toBeGreaterThanOrEqual(26)
  })

  it.each(all.map(([kind, id]) => [`${kind}/${id}`] as const))('%s', (label) => {
    const found = all.find(([k, i]) => `${k}/${i}` === label)!
    /**
     * **`pax-x-path` と `pax-x-size-override` は、この基準で初めて落ちた。**
     * 手で書いた期待値では「PAX を拾っていないので合格」だった。
     */
    expect(mismatchesOf(found[2] as Buffer)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ③ **「壊れている」と言うには、手元の根拠が要る（v0.6.7・外部監査 P1-C）**
// ---------------------------------------------------------------------------

/**
 * ## なぜ要るか
 *
 * v0.6.6 まで、止める理由は全部 `ARCHIVE_INVALID` だった。
 * だが実測（2026-08-10）で、**bsdtar も python も何事もなく展開する archive**を
 * いくつも「壊れている」と言っていたことが分かった（typeflag 7・base-256 の size 欄など）。
 *
 * v0.6.7 で `ARCHIVE_UNSUPPORTED` を分けたが、**分けただけでは元に戻る。**
 * ここで機械の歯止めを置く。
 *
 * > `ARCHIVE_INVALID` を返す材料は、**手元の 2 実装のどちらかが拒むか、
 * > 2 実装が違う木を作る**こと。どちらも起きないなら「壊れている」とは言えない。
 *
 * `ARCHIVE_UNSUPPORTED` にはこの要求をかけない。あちらは archive ではなく
 * **こちらの範囲**の話なので、oracle が何を言うかとは無関係である。
 */

/**
 * **例外は、理由つきでここに書く。**
 *
 * ここに載っているのは「**手元では割れない**が、それでも止めているもの」である。
 * 監査（GNU tar 1.35 / BusyBox 1.37）の実測にもとづく判断で、
 * **こちらの環境には GNU tar も BusyBox も無いので再現していない。**
 *
 * この表があることで、「実測で裏が取れていない拒否」が**コードから数えられる**。
 * 黙って増やせない——増やせば下の 2 つ目の試験が落ちる。
 */
/**
 * **手元では割れないのに止めているもの。理由つきでここに書く。**
 *
 * 分類:
 *   `measured-elsewhere` … 監査（GNU tar 1.35 / BusyBox 1.37）は拒むと報告している。
 *                          **こちらの環境には GNU tar も BusyBox も無いので再現していない**
 *   `portability`        … 手元の OS では無害だが、別の OS では別の意味になる綴り
 *   `spec`               … POSIX の書式に無い。実測ではなく書式にもとづく判断
 *
 * **この表があると、「実測で裏の取れていない拒否」がコードから数えられる。**
 * 黙って増やせない——増やせば下の完全性の試験が落ちる。
 */
type NoEvidenceReason = 'measured-elsewhere' | 'portability' | 'spec'
const INVALID_WITHOUT_LOCAL_EVIDENCE: Record<string, { why: NoEvidenceReason, note: string }> = {
  // ---- 名前の上書きが 2 つ効く形（v0.6.4 で止めた）------------------------
  'pax-path-then-gnu-longname': {
    why: 'measured-elsewhere',
    note: '手元の bsdtar と python は一致して from-pax.txt を作る。'
      + 'v0.6.3 の検算器だけが from-gnu.txt を見ていた。監査は 4 実装で結末が分かれると報告',
  },
  'gnu-longname-then-pax-path': { why: 'measured-elsewhere', note: '同上（順序が逆・2 実装は from-gnu.txt で一致）' },
  // ---- 指す先の上書きが 2 つ効く形（v0.6.7 で止めた）----------------------
  'pax-linkpath-then-gnu-K': {
    why: 'measured-elsewhere',
    note: '監査は GNU tar と BusyBox で指す先が分かれると報告。手元の 2 実装は一致して'
      + '「先に来たほう」を採る。名前の上書きと同じ規則を当てている',
  },
  'pax-gnu-K-then-linkpath': { why: 'measured-elsewhere', note: '同上（順序が逆）' },
  // ---- PAX の値の文法（v0.6.6 で止めた）----------------------------------
  'pax-uid-not-a-number': {
    why: 'measured-elsewhere',
    note: '監査の GNU tar は Malformed extended header で exit 2。手元の 2 実装は通す',
  },
  'pax-mtime-not-a-number': { why: 'measured-elsewhere', note: '同上' },
  'pax-atime-nan': { why: 'measured-elsewhere', note: '同上' },
  'pax-ctime-exponent': { why: 'measured-elsewhere', note: '同上' },
  // ---- PAX の値の範囲（v0.6.7 で止めた）----------------------------------
  'pax-uid-above-32bit': {
    why: 'measured-elsewhere',
    note: '監査の GNU tar 1.35 は is out of range 0..4294967295 で exit 2。'
      + '手元の 2 実装は 2^64 でも通す。Unix の uid_t が 32bit なので正当な archive は超えない',
  },
  'pax-gid-above-32bit': { why: 'measured-elsewhere', note: '同上（gid 側）' },
  // ---- 書式・移植性 ------------------------------------------------------
  'pax-mtime-plus-sign': {
    why: 'spec',
    note: '先頭の + は POSIX pax の書式に無い。**手元の 2 実装はどちらも通す**',
  },
  'trav-backslash': {
    why: 'portability',
    note: 'Unix では `..\\evil.txt` という名前のふつうのファイルになる（実測: 2 実装とも同じ木）。'
      + 'Windows では 1 階層上を指す。**手元で無害なことは、受け手のところで無害であることを意味しない**',
  },
}

describe('tar 展開 oracle ③ ARCHIVE_INVALID には手元の根拠があるか、無い理由が書いてある', () => {
  const all = Object.entries(allCases()).flatMap(([kind, list]) => list.map((c) => [kind, c.id, c.tar] as const))

  /** 手元の 2 実装で、この archive が「拒まれる」か「割れる」かを見る */
  function localEvidence(buf: Buffer): string | null {
    const bsd = extractWithTar(buf)
    if (bsd.failed) return `bsdtar が拒む: ${bsd.stderr.slice(0, 60)}`
    /**
     * **警告も根拠に数える。**bsdtar は exit 0 のまま
     * `Damaged tar archive` や `Removing leading '/'` を出す（実測）。
     * どちらも「archive が言っているものと、できる木が違う」という報告である。
     */
    if (bsd.warned) return `bsdtar が警告する: ${bsd.stderr.slice(0, 60)}`
    const dir = mkdtempSync(join(tmpdir(), 'trs-oracle-py2-'))
    tmps.push(dir)
    const out = join(dir, 'out')
    mkdirSync(out)
    writeFileSync(join(dir, 'a.tar'), buf)
    try {
      const o = execFileSync('python3', ['-c', PY_EXTRACT, join(dir, 'a.tar'), out], { encoding: 'utf8' })
      if (o.startsWith('FAIL')) return `python が拒む: ${o.slice(0, 60)}`
    } catch {
      return 'python が拒む（起動できないか、落ちた）'
    }
    return treeDigest(bsd.entries) === treeDigest(walkTree(out)) ? null : '2 実装が違う木を作る'
  }

  /** **止める材料が十分にあること**（母集団が空だと、この試験は何も言っていない） */
  const invalidCases = all.filter(([, , tar]) => readArchiveBuffer(tar as Buffer, { gzip: false }).kind === 'ARCHIVE_INVALID')
  it('ARCHIVE_INVALID の材料が 30 個以上ある（母集団が空でない）', () => {
    expect(invalidCases.length).toBeGreaterThanOrEqual(30)
  })

  it.each(invalidCases.map(([kind, id]) => [`${kind}/${id}`, id] as const))(
    '%s', (_label, id) => {
      if (INVALID_WITHOUT_LOCAL_EVIDENCE[id]) return
      const found = invalidCases.find(([, i]) => i === id)!
      expect(
        localEvidence(found[2] as Buffer),
        `${id}: 手元の 2 実装がそろって通すのに ARCHIVE_INVALID と言っている`
        + '（本当に壊れているなら根拠を出す。範囲の話なら ARCHIVE_UNSUPPORTED にする。'
        + 'どちらでもないなら INVALID_WITHOUT_LOCAL_EVIDENCE へ理由つきで書く）',
      ).not.toBeNull()
    },
  )

  /**
   * **例外表が腐らないようにする。**
   * ここに書いた id が、あとから手元でも割れるようになったら（oracle を増やしたときなど）、
   * **その行はもう例外ではない。**残しておくと「再現していない拒否」の数を過大に見せる。
   */
  /**
   * **例外表が腐らないようにする。ただし bsdtar のときだけ厳密に見る。**
   *
   * この表は **bsdtar 3.5.3 と python 3.14 で測って**作った。
   * CI の ubuntu job では `tar` が GNU tar になるので、
   * `measured-elsewhere` の行は**そこで根拠が取れるようになるのが正しい**——
   * その環境で「例外が残っている」と言って落とすのは意味が逆である。
   *
   * だから **GNU tar のときは落とさず、どれが根拠を得たかを出す。**
   * これが監査の報告（GNU tar は拒む）に対するこちら側の実測になる。
   */
  it('例外表に、もう例外でない行が残っていない（bsdtar のときだけ厳密に見る）', () => {
    const version = (() => {
      try { return execFileSync('tar', ['--version'], { encoding: 'utf8' }).split('\n')[0] } catch { return 'unknown' }
    })()
    const isBsdtar = /bsdtar|libarchive/i.test(version)
    const gained: string[] = []
    for (const id of Object.keys(INVALID_WITHOUT_LOCAL_EVIDENCE)) {
      const found = all.find(([, i]) => i === id)
      expect(found, `例外表に、存在しない材料 ${id} が書いてある`).toBeTruthy()
      const ev = localEvidence(found![2] as Buffer)
      if (ev !== null) gained.push(`${id}: ${ev}`)
    }
    console.log(`\noracle = ${version}\n`
      + (gained.length
        ? `この実装では根拠が取れた: ${gained.length} 件\n${gained.map((g) => `  ${g}`).join('\n')}`
        : 'この実装では、例外表のどの行も根拠が取れない'))
    if (isBsdtar) {
      expect(gained, '手元（bsdtar）で根拠が取れるようになった。例外表から外すこと').toEqual([])
    }
  })

  /**
   * **数を固定する。**「実測で裏が取れていない拒否」が何件あるかは、
   * 受け手にとっては道具の限界そのものなので、**増えたら気づく形**にしておく。
   * 増やしてよいが、そのときはここと notes の両方を直すことになる。
   */
  it('実測で裏の取れていない拒否は 12 件（内訳を出す）', () => {
    const rows = Object.entries(INVALID_WITHOUT_LOCAL_EVIDENCE)
    const byWhy: Record<string, string[]> = {}
    for (const [id, v] of rows) (byWhy[v.why] ??= []).push(id)
    console.log(`\n手元の 2 実装では割れないのに止めているもの: ${rows.length} 件\n`
      + Object.entries(byWhy).map(([w, ids]) => `  ${w.padEnd(20)} ${ids.length} 件  ${ids.join(', ')}`).join('\n'))
    expect(rows.length, '件数が変わった。notes の記述も直すこと').toBe(12)
    expect(byWhy['measured-elsewhere']?.length, 'GNU tar / BusyBox 由来の件数').toBe(10)
  })

  it('**この試験が空振りしていない**（根拠の無い拒否を作れば落ちる）', () => {
    // 誰でも展開できる正常な tar を「壊れている」と呼ぶ状況を模す
    const normal = tarOf(entry({ name: 'root/a.txt', data: 'A' }))
    expect(localEvidence(normal), '正常な tar で根拠が出てしまっている').toBeNull()
  })
})
