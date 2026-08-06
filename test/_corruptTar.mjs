/**
 * **壊れた tar を作る。**`scripts/verifyReleaseSourceInputs.mjs` の parser を試すため。
 *
 * **手で作った 1 個だけで通さない。**攻撃の種類ごとに、
 * パラメータを変えた複数個を生成する。1 個だけだと、
 * その 1 個をたまたま弾く実装でも「防げた」ことになってしまう。
 *
 * 生成できる種類:
 *   PAX ヘッダ (`x` / `g`)
 *   GNU long name (`L`) — 正常系と、長さを偽った異常系
 *   header checksum 不正
 *   path traversal (`../` を含む entry・絶対パス)
 *   symlink (`2`) / hardlink (`1`)
 *
 * **正常な tar も作れる**（`buildTar`）。塞ぎすぎていないことを確かめるのに要る。
 */

const BLOCK = 512

const pad = (s, n) => {
  const b = Buffer.alloc(n)
  Buffer.from(String(s), 'utf8').copy(b, 0, 0, Math.min(n, Buffer.byteLength(String(s))))
  return b
}
const octal = (v, n) => pad(v.toString(8).padStart(n - 1, '0'), n)

/**
 * ヘッダ 1 個を作る。
 * @param o.checksum 'valid' | 'bad' | 'blank' — checksum の入れ方を選べる
 */
export function header(o) {
  const h = Buffer.alloc(BLOCK)
  pad(o.name ?? '', 100).copy(h, 0)
  octal(o.mode ?? 0o644, 8).copy(h, 100)
  octal(o.uid ?? 0, 8).copy(h, 108)
  octal(o.gid ?? 0, 8).copy(h, 116)
  octal(o.size ?? 0, 12).copy(h, 124)
  octal(o.mtime ?? 0, 12).copy(h, 136)
  h.write(o.type ?? '0', 156, 1, 'ascii')
  pad(o.linkname ?? '', 100).copy(h, 157)
  pad('ustar', 6).copy(h, 257)
  pad('00', 2).copy(h, 263)
  pad(o.prefix ?? '', 155).copy(h, 345)

  // checksum は「checksum 欄を空白 8 個で埋めた状態」の総和
  h.fill(0x20, 148, 156)
  let sum = 0
  for (const b of h) sum += b
  const mode = o.checksum ?? 'valid'
  if (mode === 'valid') {
    pad(`${sum.toString(8).padStart(6, '0')}\0 `, 8).copy(h, 148)
  } else if (mode === 'bad') {
    pad(`${((sum + 1) % 0o777777).toString(8).padStart(6, '0')}\0 `, 8).copy(h, 148)
  } else if (mode === 'blank') {
    h.fill(0x20, 148, 156)
  } else {
    throw new Error(`checksum の指定が不正: ${mode}`)
  }
  return h
}

/** データを 512 の倍数へ揃える */
const body = (data) => {
  const b = Buffer.from(data)
  const padded = Buffer.alloc(Math.ceil(b.length / BLOCK) * BLOCK)
  b.copy(padded)
  return padded
}

/** entry の配列から tar を組み立てる。末尾の終端ブロックも付ける */
export function buildTar(entries, opts = {}) {
  const parts = []
  for (const e of entries) {
    const data = e.data === undefined ? Buffer.alloc(0) : Buffer.from(e.data)
    parts.push(header({ ...e, size: e.declaredSize ?? data.length }))
    if (data.length) parts.push(body(data))
  }
  if (opts.endBlocks !== 0) parts.push(Buffer.alloc(BLOCK * (opts.endBlocks ?? 2)))
  return Buffer.concat(parts)
}

/** 中身のある正常な tar（`<top>/` を頭に付ける。GitHub の tarball と同じ形） */
export function normalTar(top = 'trs-jack-3d-abc1234', files = { 'a.txt': 'A', 'src/b.txt': 'B' }) {
  return buildTar(Object.entries(files).map(([name, data]) => ({ name: `${top}/${name}`, data })))
}

// ---------------------------------------------------------------------------
// 攻撃の種類ごとに複数個を作る
// ---------------------------------------------------------------------------

const TOP = 'pkg-0000000'

