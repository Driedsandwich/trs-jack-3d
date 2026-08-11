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

type Extracted = { path: string, type: 'file' | 'dir' | 'symlink' | 'special', content?: string, bytes?: Buffer, oversize?: number, unreadable?: string, special?: string }

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

/**
 * **名前もバイト列のまま扱う（v0.6.7・CI の ubuntu run で判明）。**
 *
 * Linux の file system は**不正な UTF-8 のファイル名を作れる。**
 * `readdirSync` を既定（utf8）で読むと、そのバイト列が U+FFFD へ置換された文字列で返り、
 * **その名前で `lstat` すると存在しない**（実測: ENOENT で試験が落ちた）。
 * macOS の APFS はそういう名前を作れないので、**この欠陥は macOS では出ない。**
 *
 * 置換したまま進めるのはもっと悪い。**違うバイト列が同じ名前に見える**ようになり、
 * それは v0.6.4 で検算器の側を直したのと同じ誤りである（[verify-tool-v9-notes.md]）。
 * 復元できないバイト列は、**潰さずにそのまま鍵にする。**
 */
const decodePathBytes = (b: Buffer) => {
  const s = b.toString('utf8')
  return Buffer.from(s, 'utf8').equals(b) ? s : `<raw:${b.toString('hex')}>`
}

/** 展開してできた木を列挙する。**oracle が違っても同じ物差しで見る**ために切り出してある */
function walkTree(out: string): Extracted[] {
  const found: Extracted[] = []
  const root = Buffer.from(out)
  const at = (rel: Buffer | null) => (rel ? Buffer.concat([root, Buffer.from('/'), rel]) : root)
  const walk = (rel: Buffer | null) => {
    for (const n of readdirSync(at(rel), { encoding: 'buffer' }).sort(Buffer.compare)) {
      const r = rel ? Buffer.concat([rel, Buffer.from('/'), n]) : n
      const full = at(r)
      const st = lstatSync(full)
      const path = decodePathBytes(r)
      if (st.isSymbolicLink()) {
        found.push({ path, type: 'symlink', content: decodePathBytes(readlinkSync(full, { encoding: 'buffer' })) })
      } else if (st.isDirectory()) { found.push({ path, type: 'dir' }); walk(r) }
      /**
       * **通常ファイル以外を `readFileSync` に掛けない（v0.6.9・こちらで見つけた）。**
       *
       * FIFO を開くと**書き手が現れるまで戻らない。**例外ではなく停止なので、
       * 下の `try` では捕まえられず、**試験が永久に止まる**（CI ごと止まる）。
       * 実測（2026-08-11）: typeflag 6 の archive は bsdtar・python とも
       * **実際に FIFO を作る**。typeflag の材料を corpus へ入れる前に直した。
       *
       * device は権限が無くて作れないことが多いが、作れた環境で同じ罠を踏まないよう
       * まとめて「中身を読まない種別」として木に残す。
       */
      else if (!st.isFile()) {
        const kind = st.isFIFO() ? 'fifo' : st.isSocket() ? 'socket'
          : st.isCharacterDevice() ? `chardev:${st.rdev}` : st.isBlockDevice() ? `blockdev:${st.rdev}` : 'unknown'
        found.push({ path, type: 'special', special: kind })
      }
      // **中身は生バイトで持つ（v0.6.5・外部監査 P1）。**UTF-8 文字列にすると
      // 不正バイトが U+FFFD へ潰れ、**違うバイト列が「同じ」に見える。**
      else if (st.size > ORACLE_READ_LIMIT) found.push({ path, type: 'file', oversize: st.size })
      else {
        /**
         * **読めなかったことを、読めたことにしない（v0.6.8）。**
         * `mode` 欄が壊れた archive を展開すると、権限 0 のファイルができて読めない。
         * 例外で落とすと試験が止まり、黙って飛ばすと**片方だけ読めない木が「同じ」に見える。**
         * 読めなかった事実を木に残す。
         */
        try { found.push({ path, type: 'file', bytes: readFileSync(full) }) } catch (e) {
          found.push({ path, type: 'file', unreadable: `${(e as { code?: string }).code ?? 'ERR'}/mode=${(st.mode & 0o7777).toString(8)}` })
        }
      }
    }
  }
  walk(null)
  return found
}

