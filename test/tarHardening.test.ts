/**
 * **信頼できない archive に対して parser が止まることを、実物の壊れた tar で試す。**
 *
 * 材料は `test/_corruptTar.mjs`（170 個・16 種類）。
 * **変異は parser の外側から入れる。**parser の中の定数をいじると、
 * 「その定数を読んでいること」しか確かめられない。
 *
 * **塞ぎすぎていないことも同じファイルで見る。**正常な tar と実物の GitHub tarball が
 * 通らなくなったら、この強化は失敗である。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { TAR_LIMITS, readArchiveBuffer } from '../scripts/verifyReleaseSourceInputs.mjs'
import { allCases, buildTar, normalTar } from './_corruptTar.mjs'

const ROOT = resolve(__dirname, '..')
const VERIFIER = 'scripts/verifyReleaseSourceInputs.mjs'

const cases = allCases()
const read = (buf: Buffer, gzip = false) => readArchiveBuffer(buf, { gzip })

/**
 * 期待する結末。
 *   `invalid`     … 壊れている／曖昧／誰も展開できないので止まる
 *   `unsupported` … **ふつうの tar は展開できる**が、この道具の範囲の外なので止まる（v0.6.7）
 *   `safe`        … 読めて、危険な entry を含まない
 *
 * **`unsupported` を足したのは、`ARCHIVE_INVALID` が 2 つの別のことを言っていたから。**
 * 実測（2026-08-10）: typeflag 7・base-256 の size 欄・長すぎるパスは
 * bsdtar も python も exit 0 で展開する。**展開できる archive を「壊れている」と言っていた。**
 */
type Outcome = 'invalid' | 'unsupported' | 'safe'
const EXPECTED: Record<string, Outcome> = {
  pax: 'safe',        // **中身を拾わないだけでは足りない。**意味を変える鍵があれば止める（下の個別指定）
  longName: 'safe',   // 正常な GNU long name は通る。危険なものだけ止まる
  checksum: 'invalid',
  traversal: 'invalid',
  link: 'safe',       // リンクは読み飛ばす。止める必要は無い
  resource: 'unsupported',  // 上限は**方針**であって archive の欠陥ではない（v0.6.7）
  entryType: 'unsupported',  // 扱いを決めていない型。**決めていないのは archive の欠陥ではない**（下の個別指定）
  encoding: 'invalid',   // パスが UTF-8 として読めない
  rootStrip: 'invalid',  // 先頭 1 階層が directory でないのに剥がす形。正当な形だけ safe（下の個別指定）
  structural: 'invalid', // 中身を持てない型に本体がある形。正当な形だけ safe（下の個別指定）
  ancestor: 'invalid',   // 祖先が directory でない木。正当な木だけ safe（下の個別指定・v0.6.7）
  rawField: 'invalid',   // 生の USTAR 数値欄が壊れている形。正しい書き方だけ safe（v0.6.8）
  /**
   * ヘッダ形式と 345..499 の食い違い（v0.6.9）。**形式そのものは拒まない**ので、
   * 「345..499 が空なら通す」側の材料を同じ数だけ置いてある（下の個別指定）。
   */
  headerFormat: 'invalid',
  /** 長さ 0 の PAX 値。**分類は値の長さで変わらない**ので、既定は非空と同じ（v0.6.10） */
  zeroLength: 'invalid',
  /** 終端 zero block のあとに中身が続く形（v0.6.10） */
  endOfArchive: 'invalid',
  /** 同じパスが 2 回。**directory どうしだけ通す**（v0.6.10・下の個別指定） */
  duplicate: 'invalid',
}

/**
 * **種類ごとの既定より個別 id を優先する。**
 *
 * ## この表そのものが 2026-08-06 まで間違っていた
 *
 * `pax-x-path` と `pax-x-size-override` は**最初から材料としてあった**のに、
 * 期待値が `pax: 'safe'`（＝「PAX ヘッダをファイルとして拾わなければよい」）だった。
 * その基準では通ってしまう——**拾わないことと、上書き指示を無視してよいことは別**である。
 *
 * ```
 * ヘッダ名 root/file.txt ／ PAX path=root/other.txt
 *   検算器 : file.txt を検証して OK        ← 「拾っていない」ので当時の基準では合格
 *   実展開 : root/other.txt ができる       ← 検算した名前は存在しない
 * ```
 *
 * **材料は正しく、判定基準のほうが間違っていた。**
 * 手で書いた期待値は、コードと同じ思い違いを共有しうる。
 * だから `test/tarExtractionOracle.test.ts` で、
 * **期待値を手で書かずにふつうの tar 展開から作る**検査を別に置いた。
 */
