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
  /**
   * **magic + version を丸ごと差し替えられるようにする（v0.6.9・外部監査 P0-A）。**
   * 既定は POSIX ustar（`ustar\0` + `00`）。old GNU は `ustar␠␠\0`、V7 は全 NUL。
   * ここを固定していたので、**形式ごとの読み分けを一度も試験していなかった。**
   */
  if (o.magic8) pad(o.magic8, 8).copy(h, 257)
  else { pad('ustar', 6).copy(h, 257); pad('00', 2).copy(h, 263) }
  pad(o.uname ?? '', 32).copy(h, 265)
  pad(o.gname ?? '', 32).copy(h, 297)
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

/**
 * PAX レコード 1 本を作る。形式は `"<全長> <鍵>=<値>\n"` で **`<全長>` は自身を含む。**
 * 長さが自分自身に依存するので、収束するまで回す（手計算で書くと 10 進の桁上がりで間違える）。
 */
export function paxRec(key, value) {
  const tail = Buffer.concat([
    Buffer.from(` ${key}=`, 'utf8'),
    Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'),
    Buffer.from('\n'),
  ])
  let len = tail.length + 1
  while (String(len).length + tail.length !== len) len = String(len).length + tail.length
  return Buffer.concat([Buffer.from(String(len)), tail])
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
  /** 値に生バイト（NUL 等）を入れる版。**長さはバイトで数える** */
  const recBuf = (k, vBuf) => {
    const body = Buffer.concat([Buffer.from(` ${k}=`), vBuf, Buffer.from('\n')])
    const len = String(body.length + String(body.length + 2).length).length + body.length
    return Buffer.concat([Buffer.from(String(len)), body])
  }
  return [
    /**
     * **レコードが改行で終わっていない（v0.6.15・外部監査 P1-C）。**
     * catalog に `PAX_RECORD_INVALID` は在ったのに材料が無かった。
     */
    { id: 'pax-record-no-newline', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a.txt`, type: 'x', data: '10 bad-record\n' },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
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
    /**
     * **PAX の可変長テキストに NUL（v0.6.5・外部監査 P0-3）。**
     * PAX はレコードを長さで区切るので、NUL は詰め物ではなく値の一部である。
     * 実測: 検算 v9 は NUL 以降を捨てて OK ／ bsdtar も切り捨て ／ python は展開に失敗。
     */
    { id: 'pax-path-with-nul', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a.txt`, type: 'x', data: recBuf('path', Buffer.concat([Buffer.from(`${TOP}/a.ts`), Buffer.from([0]), Buffer.from('evil')])) },
      { name: `${TOP}/raw.txt`, data: 'A' },
    ]) },
    /**
     * **denylist は閉じていない（v0.6.5・外部監査 P0-4）。**
     * 実測: 検算 v9 は未知の鍵として無視して OK ／ **bsdtar は Parse error で archive ごと拒否** ／
     * python は展開できる。**3 者で結末が割れる。**数え上げでは閉じないので allowlist にした。
     */
    { id: 'pax-sun-holesdata', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a.txt`, type: 'x', data: rec('SUN.holesdata', '0 4 4 4') },
      { name: `${TOP}/a.txt`, data: 'AAAABBBB' },
    ]) },
    /** 未知の vendor 鍵は既定で拒む */
    { id: 'pax-unknown-vendor-key', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a.txt`, type: 'x', data: rec('ACME.magic', 'x') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    /**
     * **通す鍵でも、値が読めなければ止める（v0.6.6・外部監査 P0-2）。**
     *
     * v0.6.5 は**鍵の名前だけ**を見ていた。実測（監査）:
     * **GNU tar は `Malformed extended header` で exit 2**、
     * bsdtar・BusyBox・python は通す——**実装間で割れる。**
     * 「view を変えない鍵だから通す」という理屈は、値が読める前提に乗っている。
     */
    { id: 'pax-uid-not-a-number', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a.txt`, type: 'x', data: rec('uid', 'abc') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    { id: 'pax-mtime-not-a-number', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a.txt`, type: 'x', data: rec('mtime', 'abc') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    { id: 'pax-atime-nan', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a.txt`, type: 'x', data: rec('atime', 'nan') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    { id: 'pax-ctime-exponent', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a.txt`, type: 'x', data: rec('ctime', '1e999') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    /**
     * **`linkpath` は通す（v0.6.6・外部監査 P1）。**
     * v0.6.5 は allowlist に無い鍵として拒んでいたが、**4 実装すべてが展開できる**。
     * リンクの指す先は `files` に入らないので view は変わらない。
     * ただし **hardlink の指す先の検査には使う**ので、解釈して覚える。
     */
    { id: 'pax-linkpath-long', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/l`, type: 'x', data: rec('linkpath', `${TOP}/${'ll/'.repeat(45)}target.txt`) },
      { name: `${TOP}/link`, type: '2', linkname: 'short' },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    /** `linkpath` で hardlink の指す先を存在しない場所へ上書きする形は止める */
    { id: 'pax-linkpath-dangling-hardlink', tar: buildTar([
      { name: `${TOP}/a.txt`, data: 'A' },
      { name: `${TOP}/PaxHeaders/0/h`, type: 'x', data: rec('linkpath', `${TOP}/nope.txt`) },
      { name: `${TOP}/hard`, type: '1', linkname: `${TOP}/a.txt` },
    ]) },
    /**
     * **独立した 2 つの member が、それぞれ 1 回ずつ上書きを使う（v0.6.5・外部監査 P1）。**
     * **これは正当な archive で、止めてはいけない。**v0.6.4 は上書きの出所を
     * member 消費時に戻し忘れており、2 件目を「二重の上書き」として拒んでいた。
     * 実測: bsdtar・python はどちらも 2 件とも展開する。
     */
    { id: 'pax-two-independent-paths', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec('path', `${TOP}/one.txt`) },
      { name: 'ignored1', data: 'ONE' },
      { name: `${TOP}/PaxHeaders/0/b`, type: 'x', data: rec('path', `${TOP}/two.txt`) },
      { name: 'ignored2', data: 'TWO' },
    ]) },
    /** global header が名前を上書きする形。実物の `pax_global_header` は `comment` だけ */
    { id: 'pax-g-path-override', tar: buildTar([
      { name: 'pax_global_header', type: 'g', data: rec('path', `${TOP}/from-global.txt`) },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },

    // -----------------------------------------------------------------------
    // v0.6.7（外部監査 2026-08-10・P0-B / P0-C / P1-A）
    // -----------------------------------------------------------------------
    /**
     * **global の `linkpath`（P0-B）。**v0.6.6 は受け取って**黙って無視**していた。
     * 実測（2026-08-10）: bsdtar は header の指す先、python は global の指す先を採る
     * ——**同じ archive から別の木ができる。**
     */
    { id: 'pax-g-linkpath-override', tar: buildTar([
      { name: 'pax_global_header', type: 'g', data: rec('linkpath', `${TOP}/t2.txt`) },
      { name: `${TOP}/t1.txt`, data: '1' },
      { name: `${TOP}/t2.txt`, data: '2' },
      { name: `${TOP}/link`, type: '2', linkname: `${TOP}/t1.txt` },
    ]) },
    /** `linkpath` を 2 回。実測: bsdtar は exit 1（malformed pax）・python は 1 つ目を採る */
    { id: 'pax-linkpath-twice', tar: buildTar([
      { name: `${TOP}/a.txt`, data: 'A' },
      { name: `${TOP}/PaxHeaders/0/l`, type: 'x', data: rec('linkpath', `${TOP}/one`) },
      { name: `${TOP}/PaxHeaders/0/l`, type: 'x', data: rec('linkpath', `${TOP}/two`) },
      { name: `${TOP}/link`, type: '2', linkname: 'short' },
    ]) },
    /**
     * **PAX `linkpath` と GNU `K` が同じ member に効く形（P0-B）。**
     * **手元の 2 実装（bsdtar / python）は一致して通す**（どちらも先に来たほうを採る）。
     * 監査は GNU tar 1.35 と BusyBox で結末が分かれると報告している——
     * **その割れ方はこちらでは再現していない。**名前の上書きと同じ規則を当てて止める。
     */
    { id: 'pax-linkpath-then-gnu-K', tar: buildTar([
      { name: `${TOP}/a.txt`, data: 'A' },
      { name: `${TOP}/PaxHeaders/0/l`, type: 'x', data: rec('linkpath', `${TOP}/pax-target`) },
      { name: '././@LongLink', type: 'K', data: `${TOP}/gnu-target\0` },
      { name: `${TOP}/link`, type: '2', linkname: 'short' },
    ]) },
    { id: 'pax-gnu-K-then-linkpath', tar: buildTar([
      { name: `${TOP}/a.txt`, data: 'A' },
      { name: '././@LongLink', type: 'K', data: `${TOP}/gnu-target\0` },
      { name: `${TOP}/PaxHeaders/0/l`, type: 'x', data: rec('linkpath', `${TOP}/pax-target`) },
      { name: `${TOP}/link`, type: '2', linkname: 'short' },
    ]) },
    /**
     * **上書きのあとに entry が無いまま終わる（P0-B）。**名前の側は v0.6.5 で塞いだが、
     * 指す先の側には終端検査が無かった。実測: bsdtar `Damaged tar archive` / python `ReadError`
     */
    { id: 'pax-linkpath-no-following-entry', tar: buildTar([
      { name: `${TOP}/a.txt`, data: 'A' },
      { name: `${TOP}/PaxHeaders/0/l`, type: 'x', data: rec('linkpath', `${TOP}/nowhere`) },
    ]) },
    /**
     * **`uname` / `gname` が不正 UTF-8（P0-C）。**実測（2026-08-10）:
     * **bsdtar 3.5.3 は exit 1**（`Uname can't be converted from UTF-8 to current locale.`）、
     * python は通す——割れる。
     */
    { id: 'pax-uname-invalid-utf8', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: recBuf('uname', Buffer.from([0xff, 0xfe, 0x41])) },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    { id: 'pax-gname-invalid-utf8', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: recBuf('gname', Buffer.from([0xff, 0xfe, 0x41])) },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    /**
     * **止めてはいけないもの（実測で割れなかった）。**
     * `uname` の NUL と `comment` の不正 UTF-8 は、**bsdtar も python も exit 0**（実測）。
     * 監査はどちらも strict text にすることを勧めているが、**割れないので従っていない。**
     * ここに材料を置いて、あとから理由なく厳しくしたら落ちるようにする。
     */
    { id: 'pax-uname-nul-inside', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: recBuf('uname', Buffer.from('ab\0cd', 'binary')) },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    { id: 'pax-comment-invalid-utf8', tar: buildTar([
      { name: 'pax_global_header', type: 'g', data: recBuf('comment', Buffer.from([0xff, 0xfe, 0x41])) },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    /**
     * **負の時刻（P1-A・こちらの過剰拒否）。**GNU tar は 1970 年より前の mtime を
     * `mtime=-1` として**ふつうに書く。**v0.6.6 は「数値として読めない」と拒んでいた。
     * 実測（2026-08-10）: bsdtar・python とも exit 0。
     */
    { id: 'pax-mtime-negative', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec('mtime', '-1') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    { id: 'pax-mtime-negative-fraction', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec('mtime', '-1.5') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    /** 上限のすぐ内側。**塞ぎすぎていないことの対照**（実測: 両実装 exit 0） */
    { id: 'pax-mtime-large-within-range', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec('mtime', '281474976710655') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    { id: 'pax-uid-32bit-max', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec('uid', '4294967295') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    /**
     * **先頭の `+` は POSIX の書式に無い。**実測では bsdtar も python も通すので、
     * **これは実測ではなく書式にもとづく判断である。**
     */
    { id: 'pax-mtime-plus-sign', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec('mtime', '+1') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    /** int64 の上限。実測: bsdtar exit 0 ／ **python は OverflowError で exit 2** */
    { id: 'pax-mtime-above-int64', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec('mtime', '9223372036854775807') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    /**
     * **uid / gid が 32bit を超える。**実測では**手元の 2 実装とも通す**（2^64 でも通す）。
     * 監査の GNU tar 1.35 が `is out of range 0..4294967295` で拒む、という報告にもとづく。
     * **こちらでは再現していない。**
     */
    { id: 'pax-uid-above-32bit', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec('uid', '9'.repeat(100)) },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    // ---- v0.6.8（外部監査 2026-08-11）------------------------------------
    /**
     * **鍵に関係なく、`x` のあとに member が無いまま終わる形（P0-B）。**
     * v0.6.7 は `path` / `linkpath` を持つ `x` しか見ていなかった。実測（2026-08-11）:
     * 検算 v12 は READ ／ bsdtar exit 1（Damaged tar archive）／ python exit 2（ReadError）
     */
    { id: 'pax-dangling-metadata-only', tar: buildTar([
      { name: `${TOP}/a.txt`, data: 'A' },
      { name: `${TOP}/PaxHeaders/0/x`, type: 'x', data: rec('mtime', '1') },
    ]) },
    /** 対照: metadata だけの `x` + 正常な member は**通す**（実測: 2 実装とも通る） */
    { id: 'pax-metadata-then-member', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec('mtime', '1') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    /** `x` が 2 つ続く形。実測: bsdtar は exit 1（malformed pax）／ python は通す＝割れる */
    { id: 'pax-two-local-x', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec('mtime', '1') },
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec('uid', '1') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    /**
     * **directory の PAX path が / で終わる形は通す（P1-A・こちらの過剰拒否）。**
     * 実測: bsdtar も python も同じ木を作る。v0.6.7 は「空のパス要素がある」で落としていた。
     */
    { id: 'pax-dir-trailing-slash', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/d`, type: 'x', data: rec('path', `${TOP}/${'v'.repeat(120)}/`) },
      { name: `${TOP}/truncated/`, type: '5', mode: 0o755 },
      { name: `${TOP}/${'v'.repeat(120)}/a.txt`, data: 'A' },
    ]) },
    /** 通常ファイルが / で終わる形は止める。実測: bsdtar は directory・python は通常ファイル＝割れる */
    { id: 'pax-regular-trailing-slash', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/f`, type: 'x', data: rec('path', `${TOP}/${'v'.repeat(120)}/`) },
      { name: `${TOP}/truncated`, data: 'A' },
    ]) },
    /**
     * symlink が / で終わる形。**2 実装とも同じ symlink を作る**ので通す（v0.6.9 で `safe` へ）。
     * v0.6.8 は「directory 以外は全部拒む」で、**実測を追い越した過剰拒否**だった。
     */
    { id: 'pax-symlink-trailing-slash', tar: buildTar([
      { name: `${TOP}/t.txt`, data: 'T' },
      { name: `${TOP}/PaxHeaders/0/l`, type: 'x', data: rec('path', `${TOP}/${'v'.repeat(120)}/`) },
      { name: `${TOP}/truncated`, type: '2', linkname: 't.txt' },
    ]) },
    { id: 'pax-hardlink-trailing-slash', tar: buildTar([
      { name: `${TOP}/t.txt`, data: 'T' },
      { name: `${TOP}/PaxHeaders/0/h`, type: 'x', data: rec('path', `${TOP}/${'v'.repeat(120)}/`) },
      { name: `${TOP}/truncated`, type: '1', linkname: `${TOP}/t.txt` },
    ]) },
    /**
     * **長さ 0 の PAX 値（v0.6.9・外部監査 P0-C）。**
     *
     * `path=` は POSIX では「上書きを消す」だが、実測（2026-08-11）で**実装が割れる**:
     * bsdtar は生ヘッダの名前へ戻して展開し、python は空の名前として `IsADirectoryError`。
     * v0.6.8 は空文字を名前として採り、**member を丸ごと落として `status OK` と言っていた。**
     */
    { id: 'pax-zero-length-path', tar: buildTar([
      { name: `${TOP}/a.txt`, data: 'A' },
      { name: `${TOP}/PaxHeaders/0/r`, type: 'x', data: rec('path', '') },
      { name: `${TOP}/raw.txt`, data: 'R' },
    ]) },
    { id: 'pax-zero-length-linkpath', tar: buildTar([
      { name: `${TOP}/a.txt`, data: 'A' },
      { name: `${TOP}/PaxHeaders/0/l`, type: 'x', data: rec('linkpath', '') },
      { name: `${TOP}/l`, type: '2', linkname: `${TOP}/a.txt` },
    ]) },
    /**
     * **それ以外の鍵の長さ 0 は通す。**実測: 2 実装とも同じ木を作るのに v0.6.8 は拒んでいた
     * ——**監査が挙げていない過剰拒否 2 件**（値の綴り検査を長さ 0 にも掛けていた）。
     */
    { id: 'pax-zero-length-mtime', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec('mtime', '') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    { id: 'pax-zero-length-uid', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec('uid', '') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    /**
     * **同一ヘッダ内の重複鍵は後勝ち（v0.6.9・外部監査 P1-A）。**
     * POSIX の定めどおりで、実測でも 6 鍵すべて 2 実装が一致して後の値を採る。
     * v0.6.8 はここを拒んでいた（過剰拒否）。**別のヘッダをまたぐ競合は今までどおり止める。**
     */
    { id: 'pax-duplicate-path-same-header', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec('path', `${TOP}/one.txt`) + rec('path', `${TOP}/two.txt`) },
      { name: `${TOP}/ignored.txt`, data: 'D' },
    ]) },
    { id: 'pax-duplicate-mtime-same-header', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec('mtime', '1') + rec('mtime', '2') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    /**
     * **`mtime=1.` は通す（v0.6.10・外部監査 P1）。**実測: 2 実装とも受理して同じ木。
     * POSIX は小数点のあとに数字が無い形を禁じていない。
     */
    { id: 'pax-mtime-trailing-dot', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec('mtime', '1.') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    { id: 'pax-mtime-negative-trailing-dot', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec('mtime', '-1.') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    /** 小数点だけ・数字が先に無い形は今までどおり止める（塞ぎすぎの対照） */
    { id: 'pax-mtime-leading-dot', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec('mtime', '.5') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    { id: 'pax-duplicate-linkpath-same-header', tar: buildTar([
      { name: `${TOP}/a.txt`, data: 'A' },
      { name: `${TOP}/b.txt`, data: 'B' },
      { name: `${TOP}/PaxHeaders/0/l`, type: 'x', data: rec('linkpath', `${TOP}/a.txt`) + rec('linkpath', `${TOP}/b.txt`) },
      { name: `${TOP}/l`, type: '2', linkname: `${TOP}/a.txt` },
    ]) },
    /**
     * **先頭ゼロは通す（P1-B・こちらの過剰拒否）。**
     * v0.6.7 は「正規の綴り」まで要求していた。実測: 2 実装とも通る。
     * **前回の監査の勧告どおりに書いた正規表現が、そのまま過剰拒否になった。**
     */
    { id: 'pax-uid-leading-zero', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec('uid', '0001') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    { id: 'pax-gid-leading-zero', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec('gid', '0001') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    { id: 'pax-mtime-leading-zero', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec('mtime', '01') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    { id: 'pax-mtime-neg-leading-zero', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec('mtime', '-01') },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]) },
    { id: 'pax-gid-above-32bit', tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec('gid', '4294967296') },
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
  { id: 'symlink-under-scope', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/src/model/link.ts`, type: '2', linkname: 'a.txt' },
  ]) },
  { id: 'hardlink-under-scope', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/src/model/hl.ts`, type: '1', linkname: `${TOP}/a.txt` },
  ]) },
  /**
   * **知らない型は素通りしていた（v0.6.9・外部監査 P0-B）。**
   *
   * v0.6.8 までの検査は `7`/`S`/`D`/`M`/`N` を並べた**除外表**だったので、
   * 表に無い型は `files` に入らないまま `inventory` にだけ載って通っていた。実測（2026-08-11）:
   *
   * ```
   * typeflag Z / 空白（本体 5 バイト）を 32 入力の source へ足す
   *   検算 v13  status OK ／ 32 of 32 ／ files 85・inventory 86
   *   bsdtar    exit 0 — 5 バイトの通常ファイルを作る
   *   python    同じ
   * ```
   *
   * **範囲の外（`docs/` の下）に置くと、未記録入力の探索にも掛からない。**
   */
  { id: 'typeflag-Z-unknown', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/docs/unknown-Z.bin`, type: 'Z', data: 'ZDATA' },
  ]) },
  { id: 'typeflag-space-unknown', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/docs/unknown-space.bin`, type: ' ', data: 'SDATA' },
  ]) },
  { id: 'typeflag-lowercase-vendor', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/docs/vendor.bin`, type: 'z', data: 'VDATA' },
  ]) },
  /**
   * device と FIFO。**中身を持つファイルではない**ので許可表に載せない。
   * 実測（2026-08-11）: device は 2 実装とも作れず（権限）、FIFO は 2 実装とも作る。
   * **FIFO を作る**ことが分かったので、木を歩く試験の側も直した
   * （`readFileSync` が書き手を待って**永久に止まる**——例外ではないので try では捕まらない）。
   */
  { id: 'typeflag-3-chardev', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/docs/dev0`, type: '3' },
  ]) },
  { id: 'typeflag-6-fifo', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/docs/fifo0`, type: '6' },
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
    { id: 'gnu-L-normal', tar: buildTar([
      { name: '././@LongLink', type: 'L', data: `${long(60)}\0` },
      { name: `${TOP}/truncated`, data: 'A' },
    ]) },
    /**
     * **独立した 2 つの member が、それぞれ長い名前を 1 回ずつ使う（v0.6.5・外部監査 P1）。**
     * **これは正当な archive で、止めてはいけない。**v0.6.4 は `longNameFrom` を
     * member 消費時に戻し忘れており、2 件目を「二重の上書き」として拒んでいた。
     * 実測: bsdtar・python はどちらも 2 件とも展開する。
     *
     * **この repo の実物では踏まない**（最長パス 95 文字で long name 機構を使わない）。
     * 「実物が通る」だけでは、過剰拒否は見つけられない。
     */
    { id: 'gnu-L-two-independent', tar: buildTar([
      { name: '././@LongLink', type: 'L', data: `${TOP}/${'d1/'.repeat(40)}file1.txt\0` },
      { name: 'ignored1', data: 'ONE' },
      { name: '././@LongLink', type: 'L', data: `${TOP}/${'d2/'.repeat(40)}file2.txt\0` },
      { name: 'ignored2', data: 'TWO' },
    ]) },
    { id: 'gnu-L-very-long', tar: buildTar([
      { name: '././@LongLink', type: 'L', data: `${TOP}/${'x'.repeat(9000)}\0` },
      { name: `${TOP}/truncated`, data: 'A' },
    ]) },
    { id: 'gnu-L-size-lie', tar: buildTar([
      { name: '././@LongLink', type: 'L', declaredSize: 1 << 20, data: `${long(3)}\0` },
      { name: `${TOP}/truncated`, data: 'A' },
    ]) },
    /** **directory の長い名前が / で終わる形は通す（v0.6.8・P1-A）。**実測: 2 実装とも同じ木 */
    { id: 'gnu-L-dir-trailing-slash', tar: buildTar([
      { name: '././@LongLink', type: 'L', data: `${TOP}/${'v'.repeat(120)}/\0` },
      { name: `${TOP}/truncated`, type: '5', mode: 0o755 },
      { name: `${TOP}/${'v'.repeat(120)}/a.txt`, data: 'A' },
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

/**
 * **パスの綴り（v0.6.15・外部監査 P1-C）。**
 *
 * v0.6.14 の catalog には 55 種類の止め方が載っていたが、
 * **corpus が踏むのは 37 種類**だった。監査が「残りのうち 10 種類は
 * 外から作った archive で普通に踏める」と反例つきで指摘し、
 * こちらで 11/12 件を再現できた（2026-08-14）。
 *
 * ここはそのうちパスの綴りに関する 5 件。**どれも実装が受け入れる形**で、
 * 止めているのはこの道具の方針である
 * ——同じ場所を別の綴りで指せると、記録との突き合わせが意味を失うため。
 */
export const pathSpellingCases = () => [
  { id: 'spell-drive-letter', tar: buildTar([{ name: 'C:evil.txt', data: 'E' }]) },
  { id: 'spell-dot-component', tar: buildTar([{ name: `${TOP}/./evil.txt`, data: 'E' }]) },
  { id: 'spell-double-slash', tar: buildTar([{ name: `${TOP}//evil.txt`, data: 'E' }]) },
  { id: 'spell-leading-space', tar: buildTar([{ name: `${TOP}/ evil.txt`, data: 'E' }]) },
  { id: 'spell-control-char', tar: buildTar([{ name: `${TOP}/evil\u0001.txt`, data: 'E' }]) },
]

/** symlink / hardlink。**リンクをファイルとして扱ったら負け** */
export const linkCases = () => [
  /**
   * **リンクの指す先そのものが壊れている 2 件（v0.6.15・外部監査 P1-C）。**
   * catalog に `LINK_TARGET_EMPTY` / `LINK_TARGET_NOT_A_PATH` は在ったのに、
   * **corpus には材料が無く、一度も踏まれていなかった。**
   */
  { id: 'link-hardlink-empty-target', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/link`, type: '1', linkname: '' },
  ]) },
  { id: 'link-hardlink-dot-target', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/link`, type: '1', linkname: '.' },
  ]) },
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

  /**
   * **受理する archive は展開できなければならない（v0.6.5・外部監査 P0-2）。**
   *
   * hardlink は同じ archive の先行 member を指す。指す先が無ければ展開は失敗する。
   * v0.6.4 はリンクを「ファイルとして扱わない」だけで、**指す先を見ていなかった。**
   * 実測: 検算 status OK / 2 件中 2 件一致 ／ bsdtar exit 1 ／ python KeyError。
   *
   * **展開できない archive を受理すると、差分試験がそれを「比べようがない＝合格」と数える。**
   * つまり、ここが見えないファイルを混ぜる足場になる。
   */
  { id: 'link-hardlink-missing-target', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/src/model/b.ts`, data: 'B' },
    { name: `${TOP}/dangling.txt`, type: '1', linkname: `${TOP}/nope.txt` },
  ]) },
  /** 先行していない member を指す形（tar は後方参照しか許さない） */
  { id: 'link-hardlink-forward-reference', tar: buildTar([
    { name: `${TOP}/hard.txt`, type: '1', linkname: `${TOP}/later.txt` },
    { name: `${TOP}/later.txt`, data: 'L' },
  ]) },

  /**
   * **自分自身を指す hardlink（v0.6.6・外部監査 P0-1）。**
   *
   * v0.6.5 は**この entry の名前を先に `seenPaths` へ入れていた**ので、
   * 自分を指すリンクが「指す先が在る」と判定されていた。実測:
   * 検算 v10 は status OK ／ bsdtar は `Skipping hardlink pointing to itself` で exit 1 ／
   * python は KeyError ／ 監査側の GNU tar は exit 2。
   */
  { id: 'link-hardlink-self-reference', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/self`, type: '1', linkname: `${TOP}/self` },
  ]) },
  /**
   * **ディレクトリを指す hardlink（v0.6.6・外部監査 P0-1）。**
   * v0.6.5 は「名前が在るか」しか見ていなかった。hardlink は通常ファイルにしか張れない。
   * 実測: 検算 v10 は status OK ／ bsdtar は `Operation not permitted` で exit 1。
   */
  { id: 'link-hardlink-to-directory', tar: buildTar([
    { name: `${TOP}/`, type: '5', mode: 0o755 },
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/hdir`, type: '1', linkname: TOP },
  ]) },
  /**
   * **GNU の長い linkname（`K`）は通す（v0.6.6・外部監査 P1）。**
   *
   * v0.6.5 は `K` の分岐が無く、**`K` ヘッダ自身の名前 `././@LongLink` が
   * 正規化検査に当たって `ARCHIVE_INVALID`** になっていた。
   * **4 実装すべてが展開できる**正当な形なので、こちらの過剰拒否だった。
   */
  { id: 'link-gnu-longlink', tar: buildTar([
    { name: `${TOP}/target.txt`, data: 'T' },
    { name: '././@LongLink', type: 'K', data: `${TOP}/${'ll/'.repeat(45)}target.txt\0` },
    { name: `${TOP}/link`, type: '2', linkname: 'short' },
  ]) },

  // -------------------------------------------------------------------------
  // v0.6.7（外部監査 2026-08-10・P0-B / P1-B）
  // -------------------------------------------------------------------------
  /**
   * **hardlink の連鎖（P1-B・こちらの過剰拒否）。**
   * `A`（通常）→ `B -> A` → `C -> B`。実測（2026-08-10）:
   * bsdtar・python とも exit 0 で `nlink=3` の 3 本ができる。v0.6.6 は拒んでいた。
   */
  { id: 'link-hardlink-chain', tar: buildTar([
    { name: `${TOP}/A.txt`, data: 'AAA' },
    { name: `${TOP}/B.txt`, type: '1', linkname: `${TOP}/A.txt` },
    { name: `${TOP}/C.txt`, type: '1', linkname: `${TOP}/B.txt` },
  ]) },
  /** 連鎖を PAX `linkpath` で書いた版 */
  { id: 'link-hardlink-pax-chain', tar: buildTar([
    { name: `${TOP}/A.txt`, data: 'AAA' },
    { name: `${TOP}/B.txt`, type: '1', linkname: `${TOP}/A.txt` },
    { name: `${TOP}/PaxHeaders/0/C`, type: 'x', data: paxRec('linkpath', `${TOP}/B.txt`) },
    { name: `${TOP}/C.txt`, type: '1', linkname: 'short' },
  ]) },
  /**
   * **同じ場所の別の綴り（P1-B）。**`.` と空要素は両実装が畳んで展開する（実測）ので通す。
   * **`..` と末尾スラッシュは畳まない**——下の 2 件がその実測にあたる。
   */
  { id: 'link-hardlink-dot-alias', tar: buildTar([
    { name: `${TOP}/A.txt`, data: 'AAA' },
    { name: `${TOP}/B.txt`, type: '1', linkname: `${TOP}/./A.txt` },
  ]) },
  { id: 'link-hardlink-leading-dot-alias', tar: buildTar([
    { name: `${TOP}/A.txt`, data: 'AAA' },
    { name: `${TOP}/B.txt`, type: '1', linkname: `./${TOP}/A.txt` },
  ]) },
  { id: 'link-hardlink-double-slash-alias', tar: buildTar([
    { name: `${TOP}/A.txt`, data: 'AAA' },
    { name: `${TOP}/B.txt`, type: '1', linkname: `${TOP}//A.txt` },
  ]) },
  /**
   * **これは監査の指摘ではなく、こちらの実測で見つけた false-OK。**
   *
   * v0.6.6 は指す先の末尾スラッシュを `.replace(/\/+$/, '')` で剥がしてから照合していた。
   * 実測（2026-08-10）: **検算 v11 は READ ／ bsdtar は exit 1**
   * （`Can't create '...': Not a directory`）。**受理したのに展開できない。**
   */
  { id: 'link-hardlink-target-trailing-slash', tar: buildTar([
    { name: `${TOP}/A.txt`, data: 'AAA' },
    { name: `${TOP}/B.txt`, type: '1', linkname: `${TOP}/A.txt/` },
  ]) },
  /** `..` は畳まない。実測: bsdtar は `Path contains '..'` で exit 1 ／ python は通す＝割れる */
  { id: 'link-hardlink-target-dotdot', tar: buildTar([
    { name: `${TOP}/sub/`, type: '5', mode: 0o755 },
    { name: `${TOP}/A.txt`, data: 'AAA' },
    { name: `${TOP}/B.txt`, type: '1', linkname: `${TOP}/sub/../A.txt` },
  ]) },
  /** 互いに指し合う形。**先行 member にしか張れない**ので「指す先が無い」で止まる */
  { id: 'link-hardlink-cycle', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/B.txt`, type: '1', linkname: `${TOP}/C.txt` },
    { name: `${TOP}/C.txt`, type: '1', linkname: `${TOP}/B.txt` },
  ]) },
  /**
   * **`K` と `L` が同じ member に効くのは正当（GNU 形式で長い名前と長い指す先を持つ entry）。**
   * 名前の上書きと指す先の上書きは**別の機構**なので、二重の上書きにはならない。
   * ここに置いて、状態機械を足したときに**まとめて拒まないこと**を固定する。
   */
  { id: 'link-gnu-K-and-L-together', tar: buildTar([
    { name: `${TOP}/target.txt`, data: 'T' },
    { name: '././@LongLink', type: 'K', data: `${TOP}/${'ll/'.repeat(45)}target.txt\0` },
    { name: '././@LongLink', type: 'L', data: `${TOP}/${'nn/'.repeat(45)}link\0` },
    { name: `${TOP}/truncated`, type: '2', linkname: 'short' },
  ]) },
  /** `K` のあとに entry が無いまま終わる。実測: bsdtar `Damaged tar archive` / python `ReadError` */
  { id: 'link-gnu-K-no-following-entry', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: '././@LongLink', type: 'K', data: `${TOP}/nowhere\0` },
  ]) },
]

/**
 * **祖先の型（v0.6.7・外部監査 P0-A）。**
 *
 * v0.6.6 は entry を 1 つずつしか見ておらず、**entry どうしの関係**を見ていなかった。
 * 通常ファイルや symlink の下に entry があっても `status OK` を返していた。
 * 実測（2026-08-10・こちらの 2 実装で再現）:
 *
 * ```
 * regular root/src ／ regular root/src/model/a.ts
 *   検算 v11  READ（files に src と src/model/a.ts の両方）
 *   bsdtar    exit 1 — Not a directory ／ python exit 2 — NotADirectoryError
 * ```
 *
 * **v0.6.5 で塞いだ「先頭 1 階層が directory か」の一般形である。**
 * 先頭だけ見ていたので、途中の階層で同じことが起きていた。
 */
export const ancestorCases = () => [
  { id: 'ancestor-regular-then-child', tar: buildTar([
    { name: `${TOP}/source-input-scope.v1.json`, data: '{}' },
    { name: `${TOP}/src`, data: 'I AM A FILE' },
    { name: `${TOP}/src/model/a.ts`, data: 'A' },
  ]) },
  { id: 'ancestor-symlink-then-child', tar: buildTar([
    { name: `${TOP}/source-input-scope.v1.json`, data: '{}' },
    { name: `${TOP}/src`, type: '2', linkname: 'elsewhere' },
    { name: `${TOP}/src/model/a.ts`, data: 'A' },
  ]) },
  { id: 'ancestor-hardlink-then-child', tar: buildTar([
    { name: `${TOP}/f.txt`, data: 'F' },
    { name: `${TOP}/src`, type: '1', linkname: `${TOP}/f.txt` },
    { name: `${TOP}/src/model/a.ts`, data: 'A' },
  ]) },
  /** 逆順。**片方だけ見ると、もう片方から入られる** */
  { id: 'ancestor-child-then-regular', tar: buildTar([
    { name: `${TOP}/src/model/a.ts`, data: 'A' },
    { name: `${TOP}/src`, data: 'I AM A FILE' },
  ]) },
  { id: 'ancestor-child-then-symlink', tar: buildTar([
    { name: `${TOP}/src/model/a.ts`, data: 'A' },
    { name: `${TOP}/src`, type: '2', linkname: 'elsewhere' },
  ]) },
  /** **正当な木は通す。**explicit（GitHub の tarball）と implicit（親 entry が無い）の両方 */
  { id: 'ancestor-explicit-dir-tree', tar: buildTar([
    { name: `${TOP}/`, type: '5', mode: 0o755 },
    { name: `${TOP}/src/`, type: '5', mode: 0o755 },
    { name: `${TOP}/src/model/`, type: '5', mode: 0o755 },
    { name: `${TOP}/src/model/a.ts`, data: 'A' },
  ]) },
  { id: 'ancestor-implicit-dir-tree', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/src/model/a.ts`, data: 'A' },
  ]) },
  /** **リンクが葉なら正当。**下に entry が無ければ木は作れる（実測: 両実装 exit 0） */
  { id: 'ancestor-symlink-leaf-only', tar: buildTar([
    { name: `${TOP}/src/real.ts`, data: 'R' },
    { name: `${TOP}/src/link.ts`, type: '2', linkname: 'real.ts' },
  ]) },
]