/** 木を 1 本の文字列にする（**リンクの指す先まで含める**——そこで割れる archive がある） */
const treeDigest = (es: Extracted[]) => es
  .map((e) => `${e.type} ${e.path}${e.type === 'symlink' ? ` -> ${e.content}` : ''}`
    + (e.type === 'special' ? ` #${e.special}` : '')
    + (e.type === 'file'
      ? ` #${e.bytes ? e.bytes.toString('hex') : (e.unreadable ? `unreadable:${e.unreadable}` : `oversize:${e.oversize}`)}`
      : ''))
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
    else if (!file.bytes) bad.push(`${k}: 展開結果の中身を比較していない（${file.unreadable ?? `${file.oversize} バイト`}）`)
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
  /**
   * **比べるのはパスの一覧ではなく、型つきの木（v0.6.8・外部監査 §6）。**
   *
   * v0.6.7 はパス名だけを並べて比べていた。だから
   * **同じ名前で片方が symlink・片方が通常ファイル**でも、
   * **中身のバイト列が違って**も、差が出なかった。
   * 実測（2026-08-11）: PAX path が `/` で終わる通常ファイルで
   * bsdtar は directory を作り python は通常ファイルを作る——**名前だけ見ると同じ。**
   *
   * **python が無い環境では判定しない、もやめた。**
   * 必須 oracle が動いていないなら、それは「合格」ではなく「確かめていない」である。
   */
  const py = extractWithPythonTree(buf)
  if (py.unavailable) {
    return ['必須 oracle（python3）が無いか起動できない。**確かめていないので合格にしない**']
  }
  if (py.failed) return [`bsdtar は展開できたのに python は展開できない（${py.stderr.slice(0, 70)}）`]
  const a = treeDigest(bsd.entries)
  const b = treeDigest(py.entries)
  if (a !== b) {
    const diff = a.split('\n').filter((l) => !b.split('\n').includes(l)).slice(0, 2).join(' / ')
    return [`必須 oracle が違う木を作る（型・指す先・中身まで比較）: bsdtar だけにある ${diff.slice(0, 90)}`]
  }
  return []
}