const EXPECTED_BY_ID: Record<string, Outcome> = {
  // 'pax-x-path' は **safe**。v0.6.3 で `path=` を解釈するようにしたので、展開結果と一致する
  'pax-x-size-override': 'invalid',  // size 上書き → 読む長さが食い違う
  'gnu-L-traversal': 'invalid',
  'gnu-L-size-lie': 'invalid',
  // v0.6.4（外部監査 P0-A/B/C）。**同じ member に上書きが 2 つ効く形は、実装ごとに結末が割れる**
  'pax-path-then-gnu-longname': 'invalid',
  'gnu-longname-then-pax-path': 'invalid',
  'pax-path-twice': 'invalid',
  'pax-path-then-second-pax': 'invalid',
  'pax-g-path-override': 'invalid',
  // 中身を持つのに扱いを決めていない型は止める（inventory に載るだけでは、中身を検算できない）
  'typeflag-7-contiguous': 'unsupported',
  'typeflag-S-gnu-sparse': 'unsupported',
  // **リンクは止めない。**inventory に載せて、範囲の完全性検査がそれを見る
  'symlink-under-scope': 'safe',
  'hardlink-under-scope': 'safe',

  // v0.6.5（外部監査 P0-2/3/4 と P1）
  'pax-path-with-nul': 'invalid',        // PAX は長さ区切りなので NUL は値の一部
  'pax-sun-holesdata': 'invalid',        // bsdtar は archive ごと拒否・python は通す＝割れる
  'link-hardlink-missing-target': 'invalid',      // 受理しても誰も展開できない
  'link-hardlink-forward-reference': 'invalid',   // 前方参照も両実装で展開できない
  'root-is-regular-file': 'invalid',
  'root-is-symlink': 'invalid',
  'root-is-hardlink': 'invalid',
  /**
   * **ここから下は「止めてはいけない」もの。**
   * 独立した 2 member がそれぞれ上書きを 1 回ずつ使うのは正当な archive で、
   * v0.6.4 はこれを拒んでいた（外部監査 P1・**こちらの過剰拒否**）。
   */
  'root-is-directory': 'safe',
  'gnu-L-two-independent': 'safe',
  'pax-two-independent-paths': 'safe',
  /** 名前の上書きのあとに entry が無いまま終わる形。`tar` は Damaged tar archive で拒む */
  'gnu-L-no-following-entry': 'invalid',

  // v0.6.6（外部監査 P0-1/2/3 と P1）
  'link-hardlink-self-reference': 'invalid',
  'link-hardlink-to-directory': 'invalid',
  'pax-uid-not-a-number': 'invalid',
  'pax-mtime-not-a-number': 'invalid',
  'pax-atime-nan': 'invalid',
  'pax-ctime-exponent': 'invalid',
  'pax-linkpath-dangling-hardlink': 'invalid',
  /**
   * **止めてはいけないもの。**どちらも 4 実装すべてが展開でき、
   * v0.6.5 は拒んでいた（**こちらの過剰拒否**）。
   */
  'link-gnu-longlink': 'safe',
  'pax-linkpath-long': 'safe',
  'dir-entry-without-body': 'safe',

  // -------------------------------------------------------------------------
  // v0.6.7（外部監査 2026-08-10）
  // -------------------------------------------------------------------------
  /** **P0-B: 指す先の上書きに状態が無かった。**名前の上書きと同じ規則を当てる */
  'pax-g-linkpath-override': 'invalid',          // 実測: bsdtar は header・python は global を採る
  'pax-linkpath-twice': 'invalid',               // 実測: bsdtar exit 1 ／ python は 1 つ目
  'pax-linkpath-then-gnu-K': 'invalid',          // **手元の 2 実装は一致して通す**（監査の 4 実装は割れる）
  'pax-gnu-K-then-linkpath': 'invalid',          // 同上
  'pax-linkpath-no-following-entry': 'invalid',  // 実測: 2 実装とも Damaged / ReadError
  'link-gnu-K-no-following-entry': 'invalid',    // 同上
  /** **P0-C: 値の契約。**uname/gname は libarchive が locale 変換で落ちる（実測） */
  'pax-uname-invalid-utf8': 'invalid',
  'pax-gname-invalid-utf8': 'invalid',
  'pax-mtime-above-int64': 'invalid',            // 実測: python は OverflowError
  'pax-mtime-plus-sign': 'invalid',              // POSIX の書式に無い。**実測では 2 実装とも通す**
  'pax-uid-above-32bit': 'invalid',              // **手元では再現していない**（監査の GNU tar 1.35）
  'pax-gid-above-32bit': 'invalid',              // 同上
  /** **これはこちらの実測で見つけた false-OK**（末尾スラッシュを剥がして受理していた） */
  'link-hardlink-target-trailing-slash': 'invalid',
  'link-hardlink-target-dotdot': 'invalid',      // 実測: bsdtar は Path contains '..' で exit 1
  'link-hardlink-cycle': 'invalid',
  /** **P0-A: 祖先の型。**正当な木だけ通す */
  'ancestor-explicit-dir-tree': 'safe',
  'ancestor-implicit-dir-tree': 'safe',
  'ancestor-symlink-leaf-only': 'safe',
  /**
   * **止めてはいけないもの（v0.6.7）。**
   * すべて「bsdtar と python が一致して展開する」ことを実測してから置いている。
   * **過剰拒否は 3 版続けて出しているので、通す材料のほうを厚くする。**
   */
  'pax-mtime-negative': 'safe',                  // GNU tar がふつうに書く。v0.6.6 は拒んでいた
  'pax-mtime-negative-fraction': 'safe',
  'pax-mtime-large-within-range': 'safe',        // 上限のすぐ内側（塞ぎすぎの対照）
  'pax-uid-32bit-max': 'safe',
  'pax-uname-nul-inside': 'safe',                // 監査は NUL も拒めと言うが、実測では割れない
  'pax-comment-invalid-utf8': 'safe',            // 同上（comment は locale 変換に乗らない）
  'link-hardlink-chain': 'safe',                 // v0.6.6 は拒んでいた（実測: nlink=3 ができる）
  'link-hardlink-pax-chain': 'safe',
  'link-hardlink-dot-alias': 'safe',
  'link-hardlink-leading-dot-alias': 'safe',
  'link-hardlink-double-slash-alias': 'safe',
  'link-gnu-K-and-L-together': 'safe',           // 名前と指す先は別の機構。まとめて拒まない
  /**
   * **切れている archive は、上限の話より先に「壊れている」（v0.6.7）。**
   * 宣言した size のぶんの本体が入っていない。実測: bsdtar は
   * `Truncated tar archive` で exit 1、python も落ちる。**上限とは無関係に壊れている。**
   */
  'res-size-overflow': 'invalid',
  /** **P1-C: 展開できるが範囲の外。**「壊れている」とは言わない */
  'base256-size-field': 'unsupported',
  'pax-unknown-vendor-key': 'unsupported',       // 実測: 2 実装とも通す（SUN.holesdata とは違う）
  'gnu-L-very-long': 'unsupported',              // 上限は方針。実測: 1,100 文字も 2 実装は展開する

  // -------------------------------------------------------------------------
  // v0.6.8（外部監査 2026-08-11）
  // -------------------------------------------------------------------------
  /** **P0-B: 鍵に関係なく、`x` のあとに member が無いまま終わる形** */
  'pax-dangling-metadata-only': 'invalid',       // 実測: bsdtar exit 1 ／ python exit 2
  'pax-two-local-x': 'invalid',                  // 実測: bsdtar exit 1（malformed pax）／ python は通す
  /** **P1-A: 末尾スラッシュは directory のときだけ** */
  'pax-regular-trailing-slash': 'invalid',       // 実測: bsdtar は directory・python は通常ファイル
  /**
   * **v0.6.9 で `invalid` から `safe` へ（外部監査 P1-B）。**
   * v0.6.8 は「directory 以外は全部拒む」だったが、**実測を追い越していた。**
   * symlink・hardlink の末尾スラッシュは 2 実装とも同じ木を作る（2026-08-11 実測）ので、
   * 末尾スラッシュを 1 回だけ剥がして、剥がした名前で衝突と祖先の検査をやり直す。
   */
  'pax-symlink-trailing-slash': 'safe',

  // -------------------------------------------------------------------------
  // v0.6.9（外部監査 2026-08-11）
  // -------------------------------------------------------------------------
  /** **P0-B: 許可表に無い型。**実測: 2 実装とも中身つきの通常ファイルを作るのに数えていなかった */
  'typeflag-Z-unknown': 'unsupported',
  'typeflag-space-unknown': 'unsupported',
  'typeflag-lowercase-vendor': 'unsupported',
  'typeflag-3-chardev': 'unsupported',      // 実測: 2 実装とも権限が無くて作れない
  'typeflag-6-fifo': 'unsupported',         // 実測: 2 実装とも FIFO を作る（中身を持つファイルではない）
  /** **P0-C: 名前を消す長さ 0 の上書きは実装が割れる**（bsdtar は生ヘッダへ戻し python は空名） */
  'pax-zero-length-path': 'invalid',
  'pax-zero-length-linkpath': 'invalid',
  /** **P0-A: 形式が POSIX ustar でないのに 345..499 が非空**（bsdtar は使わず python は使う） */
  'format-oldgnu-prefix': 'invalid',
  'format-v7-prefix': 'invalid',
  'format-unknown-magic-prefix': 'invalid',
  'format-oldgnu-sparse-region': 'invalid',
  /**
   * **止めてはいけないもの（v0.6.9）。**ここも全部、2 実装が一致することを実測してから置いた。
   * `mtime=` と `uid=` は**監査が挙げていない過剰拒否**で、こちらの再現の途中で見つけた。
   */
  /**
   * **`safe` と書いて間違えた（CI の ubuntu run が落として判明）。**
   * 手元の 2 実装がそろって通したので「過剰拒否だった」と読んだが、
   * **GNU tar は `Malformed extended header: invalid mtime=` で archive ごと拒む。**
   * 割れていたのは**開発機に無い 3 つ目の実装**だった。
   */
  'pax-zero-length-mtime': 'invalid',
  'pax-zero-length-uid': 'invalid',
  'pax-duplicate-path-same-header': 'safe',
  'pax-duplicate-mtime-same-header': 'safe',
  'pax-duplicate-linkpath-same-header': 'safe',
  'pax-hardlink-trailing-slash': 'safe',
  'format-oldgnu-no-prefix': 'safe',        // **old GNU は GNU tar 自身の既定の出力形式**
  'format-v7-no-prefix': 'safe',
  'format-unknown-magic-no-prefix': 'safe',
  'format-posix-prefix': 'safe',
  'format-ustar-nul-version-prefix': 'safe',    // 指示書の「version は 00 のみ」だと落ちる
  'format-ustar-space-version-prefix': 'safe',  // 同上
  /**
   * **P1-C: 生ヘッダの `uname`/`gname` が不正な UTF-8。**
   * 検算器は名前に使わないので読まない。実測（macOS・2026-08-11）: 2 実装とも展開する。
   * **libarchive は locale 変換で落ちうる**ので、両 matrix で回して表と突き合わせる
   * （落ちるなら oracle 試験のほうが先に落ちる）。
   */
  // -------------------------------------------------------------------------
  // v0.6.10（外部監査 2026-08-11）
  // -------------------------------------------------------------------------
  /** **P0-A: 分類は値の長さで変わらない。**未知の鍵だけ `unsupported` */
  'zero-unknown-key': 'unsupported',
  'nonzero-unknown-key': 'unsupported',
  /** **見え方を変えない鍵は、長さ 0 でも通す**（実測: 2 実装とも同じ木） */
  'zero-uname': 'safe',
  'zero-gname': 'safe',
  'zero-comment': 'safe',
  'zero-xattr': 'safe',
  /** **P0-B: 終端のあとに中身が続かない形は通す** */
  'eoa-two-zero-blocks': 'safe',
  'eoa-two-zero-then-padding': 'safe',
  'eoa-no-terminator': 'safe',
  /**
   * **P1: 正当な old GNU sparse は「壊れている」ではなく「範囲の外」。**
   * `-region` は typeflag 0（支援する型）なので形式の食い違いで `invalid` のまま。
   * **型が S のときだけ**「扱わない型」として `unsupported` になる。
   */
  'format-oldgnu-sparse-valid': 'unsupported',
  /** **P1: mtime の小数部は省略できる**（`.5` のように数字が先に無い形は止める） */
  'pax-mtime-trailing-dot': 'safe',
  'pax-mtime-negative-trailing-dot': 'safe',
  'pax-mtime-leading-dot': 'invalid',
  /** **P1: 冪等な directory の重複だけ通す** */
  'dup-directory-idempotent': 'safe',
  'raw-uname-invalid-utf8': 'safe',
  'raw-gname-invalid-utf8': 'safe',
  /** **末尾スラッシュつきの root symlink**（過剰拒否を直した副作用で開いた穴・こちらで発見） */
  'root-is-symlink-trailing-slash': 'invalid',
  /**
   * **頭 1 個しか無い archive は剥がす話にならない。**2 実装とも同じ木を作るので通す
   * （v0.6.5 からの過剰拒否。**この材料を足したときに、この試験自身が見つけた**）。
   */
  'root-is-symlink-trailing-slash-only': 'safe',

  /** **止めてはいけないもの（v0.6.8）。**すべて 2 実装が一致して展開することを実測してから置いた */
  'pax-metadata-then-member': 'safe',
  'pax-dir-trailing-slash': 'safe',              // v0.6.7 は「空のパス要素」で落としていた
  'gnu-L-dir-trailing-slash': 'safe',
  'pax-uid-leading-zero': 'safe',                // **前回の勧告どおりの正規表現が過剰拒否になった**
  'pax-gid-leading-zero': 'safe',
  'pax-mtime-leading-zero': 'safe',
  'pax-mtime-neg-leading-zero': 'safe',
  'raw-fields-ok': 'safe',
  'raw-fields-space-padded': 'safe',             // macOS の tar が書く形（6 桁 + 空白 + NUL）
  'raw-cksum-signed': 'safe',                    // 歴史的な signed checksum（2 実装とも展開する）
  /**
   * **§7 の分類にしたがって「壊れている」から「範囲の外」へ移した（v0.6.8）。**
   * `..\evil.txt` は Unix では 3 実装とも同じふつうの名前を作り、Windows では 1 階層上を指す。
   * **受け手の OS で意味が変わるのであって、archive が壊れているわけではない。**
   */
  'trav-backslash': 'unsupported',
}