/**
 * **中身を持てない型に本体がある（v0.6.6・外部監査 P0-3）。**
 *
 * ディレクトリ・リンク・デバイスは中身を持たない。`size` が 0 でないと、
 * **読み手がその本体を読み飛ばすかどうかで、その先の解釈が丸ごとずれる。**
 * 実測（監査）: GNU tar は exit 2、BusyBox は exit 1。
 * こちらの手元（bsdtar 3.5.3 / python 3.14）は読み飛ばして通す——**実装間で割れる。**
 */
export const structuralCases = () => [
  { id: 'dir-entry-with-body', tar: buildTar([
    { name: `${TOP}/d/`, type: '5', mode: 0o755, data: 'DATA' },
    { name: `${TOP}/a.txt`, data: 'A' },
  ]) },
  { id: 'symlink-with-body', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/link`, type: '2', linkname: 'a.txt', data: 'DATA' },
  ]) },
  { id: 'hardlink-with-body', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/hard`, type: '1', linkname: `${TOP}/a.txt`, data: 'DATA' },
  ]) },
  /** **正当な形は通す。**ディレクトリ entry は size 0 */
  { id: 'dir-entry-without-body', tar: buildTar([
    { name: `${TOP}/d/`, type: '5', mode: 0o755 },
    { name: `${TOP}/d/a.txt`, data: 'A' },
  ]) },
  /**
   * **base-256 の数値欄（v0.6.7・外部監査 P1-C）。**
   * 先頭 byte の最上位 bit が立つ GNU 拡張。実測（2026-08-10）:
   * **bsdtar・python とも exit 0 で展開する。**
   * v0.6.6 はこれを「8 進数ではない」＝壊れている扱いにしていた。
   * **展開できる archive を壊れていると言うのは誤り**なので、`ARCHIVE_UNSUPPORTED` にする。
   */
  { id: 'base256-size-field', tar: (() => {
    const h = header({ name: `${TOP}/big.bin`, size: 4 })
    const sz = Buffer.alloc(12)
    sz[0] = 0x80
    sz.writeUInt32BE(4, 8)
    sz.copy(h, 124)
    return Buffer.concat([
      buildTar([{ name: `${TOP}/a.txt`, data: 'A' }], { endBlocks: 0 }),
      recheck(h), body4('DATA'), Buffer.alloc(BLOCK * 2),
    ])
  })() },
]