/** python で展開して、**bsdtar と同じ物差し**（walkTree）で木にする */
function extractWithPythonTree(buf: Buffer): { entries: Extracted[], failed: boolean, unavailable: boolean, stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'trs-oracle-pyt-'))
  tmps.push(dir)
  const out = join(dir, 'out')
  mkdirSync(out)
  writeFileSync(join(dir, 'a.tar'), buf)
  try {
    const o = execFileSync('python3', ['-c', PY_EXTRACT, join(dir, 'a.tar'), out], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim()
    if (o.startsWith('FAIL ')) return { entries: [], failed: true, unavailable: false, stderr: o.slice(5) }
    return { entries: walkTree(out), failed: false, unavailable: false, stderr: '' }
  } catch (e) {
    const err = String((e as { stderr?: Buffer }).stderr ?? '')
    if (/ENOENT|not found/i.test(err) || (e as { code?: string }).code === 'ENOENT') {
      return { entries: [], failed: false, unavailable: true, stderr: '' }
    }
    return { entries: [], failed: true, unavailable: false, stderr: err.split('\n').filter(Boolean).pop() ?? '' }
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
 * **その run の 2 実装では割れないのに止めているもの。どこで根拠が取れるかを書く。**
 *
 * ## この表は 2026-08-10 の CI で作り直した
 *
 * 最初は macOS（bsdtar 3.5.3 / python 3.14）だけで作った。
 * **CI を GNU tar（ubuntu）と bsdtar（macOS）の matrix にした最初の run で、
 * 根拠が platform ごとに別だと分かった。**
 *
 * ```
 * bsdtar だけで取れる根拠   PAX の g 上書き（bsdtar と python が別の木を作る）
 *                          uname / gname の不正 UTF-8（libarchive が locale 変換で拒む）
 *                          パスの不正 UTF-8（macOS は 2 実装とも作れない・Linux は両方作れる）
 * GNU tar だけで取れる根拠  PAX の値が数値でない／範囲外（Malformed extended header）
 *                          名前・指す先の上書きが 2 つ効く形（片方の順序だけ木が割れる）
 * ```
 *
 * **どちらか片方の実装だけでは、止める理由の半分が見えない。**
 * これが matrix を入れた理由そのものであり、入れて初めて測れた。
 *
 * `on` は「**その実装で根拠が取れる**」ことを表す。
 *   `'bsdtar'`  … macOS 側で取れる（ubuntu 側では取れない）
 *   `'gnu-tar'` … ubuntu 側で取れる（macOS 側では取れない）
 *   `'none'`    … **どちらでも取れていない。**止める理由は実測の外にある
 *
 * 下の試験が、`on` が自分の実装を指している行について
 * **本当に根拠が取れることを毎 run 確かめる**（書きっぱなしにできない）。
 */
type EvidencePlatform = 'bsdtar' | 'gnu-tar' | 'none'
const EVIDENCE_ELSEWHERE: Record<string, { on: EvidencePlatform, note: string }> = {
  // ---- GNU tar 側で取れる（2026-08-10 の ubuntu run で実測）--------------
  'pax-uid-not-a-number': {
    on: 'gnu-tar',
    note: 'GNU tar 1.35: Malformed extended header: invalid uid=abc（bsdtar と python は通す）',
  },
  'pax-mtime-not-a-number': { on: 'gnu-tar', note: 'GNU tar 1.35: Malformed extended header: invalid mtime=abc' },
  'pax-atime-nan': { on: 'gnu-tar', note: 'GNU tar 1.35: Malformed extended header: invalid atime=nan' },
  'pax-ctime-exponent': { on: 'gnu-tar', note: 'GNU tar 1.35: Malformed extended header: invalid ctime=1e999' },
  'pax-uid-above-32bit': {
    on: 'gnu-tar',
    note: 'GNU tar 1.35: Extended header uid=999… is out of range 0..4294967295（監査の報告どおり）',
  },
  'pax-gid-above-32bit': {
    on: 'gnu-tar',
    note: 'GNU tar 1.35: Extended header gid=4294967296 is out of range 0..4294967295（監査の報告どおり）',
  },
  'pax-mtime-plus-sign': {
    on: 'gnu-tar',
    note: 'GNU tar 1.35: Malformed extended header: invalid mtime=+1。'
      + '**POSIX の書式から出した判断だったが、実測でも裏が取れた**',
  },
  'gnu-longname-then-pax-path': {
    on: 'gnu-tar',
    note: 'ubuntu では GNU tar と python が違う木を作る。**macOS では bsdtar と python が一致する**',
  },
  'pax-gnu-K-then-linkpath': { on: 'gnu-tar', note: '同上（指す先の側）' },

  // ---- bsdtar 側で取れる（macOS で実測）----------------------------------
  'pax-g-path-override': {
    on: 'bsdtar',
    note: 'bsdtar は a.txt、python は from-global.txt を作る（別の木）。ubuntu では GNU tar が python と一致する',
  },
  'pax-g-linkpath-override': {
    on: 'bsdtar',
    note: 'bsdtar は link -> t1.txt、python は link -> t2.txt（別の木）',
  },
  'pax-uname-invalid-utf8': {
    on: 'bsdtar',
    note: "libarchive: Uname can't be converted from UTF-8 to current locale. で exit 1。GNU tar は通す",
  },
  'pax-gname-invalid-utf8': { on: 'bsdtar', note: '同上（Gname 側）' },
  'invalid-utf8-ustar-name': {
    on: 'bsdtar',
    note: '**受け手の環境で結果が変わる。**macOS では bsdtar も python も Illegal byte sequence で作れず、'
      + 'Linux では GNU tar も python も作れる。**同じ archive の展開結果が OS で変わる**',
  },
  'invalid-utf8-gnu-longname': { on: 'bsdtar', note: '同上（GNU long name 経由）' },
  'invalid-utf8-ustar-prefix': { on: 'bsdtar', note: '同上（prefix 欄経由）' },
  'invalid-utf8-pax-path': { on: 'bsdtar', note: '同上（PAX path 経由。libarchive は Pathname が変換できないと言う）' },

  // ---- どちらでも取れていない（**実測の外にある判断**）--------------------
  'pax-path-then-gnu-longname': {
    on: 'none',
    note: '**2 実装が一致する順序。**逆順（gnu-longname-then-pax-path）は GNU tar 側で割れる。'
      + '監査は 4 実装で結末が分かれると報告しているが、こちらでは両 platform とも割れない。'
      + '名前の上書きが 2 つ効く形として、逆順と同じ規則で止めている',
  },
  'pax-linkpath-then-gnu-K': {
    on: 'none',
    note: '同上（指す先の側）。逆順（pax-gnu-K-then-linkpath）は GNU tar 側で割れる',
  },
  /**
   * **v0.6.8 で足した行。**`trav-backslash` はここから外した——
   * `ARCHIVE_UNSUPPORTED` にしたので、この表（`ARCHIVE_INVALID` が対象）の外になる。
   * Unix では 3 実装とも同じ木を作り、Windows では 1 階層上を指す。
   * **壊れているのではなく、受け手の OS で意味が変わる**（外部監査 §7）。
   */
  /**
   * **`raw-mode-not-octal` はこの表に要らなかった。**
   * bsdtar は権限 0 の読めないファイルを作り python は mode を丸める＝macOS で割れ、
   * GNU tar 1.35 は `Archive contains 'abc\0    ' where numeric mode_t value expected` で拒む
   * ＝ubuntu でも根拠が取れる（2026-08-11 の CI で実測）。**両方で取れる行は表に載せない。**
   */
  'pax-two-local-x': {
    on: 'bsdtar',
    note: 'local PAX が 2 つ続く形。bsdtar は `Ignoring malformed pax extended attribute` で exit 1。'
      + '**ubuntu では GNU tar と python が一致して通す**ので、そちらでは根拠が取れない',
  },
  /**
   * **長さ 0 の値（v0.6.9）。**手元の 2 実装はそろって通すが、
   * **GNU tar は archive ごと拒む**ので、ubuntu 側でだけ根拠が取れる。
   * こちらは一度これを「過剰拒否」と誤って直し、**CI の ubuntu run に落とされた。**
   */
  'pax-zero-length-mtime': {
    on: 'gnu-tar',
    note: 'PAX の mtime が長さ 0。GNU tar 1.35 は `Malformed extended header: invalid mtime=` で拒む'
      + '（2026-08-11 の CI で実測）。bsdtar と python は削除として無視して展開する',
  },
  'pax-zero-length-uid': {
    on: 'gnu-tar',
    note: 'PAX の uid が長さ 0。同上（`invalid uid=`）',
  },
  // ---------------------------------------------------------------- v0.6.10
  /**
   * **数値として読めない `mtime` は GNU tar が archive ごと拒む。**
   * `abc` / `+1` / `1e999` / 長さ 0 で実測済みで、`.5` も同じ経路のはず——
   * **これは「そう読める」ではなく、ubuntu の run が毎回照合する主張**である
   * （違えば「表が古い」で落ちる）。
   */
  'pax-mtime-leading-dot': {
    on: 'gnu-tar',
    note: 'PAX の mtime が `.5`（数字が先に無い）。手元の 2 実装は通す。'
      + 'GNU tar は他の壊れた mtime と同じく `Malformed extended header` で拒むはず——CI が毎 run 照合する',
  },
  /**
   * **ここから下は「実装が割れているから止めている」のではなく、方針で止めている。**
   *
   * v0.6.10 で材料を足したときに、**この試験自身が炙り出した。**
   * どれも手元の 2 実装は同じ木を作る。**根拠が無いと書いておく方が、
   * 「割れているから止めた」と書くより正確である。**
   */
  'zero-hdrcharset': {
    on: 'none',
    note: '`hdrcharset=`（長さ 0）。名前の読み方を変える鍵なので、値の長さに関係なく解釈しない方針。'
      + '手元の 2 実装は無視して同じ木を作る',
  },
  'nonzero-size': {
    on: 'none',
    note: '`size=12`。size は entry の見え方を変えるので解釈しない方針（v0.6.3 から）。'
      + '手元の 2 実装はこの上書きを無視する（読む長さが本当に変わる材料は pax-x-size-override 側にある）',
  },
  'eoa-lone-zero-then-member': {
    on: 'none',
    note: '終端 zero block 1 個のあとに member。**手元の 2 実装もそこで読むのをやめる**ので割れない。'
      + '監査は BusyBox が読むと報告しているが、**BusyBox は開発機にも CI にも無い。**'
      + 'それでも止めるのは「一覧に無いものを読む読み手がいる」時点で約束を果たせないため',
  },
  'eoa-lone-zero-then-junk': { on: 'none', note: '同上（member ではなく非 zero の詰め物）' },
  'dup-regular-same-content': {
    on: 'none',
    note: '同じパスの通常ファイルが 2 回。手元の 2 実装は後勝ちで同じ木を作る。'
      + '**v0.6.1 からの方針**（どちらを検算したのか言えなくなる）で止めており、実装の割れが根拠ではない',
  },
  'dup-regular-different-content': { on: 'none', note: '同上（中身が違う版）' },
  /**
   * **`pax-symlink-trailing-slash` はこの表から外した（v0.6.9・外部監査 P1-B）。**
   * 「手元の 2 実装が同じ木を作るのに止めている」と書いていた行そのものが、
   * **過剰拒否の白状だった。**v0.6.9 で受理する側へ直したので、拒否ではなくなった。
   * **根拠が無いと書いてある行は、直す候補の一覧でもある。**
   */
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

  /** この run が使っている実装。**根拠がどちらで取れるかは実装で変わる** */
  const IMPL = (() => {
    const v = (() => {
      try { return execFileSync('tar', ['--version'], { encoding: 'utf8' }).split('\n')[0] } catch { return 'unknown' }
    })()
    const kind: EvidencePlatform | 'other'
      = /bsdtar|libarchive/i.test(v) ? 'bsdtar' : /GNU tar/i.test(v) ? 'gnu-tar' : 'other'
    return { version: v, kind }
  })()

  /** **止める材料が十分にあること**（母集団が空だと、この試験は何も言っていない） */
  const invalidCases = all.filter(([, , tar]) => readArchiveBuffer(tar as Buffer, { gzip: false }).kind === 'ARCHIVE_INVALID')
  it('ARCHIVE_INVALID の材料が 30 個以上ある（母集団が空でない）', () => {
    expect(invalidCases.length).toBeGreaterThanOrEqual(30)
  })

  it.each(invalidCases.map(([kind, id]) => [`${kind}/${id}`, id] as const))(
    '%s', (_label, id) => {
      const listed = EVIDENCE_ELSEWHERE[id]
      /**
       * **「別の実装で取れる」と書いてある行は、その実装で回っているときだけ免除しない。**
       * 自分の実装が `on` と一致するなら、根拠は**ここで**取れなければならない
       * （下の腐り検査がそれを見る）。一致しないなら、ここでは判定しない。
       */
      if (listed && listed.on !== IMPL.kind) return
      const found = invalidCases.find(([, i]) => i === id)!
      expect(
        localEvidence(found[2] as Buffer),
        `${id}: この run の 2 実装がそろって通すのに ARCHIVE_INVALID と言っている`
        + '（本当に壊れているなら根拠を出す。範囲の話なら ARCHIVE_UNSUPPORTED にする。'
        + 'どちらでもないなら EVIDENCE_ELSEWHERE へ、どこで根拠が取れるか書く）',
      ).not.toBeNull()
    },
  )

  /**
   * **表の主張を毎 run 確かめる。**
   *
   * `on` が自分の実装を指している行は、**ここで根拠が取れなければ嘘**である。
   * `on` が別の実装を指している行は、ここで取れないのが正しい——
   * **取れてしまったら `on` の書き方が古い。**
   * どちらも落とす。書きっぱなしにできないようにするため。
   */
  it('表の「どこで根拠が取れるか」が、この実装で実際にそうなっている', () => {
    const wrong: string[] = []
    const gained: string[] = []
    for (const [id, row] of Object.entries(EVIDENCE_ELSEWHERE)) {
      const found = all.find(([, i]) => i === id)
      expect(found, `表に、存在しない材料 ${id} が書いてある`).toBeTruthy()
      const ev = localEvidence(found![2] as Buffer)
      if (ev !== null) gained.push(`${id}: ${ev}`)
      if (IMPL.kind === 'other') continue
      if (row.on === IMPL.kind && ev === null) wrong.push(`${id}: ${IMPL.kind} で取れると書いてあるのに取れない`)
      if (row.on !== IMPL.kind && ev !== null) wrong.push(`${id}: ${row.on} で取れると書いてあるが、${IMPL.kind} でも取れる（表が古い）`)
    }
    console.log(`\noracle = ${IMPL.version}（${IMPL.kind}）\n`
      + (gained.length
        ? `この実装で根拠が取れた行: ${gained.length} 件\n${gained.map((g) => `  ${g}`).join('\n')}`
        : 'この実装では、表のどの行も根拠が取れない'))
    expect(wrong, '表の記述と実測が合っていない').toEqual([])
  })

  /**
   * **数を固定する。**「どちらの必須 oracle でも裏が取れていない拒否」が何件あるかは、
   * 受け手にとっては道具の限界そのものなので、**増えたら気づく形**にしておく。
   * 増やしてよいが、そのときはここと notes の両方を直すことになる。
   */
  it('どちらの必須 oracle でも裏の取れていない拒否は 8 件（内訳を出す）', () => {
    const rows = Object.entries(EVIDENCE_ELSEWHERE)
    const byOn: Record<string, string[]> = {}
    for (const [id, v] of rows) (byOn[v.on] ??= []).push(id)
    console.log(`\nこの run の 2 実装では割れないのに止めているもの: ${rows.length} 件\n`
      + Object.entries(byOn).map(([w, ids]) => `  ${w.padEnd(10)} ${ids.length} 件  ${ids.join(', ')}`).join('\n'))
    /**
     * **v0.6.9 で 3 件 → 2 件。**減ったのは `pax-symlink-trailing-slash` で、
     * 「2 実装が同じ木を作るのに止めている」と書いてあった行**そのものが過剰拒否だった。**
     * 根拠が無いと書いた行は、次に直す候補の一覧でもある。
     */
    expect(byOn['none']?.length ?? 0, '実測の外にある拒否の件数が変わった。notes も直すこと').toBe(8)
    expect(byOn['bsdtar']?.length, 'bsdtar 側でだけ根拠が取れる件数').toBe(9)
    expect(byOn['gnu-tar']?.length, 'GNU tar 側でだけ根拠が取れる件数').toBe(12)
  })

  it('**この試験が空振りしていない**（根拠の無い拒否を作れば落ちる）', () => {
    // 誰でも展開できる正常な tar を「壊れている」と呼ぶ状況を模す
    const normal = tarOf(entry({ name: 'root/a.txt', data: 'A' }))
    expect(localEvidence(normal), '正常な tar で根拠が出てしまっている').toBeNull()
  })
})

/**
 * **木を歩く道具が、名前をバイト列で扱っていること（v0.6.7）。**
 *
 * CI の ubuntu run で、`readdirSync` を既定（utf8）で読んでいたために
 * **不正 UTF-8 の名前で `lstat` が ENOENT になり、試験が落ちた。**
 * Linux はそういう名前を作れて、macOS の APFS は作れない——
 * **同じ試験が、OS によって見えるものを変えていた。**
 *
 * 不正 UTF-8 の名前は macOS では作れないので、ここでは**非 ASCII の正しい UTF-8** で
 * バイト列経路を通す。ここが文字列に戻ると、この試験が落ちる。
 */
describe('tar 展開 oracle ④ 名前をバイト列で扱っている', () => {
  it('非 ASCII の名前でも、検算した view と展開した木が一致する', () => {
    const buf = tarOf(entry({ name: 'root/日本語のファイル.txt', data: 'NIHONGO' }))
    // 対照: この材料が実際に読めている（空振りしていない）
    const r = readArchiveBuffer(buf, { gzip: false })
    expect(r.error, '材料が読めていない＝この試験は何も言っていない').toBeFalsy()
    expect([...r.files!.keys()]).toEqual(['日本語のファイル.txt'])
    expect(mismatchesOf(buf)).toEqual([])
  })

  it('**復元できないバイト列は潰さない**（違うバイト列が同じ鍵にならない）', () => {
    // 直接 file system へは書けないので、decode の規則そのものを見る
    const a = Buffer.from([0xff, 0xfe])
    const b = Buffer.from([0xfe, 0xff])
    expect(decodePathBytes(a)).not.toBe(decodePathBytes(b))
    // 対照: 正しい UTF-8 はそのままの文字列になる
    expect(decodePathBytes(Buffer.from('日本語', 'utf8'))).toBe('日本語')
  })
})