describe('tar 強化 ① 170 個すべてについて、どうなるかを実測する', () => {
  const table: { id: string, kind: string, outcome: string, files: number }[] = []

  it.each(Object.entries(cases).flatMap(([k, list]) => list.map((c) => [k, c.id] as const)))(
    '%s / %s',
    (kind, id) => {
      const c = cases[kind].find((x) => x.id === id)!
      const r = read(c.tar)
      const outcome = r.error ? String(r.kind) : 'READ'
      table.push({ id: c.id, kind, outcome, files: r.files ? r.files.size : 0 })

      const want = EXPECTED_BY_ID[c.id] ?? EXPECTED[kind]
      if (want === 'invalid' || want === 'unsupported') {
        expect(r.error, `${c.id}: 止まっていない`).toBeTruthy()
        /**
         * **どちらで止めたかまで固定する。**まとめて「止まった」だけを見ると、
         * 「壊れている」と「対応していない」が入れ替わっても通ってしまう。
         */
        expect(r.kind, `${c.id}: 止めた区分が違う`)
          .toBe(want === 'invalid' ? 'ARCHIVE_INVALID' : 'ARCHIVE_UNSUPPORTED')
      } else {
        // 止まらない場合でも、**危険な名前が Map に入っていないこと**が要件
        expect(r.error, `${c.id}: 止まってしまった（塞ぎすぎ）`).toBeFalsy()
        for (const name of r.files!.keys()) {
          expect(name.split('/').includes('..'), `${c.id}: .. が残っている (${name})`).toBe(false)
          expect(name.startsWith('/'), `${c.id}: 絶対パスが残っている (${name})`).toBe(false)
        }
      }
    },
  )

  /**
   * **止めた理由には、文章とは別の変わらない名前が必ず付く（v0.6.10・外部監査 §4）。**
   *
   * `*_OTHER` は「まだ名前を付けていない」という意味なので、
   * **corpus に在る材料がそれを返したら、受け手は機械で分岐できない。**
   * 新しい throw を足したときに名前を付け忘れると、ここで落ちる。
   */
  it('**止まった材料はすべて stableReasonCode を持つ**（*_OTHER が無い）', () => {
    const missing: string[] = []
    for (const [kind, list] of Object.entries(cases)) {
      for (const c of list) {
        const r = read(c.tar)
        if (!r.error) continue
        if (!r.stableReasonCode || r.stableReasonCode.endsWith('_OTHER')) {
          missing.push(`${kind}/${c.id}: ${r.stableReasonCode ?? '(無し)'}`)
        }
      }
    }
    expect(missing, '名前の付いていない止め方がある').toEqual([])
  })

  it('**この検査が空振りしていない**（code を消せば落ちる）', () => {
    // 実在する材料で、code が実際に載っていることを確かめる（母集団が空でない証拠）
    const withCode = Object.values(cases).flat()
      .map((c) => read(c.tar)).filter((r) => r.error && r.stableReasonCode && !r.stableReasonCode.endsWith('_OTHER'))
    expect(withCode.length, 'code つきで止まる材料が 1 つも無い').toBeGreaterThanOrEqual(80)
  })

  it('一覧を出す（何がどう止まったかを記録に残す）', () => {
    expect(table.length, '前の it が走っていない').toBeGreaterThanOrEqual(170)
    const lines = table.map((t) => `  ${t.kind.padEnd(10)} ${t.id.padEnd(26)} ${t.outcome.padEnd(16)} files=${t.files}`)
    console.log(`\n170 個の実測\n${lines.join('\n')}`)
  })
})