/**
 * **先頭 1 階層を剥がしてよいか（v0.6.5・外部監査 P0-1）。**
 *
 * v0.6.4 は「全部が同じ頭で始まる」だけを見て剥がしていた。
 * **その頭が通常ファイルやリンクとして archive に入っていても剥がしていた**ので、
 * どの展開器でも作れない木を「source として受理」していた。実測:
 *
 * ```
 * regular root = ROOTFILE ／ regular root/... が 2 件
 *   検算 v9  status OK・files に空文字の key が残る
 *   bsdtar   exit 1（root は directory ではない）
 *   python   NotADirectoryError
 * ```
 */
/**
 * **同じ directory entry が 2 回出る形（v0.6.10・外部監査 P1）。**
 * directory は中身を持たないので「どちらが本物か」という問いが立たない。
 * 実測: 2 実装とも exit 0 で同じ木。**通常ファイルの重複は今までどおり止める。**
 */
export const duplicateCases = () => [
  { id: 'dup-directory-idempotent', tar: buildTar([
    { name: `${TOP}/dir/`, type: '5', mode: 0o755 },
    { name: `${TOP}/dir/`, type: '5', mode: 0o755 },
    { name: `${TOP}/dir/a.txt`, data: 'A' },
  ]) },
  { id: 'dup-directory-then-regular', tar: buildTar([
    { name: `${TOP}/x/`, type: '5', mode: 0o755 },
    { name: `${TOP}/x`, data: 'A' },
  ]) },
  { id: 'dup-regular-same-content', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/a.txt`, data: 'A' },
  ]) },
  { id: 'dup-regular-different-content', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'FIRST' },
    { name: `${TOP}/a.txt`, data: 'SECOND' },
  ]) },
]

export const rootStripCases = () => [
  { id: 'root-is-regular-file', tar: buildTar([
    { name: TOP, data: 'ROOTFILE' },
    { name: `${TOP}/source-input-scope.v1.json`, data: '{}' },
    { name: `${TOP}/src/model/a.ts`, data: 'A' },
  ]) },
  { id: 'root-is-symlink', tar: buildTar([
    { name: TOP, type: '2', linkname: 'elsewhere' },
    { name: `${TOP}/src/model/a.ts`, data: 'A' },
  ]) },
  { id: 'root-is-hardlink', tar: buildTar([
    { name: `${TOP}/src/model/a.ts`, data: 'A' },
    { name: TOP, type: '1', linkname: `${TOP}/src/model/a.ts` },
  ]) },
  /**
   * **末尾スラッシュつきの symlink を root に置く（v0.6.9・こちらで見つけた）。**
   *
   * v0.6.9 でリンクの末尾スラッシュを許したとき、
   * 「末尾に / がある」と「directory である」を**同じ変数で持っていた**ので、
   * `TOP/` という名前の symlink が
   * `stripTopLevel` の「頭は directory か」の検査を**directory として通り抜けた。**
   * 変数を 2 つに分けて塞いだ。**監査の指摘には無い**（過剰拒否を直した副作用で開いた穴）。
   */
  { id: 'root-is-symlink-trailing-slash', tar: buildTar([
    { name: `${TOP}/`, type: '2', linkname: 'elsewhere' },
    { name: `${TOP}/src/model/a.ts`, data: 'A' },
  ]) },
  /**
   * **子を持たない形（上と分けてある理由）。**
   * 子があると**祖先の型の検査**が先に落とすので、
   * `stripTopLevel` の「頭は directory か」だけを通る材料が別に要る。
   * 変異試験でそれが分かった——上の材料だけでは、この行を外しても落ちない。
   */
  { id: 'root-is-symlink-trailing-slash-only', tar: buildTar([
    { name: `${TOP}/`, type: '2', linkname: 'elsewhere' },
  ]) },
  /**
   * **正当な形は通す。**GitHub の tarball は root をディレクトリ entry として持つ。
   * mode に実行 bit を入れる——**644 のままだと展開した木へ入れず、
   * 「oracle が読めない」を「欠陥」と読み違える**（実際に一度そうなった）。
   */
  { id: 'root-is-directory', tar: buildTar([
    { name: `${TOP}/`, type: '5', mode: 0o755 },
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/src/model/b.ts`, data: 'B' },
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

/**
 * **生の USTAR 数値欄（v0.6.8・外部監査 P0-A）。**
 *
 * v0.6.7 は `size` しか見ておらず、`mode` / `uid` / `gid` / `mtime` は**読んでもいなかった。**
 * checksum を取り直せば、欄に `abc` を書いた archive が `status OK` になる。実測（2026-08-11）:
 *
 * ```
 * mode=abc など   検算 v12 READ ／ bsdtar は a.txt を作る ／ python は**黙って作らない**
 * checksum の junk 検算 v12 READ ／ **どちらも a.txt を作らない**（bsdtar は Damaged と警告）
 * ```
 */
export const rawFieldCases = () => {
  const at = (o, pos, len, text) => {
    const h = header(o)
    h.fill(0, pos, pos + len)
    Buffer.from(text, 'latin1').copy(h, pos, 0, Math.min(len, text.length))
    return recheck(h)
  }
  const wrap = (h, data) => Buffer.concat([
    buildTar([{ name: `${TOP}/keep.txt`, data: 'K' }], { endBlocks: 0 }),
    h, body4(data), Buffer.alloc(BLOCK * 2),
  ])
  const junk = (name, pos, len) => ({
    id: `raw-${name}-not-octal`,
    tar: wrap(at({ name: `${TOP}/a.txt`, size: 1 }, pos, len, `abc\0${' '.repeat(len - 4)}`), 'A'),
  })
  /**
   * **生ヘッダの `uname` / `gname` に不正な UTF-8（v0.6.9・外部監査 P1-C）。**
   *
   * PAX 側（`pax-uname-invalid-utf8`）は v0.6.7 から見ているが、
   * **固定長ヘッダの 265..296 / 297..328 は一度も試していなかった。**
   * v0.6.7 の実測で **libarchive は locale 変換で落ち、GNU tar は通す**ことが分かっているので、
   * ここは **platform で結末が変わりうる**。両 matrix で回して表と突き合わせる。
   */
  const badText = (name, pos, len) => ({
    id: `raw-${name}-invalid-utf8`,
    tar: wrap(at({ name: `${TOP}/a.txt`, size: 1 }, pos, len, '\xff\xfe user'), 'A'),
  })
  return [
    junk('mode', 100, 8), junk('uid', 108, 8), junk('gid', 116, 8), junk('mtime', 136, 12),
    junk('devmajor', 329, 8),
    badText('uname', 265, 32), badText('gname', 297, 32),
    /** checksum 欄: 8 進の頭だけ合っていて、そのあとが junk（前方一致だと通ってしまう） */
    { id: 'raw-cksum-octal-then-junk', tar: (() => {
      const h = header({ name: `${TOP}/a.txt`, size: 1 })
      h.fill(0x20, 148, 156)
      let sum = 0
      for (const x of h) sum += x
      Buffer.from(`${sum.toString(8).padStart(6, '0')}ZZ`, 'ascii').copy(h, 148)
      return wrap(h, 'A')
    })() },
    /** **対照: 正しい形は通す。**実物は 4 通りの書き方をしていた（2026-08-11 実測） */
    { id: 'raw-fields-ok', tar: wrap(recheck(header({ name: `${TOP}/a.txt`, size: 1 })), 'A') },
    /** macOS の tar が書く形（6 桁 + 空白 + NUL）。**通さないと実物が読めなくなる** */
    { id: 'raw-fields-space-padded', tar: (() => {
      const h = header({ name: `${TOP}/a.txt`, size: 1 })
      for (const [pos, len] of [[100, 8], [108, 8], [116, 8]]) {
        h.fill(0, pos, pos + len)
        Buffer.from('000644 \0'.slice(0, len), 'latin1').copy(h, pos)
      }
      return wrap(recheck(h), 'A')
    })() },
    /**
     * **歴史的な signed checksum（v0.6.8・外部監査 P1-C）。**
     * 128 以上のバイト（非 ASCII の名前）があると unsigned と食い違う。
     * 実測: 検算 v12 は ARCHIVE_INVALID ／ bsdtar も python も展開する＝過剰拒否だった。
     */
    { id: 'raw-cksum-signed', tar: (() => {
      const h = header({ name: `${TOP}/日本語ファイル.txt`, size: 1 })
      h.fill(0x20, 148, 156)
      let sum = 0
      for (const x of h) sum += x >= 128 ? x - 256 : x
      const v = sum < 0 ? 0o777777 + 1 + sum : sum
      Buffer.from(`${v.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(h, 148)
      return wrap(h, 'A')
    })() },
  ]
}

/**
 * **ヘッダ形式（magic + version）で 345..499 の意味が変わる（v0.6.9・外部監査 P0-A）。**
 *
 * v0.6.8 までは形式を確かめずに 345..499 を prefix として読んでいた。
 * old GNU ではそこは atime/ctime/offset/sparse の領域で、実測（2026-08-11）:
 *
 * ```
 * old GNU / V7 / 未知 magic ＋ 345..499 が非空
 *   検算 v13  src/model/types.ts が「ある」（32 入力の source に混ぜると status OK / 32 of 32）
 *   bsdtar    types.ts を root に作る（prefix を使わない）
 *   python    src/model/types.ts を作る（prefix を使う）
 * ```
 *
 * **形式そのものは拒まない**ので、通す側の対照を同じ数だけ置く（期待値は `_tarExpectations.ts`）——
 * 345..499 が空なら old GNU も V7 も未知 magic も 2 実装が同じ木を作る。
 */
const OLDGNU_MAGIC8 = Buffer.from('ustar  \0', 'latin1')
const V7_MAGIC8 = Buffer.alloc(8)
const UNKNOWN_MAGIC8 = Buffer.from('zzzzz\x0000', 'latin1')

export const headerFormatCases = () => [
  // --- 止める側: 形式が POSIX ustar でないのに 345..499 が非空 ---
  { id: 'format-oldgnu-prefix', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: 'types.ts', prefix: `${TOP}/src/model`, data: 'TYPES', magic8: OLDGNU_MAGIC8 },
  ]) },
  { id: 'format-v7-prefix', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: 'types.ts', prefix: `${TOP}/src/model`, data: 'TYPES', magic8: V7_MAGIC8 },
  ]) },
  { id: 'format-unknown-magic-prefix', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: 'types.ts', prefix: `${TOP}/src/model`, data: 'TYPES', magic8: UNKNOWN_MAGIC8 },
  ]) },
  /** prefix ではなく sparse metadata が入っているだけの old GNU（345..499 が非空なら同じく止める） */
  { id: 'format-oldgnu-sparse-region', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/b.txt`, prefix: '\x01\x02\x03', data: 'B', magic8: OLDGNU_MAGIC8 },
  ]) },
  // --- 通す側: 形式が何であれ 345..499 が空なら 2 実装とも同じ木 ---
  { id: 'format-oldgnu-no-prefix', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/src/model/types.ts`, data: 'TYPES', magic8: OLDGNU_MAGIC8 },
  ]) },
  { id: 'format-v7-no-prefix', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/src/model/types.ts`, data: 'TYPES', magic8: V7_MAGIC8 },
  ]) },
  { id: 'format-unknown-magic-no-prefix', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/src/model/types.ts`, data: 'TYPES', magic8: UNKNOWN_MAGIC8 },
  ]) },
  /**
   * **正当な old GNU sparse（v0.6.10・外部監査 P1）。**
   * typeflag `S` で 345..499 は sparse metadata。**壊れてはいない**（2 実装とも exit 0）。
   * こちらが sparse を扱わないだけなので `ARCHIVE_UNSUPPORTED` になるべきで、
   * v0.6.9 は形式の食い違いを型より先に見て `ARCHIVE_INVALID` と言っていた。
   */
  { id: 'format-oldgnu-sparse-valid', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/sparse.bin`, type: 'S', prefix: '\x00\x00\x01', magic8: OLDGNU_MAGIC8 },
  ]) },
  /** POSIX ustar は prefix を使ってよい（対照・実物の GitHub tarball と同じ形） */
  { id: 'format-posix-prefix', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: 'types.ts', prefix: `${TOP}/src/model`, data: 'TYPES' },
  ]) },
  /**
   * **version 欄で prefix の可否を変えない（実測）。**
   * `ustar\0` なら version が `00` / NUL NUL / 空白 2 個のどれでも 2 実装とも prefix を使う。
   * **指示書の「`ustar\0` + `00` でのみ prefix」は、この 2 つを落とす。**
   */
  { id: 'format-ustar-nul-version-prefix', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: 'types.ts', prefix: `${TOP}/src/model`, data: 'TYPES', magic8: Buffer.from('ustar\x00\x00\x00', 'latin1') },
  ]) },
  { id: 'format-ustar-space-version-prefix', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: 'types.ts', prefix: `${TOP}/src/model`, data: 'TYPES', magic8: Buffer.from('ustar\x00  ', 'latin1') },
  ]) },
]