/** PAX（`x` = entry 単位 / `g` = global）。**中身をファイルとして拾ったら負け** */
export const paxCases = () => {
  const rec = (k, v) => {
    const body = ` ${k}=${v}\n`
    const len = String(body.length + String(body.length + 2).length).length + body.length
    return `${len}${body}`
  }
  return [
    { id: 'pax-x-path', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a.txt`, type: 'x', data: rec('path', `${TOP}/renamed.txt`) },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    { id: 'pax-g-global', tar: buildTar([
      { name: 'pax_global_header', type: 'g', data: rec('comment', 'x'.repeat(40)) },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    { id: 'pax-x-huge-record', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a.txt`, type: 'x', data: rec('comment', 'y'.repeat(5000)) },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    { id: 'pax-x-size-override', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a.txt`, type: 'x', data: rec('size', '999999999') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },

    /**
     * **同じ member に名前の上書きが 2 つ効く形（v0.6.4・外部監査 P0-A）。**
     *
     * v0.6.3 は `longName` を後勝ちで置いていたので、**実装ごとに結末が割れる archive**を
     * 「読めた」と言っていた。同じ archive を 3 者で読んだ実測（2026-08-06）:
     *
     * ```
     * PAX path= → GNU L    検算 gnu.txt ／ bsdtar pax.txt ／ python pax.txt
     * GNU L → PAX path=    検算 pax.txt ／ bsdtar gnu.txt ／ python gnu.txt
     * PAX path= を 2 回     検算 two.txt ／ bsdtar 拒否   ／ python one.txt
     * PAX path= → PAX x    検算 pax.txt ／ bsdtar 拒否   ／ python pax.txt
     * ```
     *
     * **どれが正しいかを決める立場にない。**正しい source archive にこの形は出てこないので、
     * 「実装間で結末が割れるもの」は読まずに止める。
     */
    { id: 'pax-path-then-gnu-longname', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a.txt`, type: 'x', data: rec('path', `${TOP}/from-pax.txt`) },
      { name: '././@LongLink', type: 'L', data: `${TOP}/from-gnu.txt\0` },
      { name: `${TOP}/raw.txt`, data: 'A' },
    ]) },
    { id: 'gnu-longname-then-pax-path', tar: buildTar([
      { name: '././@LongLink', type: 'L', data: `${TOP}/from-gnu.txt\0` },
      { name: `${TOP}/PaxHeaders/0/a.txt`, type: 'x', data: rec('path', `${TOP}/from-pax.txt`) },
      { name: `${TOP}/raw.txt`, data: 'A' },
    ]) },
    { id: 'pax-path-twice', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a.txt`, type: 'x', data: rec('path', `${TOP}/one.txt`) },
      { name: `${TOP}/PaxHeaders/0/b.txt`, type: 'x', data: rec('path', `${TOP}/two.txt`) },
      { name: `${TOP}/raw.txt`, data: 'A' },
    ]) },
    { id: 'pax-path-then-second-pax', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a.txt`, type: 'x', data: rec('path', `${TOP}/from-pax.txt`) },
      { name: `${TOP}/PaxHeaders/0/b.txt`, type: 'x', data: rec('mtime', '1') },
      { name: `${TOP}/raw.txt`, data: 'A' },
    ]) },
    /** global header が名前を上書きする形。実物の `pax_global_header` は `comment` だけ */
    { id: 'pax-g-path-override', tar: buildTar([
      { name: 'pax_global_header', type: 'g', data: rec('path', `${TOP}/from-global.txt`) },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
  ]
}

/**
 * **展開されるのに、検算の母集団から消える entry（v0.6.4・外部監査 P0-B）。**
 *
 * v0.6.3 は通常ファイル（typeflag `0`）だけを `files` に入れ、
 * **未記録入力の探索もその key しか見ていなかった。**
 * 実測（2026-08-06）: `typeflag 7` を scope 配下へ置くと、
 * 検算は `status OK` / 未記録候補 0 件と言い、bsdtar と python はどちらも通常ファイルとして展開した。
 */
export const entryTypeCases = () => [
  { id: 'typeflag-7-contiguous', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/src/model/extra.ts`, type: '7', data: 'EXTRA' },
  ]) },
  { id: 'typeflag-S-gnu-sparse', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/src/model/sparse.ts`, type: 'S', data: 'SPARSE' },
  ]) },
  /**
   * リンクそのものは正当な archive でも出てくるので**止めない**。
   * 止める代わりに inventory へ載せ、範囲の完全性検査がそれを見る。
   */
  { id: 'symlink-under-scope', ok: true, tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/src/model/link.ts`, type: '2', linkname: 'a.txt' },
  ]) },
  { id: 'hardlink-under-scope', ok: true, tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/src/model/hl.ts`, type: '1', linkname: `${TOP}/a.txt` },
  ]) },
]