describe('tar 強化 ② 種類ごとに「なぜ止まったか」まで見る', () => {
  const find = (id: string) => Object.values(cases).flat().find((c) => c.id === id)!

  it.each([
    ['cksum-bad-first', 'checksum'],
    ['cksum-blank', 'checksum'],
    ['trav-dotdot', '..'],
    ['trav-absolute', '絶対パス'],
    ['trav-backslash', 'バックスラッシュ'],
    ['res-many-entries', 'entry が多すぎる'],
    ['res-huge-entry', 'entry が大きすぎる'],
    ['res-long-path', 'パスが長すぎる'],
  ])('%s は「%s」で止まる', (id, needle) => {
    const r = read(find(id).tar)
    expect(r.error, `${id}: 止まっていない`).toBeTruthy()
    expect(r.error, `${id}: 鳴った理由が違う`).toContain(needle)
  })

  it('PAX の中身をファイルとして拾わない', () => {
    for (const c of cases.pax) {
      const r = read(c.tar)
      if (r.error) continue
      for (const name of r.files!.keys()) {
        expect(name, `${c.id}: PAX ヘッダを拾っている`).not.toMatch(/PaxHeaders|pax_global_header/)
      }
    }
  })

  /**
   * **リンクは「拾わない」。ただし全部を通してよいわけではない（v0.6.5）。**
   *
   * v0.6.4 まで `link` 群は全件 `safe` だったので、この試験は群ごと通ることを前提にしていた。
   * v0.6.5 で **指す先の無い hardlink は `ARCHIVE_INVALID`** になったため、
   * 前提が成り立たなくなった。**主張は緩めず**、通ると決めた材料に限って同じことを見る
   * （母集団は期待値の表から引くので、通す材料を増やしたら自動でここに入る）。
   */
  it('symlink と hardlink をファイルとして拾わない', () => {
    const safeLinks = cases.link.filter((c) => (EXPECTED_BY_ID[c.id] ?? EXPECTED.link) === 'safe')
    expect(safeLinks.length, 'safe なリンク材料が無い（母集団が空）').toBeGreaterThanOrEqual(10)
    for (const c of safeLinks) {
      const r = read(c.tar)
      expect(r.error, `${c.id}: 止まってしまった`).toBeFalsy()
      expect([...r.files!.keys()].some((n) => n.includes('link')), `${c.id}: リンクを拾っている`).toBe(false)
    }
  })

  /**
   * **展開できない hardlink は、理由まで固定する（**受理しても誰も展開できない**）。**
   *
   * v0.6.5 は 1 つの正規表現で群をまとめて見ていたが、v0.6.6 で止める理由が 3 種になった。
   * **ゆるい 1 本にまとめず、id ごとに理由を書く**——まとめると
   * 「何かの理由で止まった」しか言えず、**別の理由で止まっても通ってしまう。**
   * 母集団は期待値の表から引くので、止める材料を増やすとここが必ず落ちて、書き足しを促す。
   */
  const HARDLINK_REASONS: Record<string, RegExp> = {
    'link-hardlink-missing-target': /hardlink の指す先が、ここまでの entry に無い/,
    'link-hardlink-forward-reference': /hardlink の指す先が、ここまでの entry に無い/,
    'link-hardlink-self-reference': /hardlink が自分自身を指している/,
    'link-hardlink-to-directory': /hardlink の指す先が通常ファイルではない/,
    // v0.6.7。**指す先の綴りと、上書きの終端**
    'link-hardlink-target-trailing-slash': /リンクの指す先が \/ で終わっている/,
    'link-hardlink-target-dotdot': /リンクの指す先の綴りを受け取れない/,
    'link-hardlink-cycle': /hardlink の指す先が、ここまでの entry に無い/,
    'link-gnu-K-no-following-entry': /linkname の上書き（GNU long linkname）のあとに entry が無い/,
  }
  it('展開できない hardlink は、理由まで一致して止まる', () => {
    const bad = cases.link.filter((c) => (EXPECTED_BY_ID[c.id] ?? EXPECTED.link) === 'invalid')
    expect(bad.length, '止まるべきリンク材料が無い（母集団が空）').toBeGreaterThanOrEqual(8)
    for (const c of bad) {
      const want = HARDLINK_REASONS[c.id]
      expect(want, `${c.id}: 期待する理由が書かれていない（材料を足したら理由も書く）`).toBeTruthy()
      expect(read(c.tar).error, `${c.id}: 通ってしまった`).toMatch(want)
    }
  })
})