/**
 * **長さ 0 の PAX 値が、鍵の分類を迂回する形（v0.6.10・外部監査 P0-A）。**
 *
 * v0.6.9 は `path`/`linkpath` と数値鍵しか `out` へ入れなかったので、
 * **値を空にするだけで allowlist と known-dangerous 検査を丸ごと飛ばせた。**
 * 実測（2026-08-11）: 同じ鍵で値の長さだけを変えると、
 * `size=12` は `ARCHIVE_INVALID` なのに `size=` は `READ` だった。
 * **こちらが v0.6.9 で開けた穴。**
 */
export const zeroLengthCases = () => {
  const rec = (k, v) => paxRec(k, v)
  const one = (id, key, value) => ({
    id,
    tar: buildTar([
      { name: `${TOP}/PaxHeaders/0/a`, type: 'x', data: rec(key, value) },
      { name: `${TOP}/a.txt`, data: 'A' },
    ]),
  })
  return [
    // --- 止める側: 分類が値の長さで変わってはいけない ---
    one('zero-size', 'size', ''),                       // 見え方を変える鍵
    one('zero-sun-holesdata', 'SUN.holesdata', ''),     // 実測: bsdtar は exit 1 で拒む
    one('zero-hdrcharset', 'hdrcharset', ''),           // 名前の読み方が変わる
    one('zero-schily-realsize', 'SCHILY.realsize', ''),
    one('zero-unknown-key', 'ACME.weird', ''),          // 未知の鍵（UNSUPPORTED）
    // --- 対照: 同じ鍵を非空にしても、同じ区分で止まること ---
    one('nonzero-size', 'size', '12'),
    one('nonzero-unknown-key', 'ACME.weird', 'X'),
    // --- 通す側: 見え方を変えない鍵は長さ 0 でも通す（期待値は _tarExpectations.ts）---
    one('zero-uname', 'uname', ''),
    one('zero-gname', 'gname', ''),
    one('zero-comment', 'comment', ''),
    one('zero-xattr', 'SCHILY.xattr.user.x', ''),
  ]
}

