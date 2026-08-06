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
  ]
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
  { id: 'res-long-path', tar: buildTar([{ name: `${TOP}/${'a/'.repeat(3000)}f.txt`, data: 'x' }]) },
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
})