describe('tar 強化 ③ 塞ぎすぎていない', () => {
  it('正常な tar は通る（対照）', () => {
    const r = read(normalTar())
    expect(r.error).toBeFalsy()
    expect([...r.files!.keys()].sort()).toEqual(['a.txt', 'src/b.txt'])
  })

  it('gzip をかけても通る', () => {
    const r = read(gzipSync(normalTar()), true)
    expect(r.error).toBeFalsy()
    expect(r.files!.size).toBe(2)
  })

  /**
   * **この試験は 2026-08-06 まで空振りしていた。**
   *
   * `buildTar` へ 807 文字の名前を渡していたが、**素の USTAR header の name 欄は 100 バイト**しかない。
   * 実際に組まれた tar のパスは 100 文字へ切り詰められ、しかも末尾が `a/` になっていた——
   * つまり「上限 1024 のすぐ内側」ではなく「100 文字の壊れたパス」を試していた。
   *
   * v0.6.2 で末尾スラッシュを拒むようにしたら、この材料が引っかかって発覚した。
   * **長いパスは GNU long name (`L`) を通さないと表現できない**（`res-long-path` と同じ落とし穴）。
   */
  it('**上限のすぐ内側は通る**（境界を 1 方向でしか試さない状態にしない）', () => {
    const long = `x/${'a/'.repeat(400)}f.txt`
    expect(long.length, '材料が上限の内側でない').toBeLessThan(TAR_LIMITS.maxPathLength)
    expect(long.length, '材料が短すぎて境界を試せていない').toBeGreaterThan(700)
    const near = buildTar([
      { name: '././@LongLink', type: 'L', data: `${long}\0` },
      { name: 'ignored-because-longlink', data: 'x' },
    ])
    const r = read(near)
    expect(r.error, 'パス長の上限内なのに止まった').toBeFalsy()
    /**
     * **材料が本当にその長さで届いているか。**切り詰められていたらここで落ちる。
     * 先頭の `x/` は `stripTopLevel` が剥がす（GitHub の tarball と同じ扱い。単一の親だから）。
     */
    expect([...r.files!.keys()]).toEqual([long.slice('x/'.length)])
    expect([...r.files!.keys()][0].length, '100 文字へ切り詰められている').toBeGreaterThan(700)
  })

  it('**実物の GitHub tarball（v0.5.2）が通り、entry 数が実測と合う**', () => {
    const cached = '/tmp/src.tar.gz'
    let gz: Buffer
    if (existsSync(cached)) gz = readFileSync(cached)
    else {
      try {
        gz = execFileSync('curl', ['-sL', 'https://github.com/Driedsandwich/trs-jack-3d/archive/refs/tags/v0.5.2.tar.gz'],
          { maxBuffer: 1 << 28 })
      } catch {
        console.log('  実物の tarball を取れないので飛ばす（network 無し）')
        return
      }
    }
    const r = read(gz, true)
    expect(r.error, `実物が止まった: ${r.error}`).toBeFalsy()
    // 2026-08-06 実測: ファイル 246 / ディレクトリ 21 / pax global 1
    expect(r.files!.size, '実物の件数が変わっている').toBe(246)
    expect(r.files!.has('package.json'), '先頭階層が剥がれていない').toBe(true)
  })
})