/**
 * **終端 zero block のあとに中身が続く形（v0.6.10・外部監査 P0-B）。**
 *
 * v0.6.9 は最初の zero block で読むのをやめ、**その後ろを一度も見なかった。**
 * 実測（2026-08-11）: 32 入力の source に zero block 1 個と `sneaky.ts` を足すと
 * `status OK / 32 of 32 / 未記録候補 0` になり、**ファイルの中には sneaky.ts が入っている。**
 * 手元の 2 実装は sneaky を作らないので**割れ自体は再現できていない**（監査は BusyBox で確認と報告）。
 *
 * 過剰拒否になっていないことは実物で確かめた: npm の実 tarball 600 本すべてが
 * 「終端 zero 2 個・その後ろの非 zero 0 件」。
 */
export const endOfArchiveCases = () => {
  const hidden = Buffer.concat([
    buildTar([{ name: `${TOP}/a.txt`, data: 'A' }], { endBlocks: 1 }),
    buildTar([{ name: `${TOP}/src/model/sneaky.ts`, data: 'SNEAK' }], { endBlocks: 2 }),
  ])
  return [
    { id: 'eoa-lone-zero-then-member', tar: hidden },
    { id: 'eoa-lone-zero-then-junk', tar: Buffer.concat([
      buildTar([{ name: `${TOP}/a.txt`, data: 'A' }], { endBlocks: 1 }),
      Buffer.from('X'.repeat(BLOCK), 'ascii'), Buffer.alloc(BLOCK * 2),
    ]) },
    /** **通す側。**終端 2 個・そのあとの詰め物はすべて zero（実物と同じ形） */
    { id: 'eoa-two-zero-blocks', tar: buildTar([{ name: `${TOP}/a.txt`, data: 'A' }]) },
    { id: 'eoa-two-zero-then-padding', tar: Buffer.concat([
      buildTar([{ name: `${TOP}/a.txt`, data: 'A' }]), Buffer.alloc(BLOCK * 18),
    ]) },
    /** 終端の印が無いまま物理 EOF。互換性のため通す（監査 §2 の但し書き） */
    { id: 'eoa-no-terminator', tar: buildTar([{ name: `${TOP}/a.txt`, data: 'A' }], { endBlocks: 0 }) },
  ]
}