/**
 * **パスのバイト列が UTF-8 として読めない形（v0.6.4・外部監査 P0-C）。**
 *
 * v0.6.3 は `toString('utf8')` で読んでいたので、不正なバイトが U+FFFD へ黙って置換された。
 * 実測: 検算のパスは `file<FFFD>.txt`、bsdtar と python はどちらも生バイトのまま扱う。
 * **置換して続けると、検算が見た名前と展開してできる名前が別物になる。**
 *
 * 生バイトを入れてから checksum を計算する（先に計算すると checksum 不正で止まり、
 * **エンコーディングの検査を通っていないのに合格して見える**）。
 */
export const encodingCases = () => {
  const withRawByte = (buf, at, byte) => { const b = Buffer.from(buf); b[at] = byte; return b }
  const rec = (k, v) => {
    const body = ` ${k}=${v}\n`
    const len = String(body.length + String(body.length + 2).length).length + body.length
    return `${len}${body}`
  }
  // ustar の name 欄に 0xFF を入れ、そのうえで checksum を計算し直す
  const badName = (() => {
    const name = `${TOP}/fileX.txt`
    const h = header({ name, size: 4 })
    const patched = withRawByte(h, name.indexOf('X'), 0xff)
    return Buffer.concat([recheck(patched), body4('DATA'), Buffer.alloc(1024)])
  })()
  return [
    { id: 'invalid-utf8-ustar-name', tar: badName },
    { id: 'invalid-utf8-gnu-longname', tar: buildTar([
      { name: '././@LongLink', type: 'L', data: withRawByte(Buffer.from(`${TOP}/fileX.txt\0`), `${TOP}/file`.length, 0xff) },
      { name: `${TOP}/raw.txt`, data: 'A' },
    ]) },
    /** USTAR の prefix 欄（345〜499）。name 欄とは別の経路なので個別に試す */
    { id: 'invalid-utf8-ustar-prefix', tar: (() => {
      const h = header({ name: 'file.txt', prefix: `${TOP}/subX`, size: 4 })
      const at = h.indexOf(Buffer.from('subX'), 345) + 3
      return Buffer.concat([recheck(withRawByte(h, at, 0xff)), body4('DATA'), Buffer.alloc(1024)])
    })() },
    { id: 'invalid-utf8-pax-path', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a.txt`, type: 'x', data: withRawByte(Buffer.from(rec('path', `${TOP}/fileX.txt`)), rec('path', `${TOP}/file`).length - 1, 0xff) },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
  ]
}

/** checksum 欄を今のヘッダ内容で計算し直す（生バイトを入れたあとに使う） */
function recheck(h) {
  const b = Buffer.from(h)
  b.fill(0x20, 148, 156)
  let sum = 0
  for (const x of b) sum += x
  Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `).copy(b, 148)
  return b
}

/** 512 バイト境界まで詰めた本体 */
function body4(s) {
  const d = Buffer.from(s)
  const n = Buffer.alloc(Math.ceil(d.length / BLOCK) * BLOCK)
  d.copy(n)
  return n
}

/** GNU long name。正常系と、宣言長を偽った異常系 */
export const longNameCases = () => {
  const long = (n) => `${TOP}/${'d/'.repeat(n)}file.txt`
  return [
    { id: 'gnu-L-normal', ok: true, tar: buildTar([
      { name: '././@LongLink', type: 'L', data: `${long(60)}\0` },
      { name: `${TOP}/truncated`, data: 'A' },
    ]) },
    { id: 'gnu-L-very-long', tar: buildTar([
      { name: '././@LongLink', type: 'L', data: `${TOP}/${'x'.repeat(9000)}\0` },
      { name: `${TOP}/truncated`, data: 'A' },
    ]) },
    { id: 'gnu-L-size-lie', tar: buildTar([
      { name: '././@LongLink', type: 'L', declaredSize: 1 << 20, data: `${long(3)}\0` },
      { name: `${TOP}/truncated`, data: 'A' },
    ]) },
    { id: 'gnu-L-no-following-entry', tar: buildTar([
      { name: '././@LongLink', type: 'L', data: `${long(3)}\0` },
    ]) },
    { id: 'gnu-L-traversal', tar: buildTar([
      { name: '././@LongLink', type: 'L', data: `${TOP}/../../etc/passwd\0` },
      { name: `${TOP}/truncated`, data: 'A' },
    ]) },
  ]
}

/** header checksum 不正 */
export const checksumCases = () => [
  { id: 'cksum-bad-first', tar: buildTar([{ name: `${TOP}/a.txt`, data: 'A', checksum: 'bad' }]) },
  { id: 'cksum-bad-second', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/b.txt`, data: 'B', checksum: 'bad' },
  ]) },
  { id: 'cksum-blank', tar: buildTar([{ name: `${TOP}/a.txt`, data: 'A', checksum: 'blank' }]) },
  { id: 'cksum-bad-on-longlink', tar: buildTar([
    { name: '././@LongLink', type: 'L', data: `${TOP}/x.txt\0`, checksum: 'bad' },
    { name: `${TOP}/truncated`, data: 'A' },
  ]) },
]

/** path traversal。`../` と絶対パスと prefix 経由 */
export const traversalCases = () => [
  { id: 'trav-dotdot', tar: buildTar([{ name: `${TOP}/../evil.txt`, data: 'E' }]) },
  { id: 'trav-deep-dotdot', tar: buildTar([{ name: `${TOP}/a/../../../../evil.txt`, data: 'E' }]) },
  { id: 'trav-absolute', tar: buildTar([{ name: '/etc/passwd', data: 'E' }]) },
  { id: 'trav-prefix-field', tar: buildTar([{ name: 'evil.txt', prefix: `${TOP}/..`, data: 'E' }]) },
  { id: 'trav-backslash', tar: buildTar([{ name: `${TOP}/..\\evil.txt`, data: 'E' }]) },
]

/** symlink / hardlink。**リンクをファイルとして扱ったら負け** */
export const linkCases = () => [
  { id: 'link-symlink-rel', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/link.txt`, type: '2', linkname: 'a.txt' },
  ]) },
  { id: 'link-symlink-escape', tar: buildTar([
    { name: `${TOP}/link.txt`, type: '2', linkname: '../../../etc/passwd' },
  ]) },
  { id: 'link-symlink-absolute', tar: buildTar([
    { name: `${TOP}/link.txt`, type: '2', linkname: '/etc/passwd' },
  ]) },
  { id: 'link-hardlink', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/hard.txt`, type: '1', linkname: `${TOP}/a.txt` },
  ]) },
]

/** 資源上限を超える入力 */
export const resourceCases = () => [
  { id: 'res-many-entries', tar: buildTar(
    Array.from({ length: 20000 }, (_, i) => ({ name: `${TOP}/f${i}.txt`, data: 'x' })),
  ) },
  { id: 'res-huge-entry', tar: buildTar([{ name: `${TOP}/big.bin`, data: Buffer.alloc(12 << 20, 0x41) }]) },
  /**
   * **長いパスは USTAR の name 欄（100 バイト）に入らない。**
   * 素の header に書くと切り捨てられて短いパスになり、上限を試験できない
   * （2026-08-06 に実測して気づいた）。GNU long name 経由で渡す。
   */
  { id: 'res-long-path', tar: buildTar([
    { name: '././@LongLink', type: 'L', data: `${TOP}/${'a/'.repeat(3000)}f.txt\0` },
    { name: `${TOP}/truncated`, data: 'x' },
  ]) },
  { id: 'res-size-overflow', tar: buildTar([{ name: `${TOP}/a.txt`, declaredSize: 0o77777777777, data: 'A' }]) },
]

/** 全部まとめて。**種類ごとに 4 個以上あることを test 側で確かめる** */
export const allCases = () => ({
  pax: paxCases(),
  longName: longNameCases(),
  checksum: checksumCases(),
  traversal: traversalCases(),
  link: linkCases(),
  resource: resourceCases(),
  entryType: entryTypeCases(),
  encoding: encodingCases(),
})