describe('tar 強化 ④ 上限の値が実測に基づいている', () => {
  it('上限は実測（entry 268 / 最大 1.33 MB / 最長パス 95 / tar 15.09 MB）より広い', () => {
    expect(TAR_LIMITS.maxEntries).toBeGreaterThan(268)
    expect(TAR_LIMITS.maxEntryBytes).toBeGreaterThan(1_331_055)
    expect(TAR_LIMITS.maxPathLength).toBeGreaterThan(95)
    expect(TAR_LIMITS.maxTotalBytes).toBeGreaterThan(15_093_760)
  })

  it('**無限に広くはない**（上限が意味を持っている）', () => {
    expect(TAR_LIMITS.maxEntries).toBeLessThan(268 * 100)
    expect(TAR_LIMITS.maxEntryBytes).toBeLessThan(1_331_055 * 100)
    expect(TAR_LIMITS.maxPathLength).toBeLessThan(95 * 100)
  })
})

/**
 * **v0.6.1（外部監査 2026-08-06 の P1 3 件）。**
 *
 * どれも「壊れた tar」ではなく **v0.6.0 が黙って受理していた入力**である。
 * 26 個の材料は v0.6.0 の穴を突く形で作ったので、**同じ材料では出てこない**
 * （範囲の内側だけ叩く変異は範囲の狭さを暴けない）。
 */