/**
 * **名前が空になる形と、切れている archive（v0.6.11・外部監査 P0-B ほか）。**
 *
 * v0.6.10 は空の名前を `continue` で**黙って飛ばして**いた（32 入力へ混ぜると `OK 32/32`）。
 * 実測（2026-08-11）: bsdtar は `Archive entry has empty or unreadable filename ... skipping`、
 * **python は `IsADirectoryError`**（空の名前を展開先そのものとして開く）＝割れる。
 *
 * 切れている 2 形は**こちらが見つけた**。本体の詰め物が欠けた archive を
 * 2 実装とも拒むのに受理し、終端の印を見ないまま尽きた archive も受理していた。
 */
export const emptyNameCases = () => [
  { id: 'empty-raw-name', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: '', data: 'HIDDEN' },
  ]) },
  { id: 'empty-gnu-L-name', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: `${TOP}/L`, type: 'L', data: '' },
    { name: `${TOP}/target.txt`, data: 'HIDDEN' },
  ]) },
  /**
   * mode は 755 にする。**644 のままだと展開した木へ入れず**、
   * 「oracle が読めない」を「欠陥」と読み違える（`root-is-directory` と同じ理由。
   * macOS では通り **Linux の CI で EACCES になった**）。見たいのは名前が空であることだけ。
   */
  { id: 'empty-name-unknown-type', tar: buildTar([
    { name: `${TOP}/a.txt`, data: 'A' },
    { name: '', type: '5', mode: 0o755 },
  ]) },
  /** **通す側の対照。**名前が空でなければ、同じ機構は今までどおり通る */
  { id: 'gnu-L-nonempty-name', tar: buildTar([
    { name: `${TOP}/L`, type: 'L', data: `${TOP}/${'v'.repeat(120)}.txt` },
    { name: `${TOP}/placeholder.txt`, data: 'A' },
  ]) },
]

