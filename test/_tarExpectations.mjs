/**
 * **壊れた tar の材料が、どう終わるべきか。**
 *
 * ここが**唯一の正本**である（v0.6.12）。
 * v0.6.11 まで、同じ境界を材料側の `ok` 旗ももう 1 つ持っていた。
 * **旗を読んでいたのは 1 か所だけ・しかも `!ok` としてだけ**だったので、
 * **`ok: true` が本当に通ることは一度も確かめられていなかった。**
 * 実測すると 10 件ずれていて、公開文書の「通す材料 66 件」は旗の数（実際は 72 件）だった。
 * **旗は消し、判定はすべてここから引く。**
 *
 * この表そのものは `test/tarHardening.test.ts` が 182 件すべてについて
 * 実際の結末と突き合わせるので、書きっぱなしにはできない。
 */


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

export const EXPECTED = {
  pax: 'safe',        // **中身を拾わないだけでは足りない。**意味を変える鍵があれば止める（下の個別指定）
  longName: 'safe',   // 正常な GNU long name は通る。危険なものだけ止まる
  checksum: 'invalid',
  traversal: 'invalid',
  /** 同じ場所を別の綴りで指せる形（v0.6.15・外部監査 P1-C）。**実装は受け入れる。方針で止める** */
  pathSpelling: 'invalid',
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
  /** 名前が空になる形（v0.6.11）。通す側は個別指定 */
  emptyName: 'invalid',
  /** 切れている archive（v0.6.11・こちらで見つけた）。通す側は個別指定 */
  truncation: 'invalid',
  /** GNU L/K と metadata だけの PAX の共存（v0.6.11）。既定は通す側 */
  paxCoexist: 'safe',
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
export const EXPECTED_BY_ID = {
  /**
   * **v0.6.15（外部監査 P1-C）。**catalog には在るのに材料が無かった止め方。
   * `link` の既定は `safe`（リンクは読み飛ばす）だが、
   * **指す先そのものが壊れている 2 件は読み飛ばせない。**
   */
  'link-hardlink-empty-target': 'invalid',
  'link-hardlink-dot-target': 'invalid',
  /** `pax` の既定は `safe` だが、レコードの形が壊れていれば読めない */
  'pax-record-no-newline': 'invalid',
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
  // -------------------------------------------------------------------------
  // v0.6.11（外部監査 2026-08-11）
  // -------------------------------------------------------------------------
  /** **通す側。**名前が空でなければ同じ機構は今までどおり通る */
  'gnu-L-nonempty-name': 'safe',
  'trunc-partial-after-terminator': 'safe',   // 終端のあとの端数は 2 実装とも読み飛ばす
  'trunc-none': 'safe',
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

/**
 * **材料 1 件の期待値を引く。**個別指定が種類ごとの既定より優先する。
 *
 * **引けなかったら例外にする。**`?? EXPECTED[kind]` が `undefined` を返すと、
 * 呼び手の `want === 'invalid'` が false になって**黙って「通るはず」の側へ落ちる**。
 * 新しい種類を足して既定を書き忘れたとき、それが素通りになる。
 */
export function expectedOutcome(kind, id) {
  const want = EXPECTED_BY_ID[id] ?? EXPECTED[kind]
  if (!want) throw new Error(`${kind}/${id}: 期待する結末が表に無い（EXPECTED[${kind}] も EXPECTED_BY_ID[${id}] も無い）`)
  return want
}