describe('tar 強化 ⑤ v0.6.1 — 重複 entry・symlink ループ・圧縮入力の上限', () => {
  /** USTAR header を組む。`test/_corruptTar.mjs` と同じ組み方 */
  const hdr = (name: string, size: number, type = '0') => {
    const b = Buffer.alloc(512)
    b.write(name, 0, 100, 'utf8')
    b.write('0000644\0', 100); b.write('0000000\0', 108); b.write('0000000\0', 116)
    b.write(size.toString(8).padStart(11, '0') + '\0', 124)
    b.write('00000000000\0', 136)
    b.write('        ', 148)
    b.write(type, 156)
    b.write('ustar\0', 257); b.write('00', 263)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += b[i]
    b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    return b
  }
  const entry = (name: string, content: string) => {
    const data = Buffer.from(content)
    return Buffer.concat([hdr(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512)])
  }
  const tarOf = (...es: Buffer[]) => Buffer.concat([...es, Buffer.alloc(1024)])

  it('**同じパスの entry が 2 回あったら止まる**（v0.6.0 は後の中身が黙って勝った）', () => {
    const r = read(tarOf(entry('root/dup.txt', 'FIRST'), entry('root/dup.txt', 'SECOND')))
    expect(r.error, '重複を受理している').toBeTruthy()
    expect(r.kind).toBe('ARCHIVE_INVALID')
    expect(r.error).toContain('2 回')
    // **v0.6.0 の挙動を名指しで固定する。**後勝ちに戻ったらここで落ちる
    expect(r.files, '中身を返してしまっている').toBeUndefined()
  })

  it('中身が同じでも重複は拒む（同じ内容なら許す、にしない）', () => {
    const r = read(tarOf(entry('root/same.txt', 'X'), entry('root/same.txt', 'X')))
    expect(r.kind).toBe('ARCHIVE_INVALID')
  })

  it('対照 — 重複していなければ、これまでどおり読める', () => {
    const r = read(tarOf(entry('root/a.txt', 'A'), entry('root/b.txt', 'B')))
    expect(r.error, `塞ぎすぎている: ${r.error}`).toBeFalsy()
    expect(r.files!.size).toBe(2)
    expect(r.files!.get('a.txt')!.toString()).toBe('A')
    // 材料の組み方そのものが壊れていないこと
    expect(read(normalTar()).error).toBeFalsy()
  })

  it('圧縮された入力そのものに上限がある（展開後だけではない）', () => {
    expect(TAR_LIMITS.maxCompressedBytes).toBeGreaterThan(9_760_000)   // 実物 9.76 MB より広い
    expect(TAR_LIMITS.maxCompressedBytes).toBeLessThan(9_760_000 * 50) // **無限に広くはない**
    // 展開後の上限とは別の値である（片方だけ効いている状態にしない）
    expect(TAR_LIMITS.maxCompressedBytes).toBeLessThan(TAR_LIMITS.maxTotalBytes)
  })

  it('CLI がディレクトリの symlink ループで構造化 JSON を返す（生の例外で落ちない）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trs-loop-'))
    try {
      mkdirSync(join(dir, 'root'))
      writeFileSync(join(dir, 'root', 'a.txt'), 'x')
      symlinkSync('.', join(dir, 'root', 'loop'))
      let out = ''
      let code = 0
      try {
        out = execFileSync('node', [VERIFIER, '--manifest', 'artifacts/source-input-manifest.json', '--source', dir],
          { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 })
      } catch (e) {
        const err = e as { stdout?: string, status?: number }
        out = err.stdout ?? ''
        code = err.status ?? 0
      }
      // **JSON で返ること**が本題。status は入力が揃っていないので MISMATCH でよい
      const j = JSON.parse(out)
      expect(j.toolVersion, '構造化出力になっていない').toBeGreaterThanOrEqual(6)
      expect(typeof j.status).toBe('string')
      expect(code, '止まらずに 0 で返している').not.toBe(0)
      // symlink は追わずに読み飛ばしたことを出力に残す
      expect(String(j.origin)).toContain('symlink')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('対照 — ループが無ければ symlink の注記は出ない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trs-noloop-'))
    try {
      mkdirSync(join(dir, 'root'))
      writeFileSync(join(dir, 'root', 'a.txt'), 'x')
      let out = ''
      try {
        out = execFileSync('node', [VERIFIER, '--manifest', 'artifacts/source-input-manifest.json', '--source', dir],
          { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 })
      } catch (e) {
        out = (e as { stdout?: string }).stdout ?? ''
      }
      expect(String(JSON.parse(out).origin)).not.toContain('symlink')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

/**
 * **v0.6.2（外部監査 2026-08-06 の P0-2）。**
 *
 * v0.6.1 は「文字列として同じパスか」だけを見ていた。
 * そのため**検算が見た中身と、ふつうに展開してできる中身が食い違う** archive が `OK` で通った。
 * checksum を通す意味そのものが無くなるので、これは P0 である。
 *
 * ここでの oracle は**ふつうの tar 展開**である。「展開したらどうなるか」と
 * 「検算は何を見たか」がずれたら不合格、という基準で試験する。
 */
describe('tar 強化 ⑥ v0.6.2 — 同じ場所を指す別の綴り', () => {
  const hdr = (name: string, size: number, type = '0', link = '') => {
    const b = Buffer.alloc(512)
    b.write(name, 0, 100, 'utf8')
    b.write('0000644\0', 100); b.write('0000000\0', 108); b.write('0000000\0', 116)
    b.write(size.toString(8).padStart(11, '0') + '\0', 124)
    b.write('00000000000\0', 136)
    b.write('        ', 148)
    b.write(type, 156)
    if (link) b.write(link, 157, 100, 'utf8')
    b.write('ustar\0', 257); b.write('00', 263)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += b[i]
    b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    return b
  }
  const entry = (n: string, c: string, t = '0', l = '') => {
    const d = Buffer.from(c)
    const isLink = t === '2' || t === '1'
    return Buffer.concat([
      hdr(n, isLink ? 0 : d.length, t, l),
      isLink ? Buffer.alloc(0) : d,
      isLink ? Buffer.alloc(0) : Buffer.alloc((512 - (d.length % 512)) % 512),
    ])
  }
  const tarOf = (...es: Buffer[]) => Buffer.concat([...es, Buffer.alloc(1024)])

  it('**`root/./file.txt` は止まる**（v0.6.1 は別ファイルとして受理していた）', () => {
    const r = read(tarOf(entry('root/file.txt', 'FIRST'), entry('root/./file.txt', 'SECOND')))
    expect(r.error, '同じ場所の別の綴りを受理している').toBeTruthy()
    expect(r.kind).toBe('ARCHIVE_INVALID')
    // **v0.6.1 の挙動を名指しで固定する。**両方拾って返す形に戻ったらここで落ちる
    expect(r.files, '中身を返してしまっている').toBeUndefined()
  })

  it('`//` と末尾の `/` も止まる', () => {
    for (const bad of ['root//file.txt', 'root/file.txt/']) {
      const r = read(tarOf(entry(bad, 'X')))
      expect(r.kind, bad).toBe('ARCHIVE_INVALID')
    }
  })

  it('制御文字を含むパスは止まる', () => {
    const r = read(tarOf(entry(`root/${String.fromCharCode(1)}file.txt`, 'X')))
    expect(r.kind).toBe('ARCHIVE_INVALID')
    expect(r.error).toContain('制御文字')
  })

  it('**通常ファイルと同名の symlink は止まる**（v0.6.1 はリンクを無視して OK を返した）', () => {
    const r = read(tarOf(
      entry('root/file.txt', 'FIRST'),
      entry('root/file.txt', '', '2', 'target.txt'),
      entry('root/target.txt', 'SECOND'),
    ))
    expect(r.error, 'リンクを無視した結果、展開結果と食い違う').toBeTruthy()
    expect(r.kind).toBe('ARCHIVE_INVALID')
    expect(r.files).toBeUndefined()
  })

  it('hardlink・ディレクトリでも同じパスの衝突は止まる', () => {
    for (const t of ['1', '5']) {
      const r = read(tarOf(entry('root/x.txt', 'FIRST'), entry('root/x.txt', '', t, 'other.txt')))
      expect(r.kind, `typeflag ${t}`).toBe('ARCHIVE_INVALID')
    }
  })

  it('対照 — 衝突していないリンクとディレクトリは、これまでどおり読み飛ばすだけ', () => {
    const r = read(tarOf(
      entry('root/dir/', '', '5'),
      entry('root/dir/a.txt', 'A'),
      entry('root/link.txt', '', '2', 'a.txt'),
      entry('root/b.txt', 'B'),
    ))
    expect(r.error, `塞ぎすぎている: ${r.error}`).toBeFalsy()
    expect([...r.files!.keys()].sort()).toEqual(['b.txt', 'dir/a.txt'])
  })

  it('対照 — 実物の GitHub tarball は正規化検査を通る（ディレクトリ entry を含む）', () => {
    const cached = '/tmp/src.tar.gz'
    if (!existsSync(cached)) return
    const r = read(readFileSync(cached), true)
    expect(r.error, `実物が止まった: ${r.error}`).toBeFalsy()
    expect(r.files!.size).toBe(246)
  })
})