export const truncationCases = () => {
  const whole = buildTar([{ name: `${TOP}/a.txt`, data: 'A'.repeat(600) }])
  return [
    /** 本体の詰め物が欠けている（2 実装とも `Truncated` で拒む） */
    { id: 'trunc-body-padding', tar: whole.subarray(0, whole.length - 1024 - 1) },
    /** 終端の印を見ないまま尽きる（bsdtar は Truncated・python は通す＝割れる） */
    { id: 'trunc-no-terminator', tar: Buffer.concat([
      buildTar([{ name: `${TOP}/a.txt`, data: 'A' }], { endBlocks: 0 }), Buffer.alloc(100),
    ]) },
    /** **通す側。**終端のあとの端数は 2 実装とも読み飛ばす */
    { id: 'trunc-partial-after-terminator', tar: Buffer.concat([
      buildTar([{ name: `${TOP}/a.txt`, data: 'A' }]), Buffer.alloc(100),
    ]) },
    { id: 'trunc-none', tar: whole },
  ]
}

/**
 * **metadata だけの PAX は、GNU `L`/`K` と共存できる（v0.6.11・外部監査 P1-A）。**
 * v0.6.10 は `x` が来ただけで「名前の上書きが 2 つ」と落としていた。
 * 実測: 2 実装とも同じ長い名前を作る。**`path` を持つ形は今までどおり止める。**
 */
export const paxCoexistCases = () => {
  const LONG = 'v'.repeat(120)
  return [
    { id: 'coexist-L-then-metadata-pax', tar: buildTar([
      { name: `${TOP}/L`, type: 'L', data: `${TOP}/${LONG}.txt` },
      { name: `${TOP}/P`, type: 'x', data: paxRec('mtime', '1') },
      { name: `${TOP}/placeholder.txt`, data: 'A' },
    ]) },
    { id: 'coexist-K-then-metadata-pax', tar: buildTar([
      { name: `${TOP}/t.txt`, data: 'T' },
      { name: `${TOP}/K`, type: 'K', data: `${TOP}/${LONG}.txt` },
      { name: `${TOP}/P`, type: 'x', data: paxRec('mtime', '1') },
      { name: `${TOP}/ln`, type: '2', linkname: 't.txt' },
    ]) },
    /** `L` のあとに metadata だけの `x` が 2 つ続く形も、名前には触らない */
    { id: 'coexist-L-then-two-metadata-pax', tar: buildTar([
      { name: `${TOP}/L`, type: 'L', data: `${TOP}/${LONG}.txt` },
      { name: `${TOP}/P`, type: 'x', data: paxRec('mtime', '1') + paxRec('uid', '0') },
      { name: `${TOP}/placeholder.txt`, data: 'A' },
    ]) },
    /** PAX が先で `L` があと。**順序が変わっても名前は 1 つしか効かない** */
    { id: 'coexist-metadata-pax-then-L', tar: buildTar([
      { name: `${TOP}/P`, type: 'x', data: paxRec('mtime', '1') },
      { name: `${TOP}/L`, type: 'L', data: `${TOP}/${LONG}.txt` },
      { name: `${TOP}/placeholder.txt`, data: 'A' },
    ]) },
    /**
     * **止める側の対照は、既存の `pax` 群にある**（`gnu-longname-then-pax-path` /
     * `pax-gnu-K-then-linkpath`）。同じ機構なのでここには置かない——
     * **重複を足すと「根拠が無い拒否」の件数だけが水増しされる。**
     */
  ]
}

/** 全部まとめて。**種類ごとに 4 個以上あることを test 側で確かめる** */
export const allCases = () => ({
  pax: paxCases(),
  longName: longNameCases(),
  checksum: checksumCases(),
  traversal: traversalCases(),
  pathSpelling: pathSpellingCases(),
  link: linkCases(),
  resource: resourceCases(),
  entryType: entryTypeCases(),
  encoding: encodingCases(),
  rootStrip: rootStripCases(),
  structural: structuralCases(),
  ancestor: ancestorCases(),
  rawField: rawFieldCases(),
  headerFormat: headerFormatCases(),
  zeroLength: zeroLengthCases(),
  endOfArchive: endOfArchiveCases(),
  duplicate: duplicateCases(),
  emptyName: emptyNameCases(),
  truncation: truncationCases(),
  paxCoexist: paxCoexistCases(),
})
