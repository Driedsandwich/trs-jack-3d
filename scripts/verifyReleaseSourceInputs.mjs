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
 * **status と終了コードの一覧はここに書かない（v0.6.14・外部監査 P1-B）。**
 * v0.6.13 まで、ここに 5 種類を手で並べていた。道具が 8 種類を返すようになったあとも
 * **5 種類のまま残り、配布ソースを読む受け手に古い一覧を見せていた。**
 * 正本は下の `CLI_STATUS_EXIT` ひとつ。**同じ境界を 2 か所に書かない。**
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
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
 *   7 … **外部監査 2026-08-06 の追加 2 件（こちらで再現してから直した）。**
 *       `root/./file.txt` のような別の綴りが、`root/file.txt` と別ものとして通っていた。
 *       通常ファイルと同名の symlink を読み飛ばしていたため、**検算が見た中身と
 *       ふつうに展開してできる中身が食い違う** archive が OK になっていた（P0-2）。
 *       ディレクトリ入力に資源上限が無く、検証に使わない 70 MB を置くだけで RSS が 3 倍近くになった（P1）。
 *       **判定が変わる**（v7 で止まる archive が v6 では通った）ので版を上げる
 *   8 … **外部監査 2026-08-06（v0.6.2 に対する回）の 3 件。**
 *       PAX の `path=` / `size=` 上書きに従わないだけで、**止めてもいなかった**。
 *       読み飛ばす entry（リンク・ディレクトリ）に正規化の検査をかけていなかったので、
 *       別の綴りにするだけで衝突検査をすり抜けられた。
 *       ヘッダの文字列を読むとき数値欄と同じく `.trim()` していたので、
 *       末尾に空白のあるパスが別名に化けた。
 *       **3 つとも「検算が見た view」と「ふつうに展開した view」が食い違う**形で、
 *       ふつうの tar を oracle にした差分試験で捕まえた。
 *       **判定が変わる**ので版を上げる
 *   9 … **外部監査 2026-08-06（v0.6.3 に対する回）の 3 件。**
 *       同じ member に名前の上書きが 2 つ効く形（PAX `path=` と GNU long name の組み合わせ・
 *       local PAX の連続）を後勝ちで通していた。**実装ごとに結末が割れる**ので止める。
 *       `typeflag 7` などを通常ファイルとして数えず、**未記録入力の探索から消していた。**
 *       全 entry の型つき一覧（inventory）を作り、完全性の検査はそちらを母集団にする。
 *       パス欄を `toString('utf8')` で読んでいたので、不正なバイトが U+FFFD へ置換され、
 *       **検算が見た名前と展開してできる名前が別物になった。**厳密 decode で止める。
 *       **判定が変わる**ので版を上げる
 *  10 … **外部監査 2026-08-08（v0.6.4 に対する回）の P0 4 件 + P1 1 件。**
 *       先頭 1 階層を、それが directory かを確かめずに剥がしていた（root が通常ファイルでも剥がし、
 *       files に空文字の key が残った）。
 *       hardlink の指す先が archive に無くても status OK を返していた——
 *       **検算は通るのに誰も展開できない archive**を受理していた。
 *       PAX の可変長テキストを固定長欄と同じ関数で読んでいたので、`path` の NUL 以降を捨てていた。
 *       PAX の鍵を denylist で拒んでいたが閉じておらず、`SUN.holesdata` で 3 者の結末が割れた
 *       → **allowlist へ変更**。
 *       **P1 は私の過剰拒否**: 上書きの出所（longNameFrom）を member 消費時に戻し忘れており、
 *       独立した 2 つの member がそれぞれ長い名前を使う**正当な archive**を拒んでいた。
 *       **判定が変わる**ので版を上げる
 *  11 … **外部監査 2026-08-08（v0.6.5 に対する回）の P0 3 件 + P1。**
 *       自分自身を指す hardlink と、ディレクトリを指す hardlink を受理していた
 *       （この entry の名前を先に seenPaths へ入れていた／指す先の型を見ていなかった）。
 *       allowlist の鍵でも `uid=abc` のように**値が読めない**ものを通していた
 *       （GNU tar は Malformed extended header で拒む）。
 *       中身を持てない型（ディレクトリ・リンク・デバイス）に本体があっても通していた
 *       （読み飛ばすかどうかで、その先の解釈が丸ごとずれる）。
 *       **P1 はこちらの過剰拒否**: GNU の `K`（長い linkname）と PAX `linkpath` を
 *       拒んでいたが、**4 実装すべてが展開できる**正当な形だった。どちらも解釈する。
 *       **判定が変わる**ので版を上げる
 *  12 … **外部監査 2026-08-10（v0.6.6 に対する回）の P0 3 件 + P1 3 件。**
 *       祖先が通常ファイル・symlink・hardlink でも、その下の entry を受理していた
 *       （**どの展開器でもこの木は作れない**のに `status OK`）→ 祖先型の不変条件を持つ。
 *       linkname の上書き（GNU `K` / PAX `linkpath`）に状態機械が無く、global・二重・
 *       宙に浮いた上書きを受理していた（実測で bsdtar と python の結末が割れる）
 *       → 名前の上書きと同じ規則にし、inventory へは**効いたあとの**指す先を入れる。
 *       PAX の `uname`/`gname` が不正 UTF-8 でも通していた（libarchive は拒む）。
 *       時刻の整数部に上限が無かった（python は int64 上限で OverflowError）。
 *       **P1 はこちらの過剰拒否が 2 件**: 負の時刻（GNU tar がふつうに書く）を拒み、
 *       hardlink の連鎖と `./` 綴りの指す先を拒んでいた（2 実装とも展開できる）。
 *       **hardlink の指す先の末尾スラッシュを剥がして受理していた**のは、
 *       監査ではなくこちらの実測で見つけた false-OK（bsdtar は展開できない）。
 *       `ARCHIVE_UNSUPPORTED` を新設し、**壊れている**と**対応していない**を分けた。
 *       **判定が変わる**ので版を上げる
 *  13 … **外部監査 2026-08-11（v0.6.7 に対する回）の P0 2 件 + P1 4 件。**
 *       生の USTAR 数値欄を `size` しか見ていなかった——`mode`/`uid`/`gid`/`mtime` に
 *       `abc` を書いて checksum を取り直した archive を `status OK` と言っていた
 *       （実測: bsdtar は作る・python は黙って作らない）。checksum 欄も前方一致でしか見ておらず、
 *       8 進のあとの junk を見逃していた。全部 `parseTarNumericField` へ集約。
 *       local PAX（`x`）の pending 状態が `path`/`linkpath` にしか無く、
 *       **`mtime` だけの `x` を末尾に置いた archive**が素通りしていた。
 *       **P1 はこちらの過剰拒否が 4 件**: directory の PAX path が `/` で終わる形、
 *       PAX の値の先頭ゼロ（**前回の勧告どおりに書いた正規表現がそのまま過剰拒否になった**）、
 *       歴史的な signed checksum、そして backslash を「壊れている」と言っていたこと
 *       （OS で意味が変わるだけなので `ARCHIVE_UNSUPPORTED` へ）。
 *       **判定が変わる**ので版を上げる
 *  14 … **ヘッダ形式を確かめずに 345..499 を prefix として読んでいた (v0.6.9 P0-A)。**
 *       old GNU ではそこは atime/ctime/sparse の領域で、実測すると
 *       **bsdtar は prefix を使わず python は使う**——同じ archive から別の木ができる。
 *       magic を形式判別子にし、prefix を読むのは POSIX ustar のときだけにした。
 *       **形式そのものは拒まない**（345..499 が空なら 2 実装とも同じ木で、
 *       old GNU は GNU tar 自身の既定の出力形式である）。
 *       typeflag を**除外表から許可表へ**（P0-B）。`Z` や空白のような知らない型が
 *       inventory にだけ入って `files` に入らず、**中身を数えないまま `OK` と言っていた。**
 *       長さ 0 の PAX 値を扱う（P0-C）。`path=`/`linkpath=` は**実装が割れる**ので止め、
 *       それ以外の鍵は POSIX どおり「上書きの削除」として綴り検査を掛けない。
 *       **P1 はこちらの過剰拒否が 4 件**: 同一 PAX ヘッダ内の重複鍵（POSIX は後勝ち・
 *       6 鍵とも 2 実装が一致）、hardlink と symlink の名前の末尾スラッシュ、
 *       そして**監査が挙げていない `mtime=` と `uid=`**（長さ 0 を壊れた数値と読んでいた）。
 *       **判定が変わる**ので版を上げる
 *  15 … **長さ 0 の PAX 値が、鍵の分類を丸ごと迂回していた (v0.6.10 P0-A)。**
 *       v14 で「長さ 0 を早く返す」ようにしたとき、`path`/`linkpath` と数値鍵しか
 *       `out` へ入れなくなり、**allowlist と known-dangerous 検査が `out.keys()` しか
 *       見ない**ので `size=` / `SUN.holesdata=` / `ACME.weird=` が素通りした。
 *       **こちらが v14 で開けた穴。**分類を先にして、値の長さは後から見る。
 *       **終端 zero block のあとを一度も見ていなかった (P0-B)。**
 *       zero block を 1 個置いた後ろに member を隠せた（手元の 2 実装も読まないので
 *       割れは再現できていない。BusyBox が読むと監査が報告）。
 *       **P1 は過剰拒否 3 件**: 正当な old GNU sparse を「壊れている」と言っていた
 *       （型より先に形式を見ていた）・`mtime=1.` を拒んでいた・
 *       冪等な directory の重複を拒んでいた。
 *       止めた理由すべてに `stableReasonCode` を付けた。
 *       **判定が変わる**ので版を上げる
 *  16 … **範囲定義を manifest へ縛った (v0.6.11 P0-A)。**`--scope` を中身も確かめずに
 *       受けていたので、**範囲を狭めるだけで「漏れ 0 件」を作れた**（存在しない scope でも
 *       `status OK / exit 0`）。`inputScope.sha256` と完全一致したときだけ信じる。
 *       あわせて **`OK` を「必須の工程が全部終わったとき」だけ**にし、
 *       できていない工程があれば `VERIFICATION_INCOMPLETE`（exit 1）と言う。
 *       古い tag 用に `--allow-unpinned-scope` を足したが、**それでも `OK` にはならない。**
 *       **名前が空の member を黙って捨てていた (P0-B)。**`PATH_EMPTY_NAME` /
 *       `EXTENSION_NAME_EMPTY` で止める（実測: bsdtar は skip・python は落ちる）。
 *       **directory source の FIFO・socket・device が一覧から消えていた (P0-C)。**
 *       **切れている archive を 2 形受理していた**（本体の詰め物が欠けている・
 *       終端の印を見ないまま尽きる。**こちらで見つけた**）。
 *       **P1**: metadata だけの PAX が GNU `L`/`K` と共存できるようにした
 *       （`path` を持つときだけ競合とする）。ディレクトリ側の上限を
 *       `ARCHIVE_UNSUPPORTED` へそろえ、gzip 失敗を `GZIP_DECODE_FAILED` にした。
 *       **判定が変わる**ので版を上げる
 *
 *   （版を上げない変更）
 *   v0.6.13  入口の判定をファイル名から「起動された本体か」（`realpathSync`）へ変えた。
 *       v0.6.12 まで、**別名でコピーしたり symlink を張ったりすると、何も出さずに `exit 0`**
 *       で終わっていた（実測: `renamed.mjs` / `link.mjs` とも出力 0 バイト）。
 *       **版は上げない。**この道具の版上げ規則は「**判定の意味が変わったら**」で、
 *       同梱 schema も `toolVersion` を「判定の意味を変えたら上げるので、受け手はこれで
 *       挙動を見分けられる」と定義している。ここで変わったのは**走るかどうか**であって、
 *       走ったときの判定ではない（正規の名前での出力は **byte 一致**）。
 *       **黙っていた経路は JSON を 1 バイトも出さない**ので、`toolVersion` を読める受け手が
 *       「16 なのに挙動が違う」に出会う場面は無い。**版で見分ける必要が生じない。**
 *       道具そのものを突き合わせたいときは、自己申告 artifact の `tool.sha256` を見る。
 */
/**
 * **止めた理由の名前の唯一の正本（v0.6.14・外部監査 2026-08-12 P0）。**
 *
 * **この道具は 1 ファイルで配る**（受け手は同梱の .mjs をそのまま走らせる）ので、
 * catalog を別ファイルに置くと配布物が動かなくなる。実際に一度そうして試験に捕まった
 * ——`検証ツールが単体で動く（リポジトリ内の他ファイルを import していない）`。
 *
 * v0.6.13 まで、`stableReasonCode` は throw / return の各所に文字列として散っていた。
 * 中央の一覧が無いので、**付け忘れた経路は黙って `*_OTHER` へ落ちる。**
 * 「corpus で止まる材料 110 件・`*_OTHER` は 0 件」は真だったが、
 * **corpus が踏んだ経路についてだけ**で、公開 CLI の全経路を覆っていなかった。
 */
/**
 * `code → { status, family, summary }`
 *
 * - `status`  … この code で止まるときの CLI status
 * - `family`  … 受け手が粗く分岐するための束（`path` / `pax` / `header` / …）
 * - `summary` … 人が読む 1 行。**分岐に使わない**
 *
 * **具体値（欄名・型・実際のパス）は `detail` へ入れる。**欄ごとの code は作らない
 * ——作ると受け手の分岐が爆発し、こちら側も付け忘れる。
 */
export const REASON_CODES = {
  // ---- パスそのもの ----
  PATH_TRAVERSAL: { status: 'ARCHIVE_INVALID', family: 'path', summary: '.. が残るパス' },
  PATH_ABSOLUTE: { status: 'ARCHIVE_INVALID', family: 'path', summary: '絶対パス' },
  PATH_DRIVE_LETTER: { status: 'ARCHIVE_INVALID', family: 'path', summary: 'ドライブレター付き' },
  PATH_NOT_CANONICAL: { status: 'ARCHIVE_INVALID', family: 'path', summary: '正規形でない綴り' },
  PATH_EMPTY_COMPONENT: { status: 'ARCHIVE_INVALID', family: 'path', summary: '空のパス要素' },
  PATH_EMPTY_NAME: { status: 'ARCHIVE_INVALID', family: 'path', summary: '実効名が空' },
  PATH_SURROUNDING_SPACE: { status: 'ARCHIVE_INVALID', family: 'path', summary: '前後に空白' },
  PATH_CONTROL_CHARACTER: { status: 'ARCHIVE_INVALID', family: 'path', summary: '制御文字' },
  PATH_TRAILING_SLASH_TYPE_CONFLICT: { status: 'ARCHIVE_INVALID', family: 'path', summary: '末尾スラッシュと型が食い違う' },
  PATH_BACKSLASH_UNSUPPORTED: { status: 'ARCHIVE_UNSUPPORTED', family: 'path', summary: 'バックスラッシュ（OS で意味が変わる）' },
  PATH_TOO_LONG_UNSUPPORTED: { status: 'ARCHIVE_UNSUPPORTED', family: 'limit', summary: 'パスが長すぎる' },
  ROOT_STRIP_NOT_A_DIRECTORY: { status: 'ARCHIVE_INVALID', family: 'path', summary: '先頭 1 階層が directory でない' },

  // ---- 文字 ----
  TEXT_NOT_UTF8: { status: 'ARCHIVE_INVALID', family: 'text', summary: 'UTF-8 として読めない' },
  TEXT_CONTAINS_NUL: { status: 'ARCHIVE_INVALID', family: 'text', summary: 'NUL を含む' },

  // ---- ヘッダ ----
  HEADER_CHECKSUM_MISMATCH: { status: 'ARCHIVE_INVALID', family: 'header', summary: 'checksum が合わない' },
  HEADER_FORMAT_PREFIX_CONFLICT: { status: 'ARCHIVE_INVALID', family: 'header', summary: '形式と 345..499 が食い違う' },
  HEADER_NUMERIC_FIELD_SYNTAX: { status: 'ARCHIVE_INVALID', family: 'header', summary: '数値欄の書式' },
  HEADER_NUMERIC_FIELD_RANGE: { status: 'ARCHIVE_INVALID', family: 'header', summary: '数値欄の範囲' },
  HEADER_NUMERIC_FIELD_BASE256_UNSUPPORTED: { status: 'ARCHIVE_UNSUPPORTED', family: 'header', summary: 'base-256 の数値欄' },

  // ---- PAX / 拡張ヘッダ ----
  PAX_RECORD_INVALID: { status: 'ARCHIVE_INVALID', family: 'pax', summary: 'PAX レコードの形が壊れている' },
  PAX_VALUE_SYNTAX: { status: 'ARCHIVE_INVALID', family: 'pax', summary: 'PAX の値の書式' },
  PAX_VALUE_RANGE: { status: 'ARCHIVE_INVALID', family: 'pax', summary: 'PAX の値の範囲' },
  PAX_KEY_DANGEROUS: { status: 'ARCHIVE_INVALID', family: 'pax', summary: '見え方を変える鍵' },
  PAX_KEY_UNSUPPORTED: { status: 'ARCHIVE_UNSUPPORTED', family: 'pax', summary: '扱いを決めていない鍵' },
  PAX_ZERO_LENGTH_VALUE_INVALID: { status: 'ARCHIVE_INVALID', family: 'pax', summary: '長さ 0 の値が許されない鍵' },
  PAX_ZERO_LENGTH_NAME_AMBIGUOUS: { status: 'ARCHIVE_INVALID', family: 'pax', summary: '長さ 0 の名前指定' },
  PAX_GLOBAL_NAME_OVERRIDE: { status: 'ARCHIVE_INVALID', family: 'pax', summary: 'global ヘッダで名前を上書き' },
  EXTENSION_HEADER_DANGLING: { status: 'ARCHIVE_INVALID', family: 'pax', summary: '拡張ヘッダの相手がいない' },
  /** ⚠️ 名前は UNSUPPORTED だが、**実測では ARCHIVE_INVALID**（名前から推測して書いたのが誤りだった・v0.6.14） */
  EXTENSION_HEADER_SEQUENCE_UNSUPPORTED: { status: 'ARCHIVE_INVALID', family: 'pax', summary: '扱いを決めていない並び' },
  EXTENSION_OVERRIDE_CONFLICT: { status: 'ARCHIVE_INVALID', family: 'pax', summary: '名前の上書きが 2 つ効く' },
  EXTENSION_NAME_EMPTY: { status: 'ARCHIVE_INVALID', family: 'pax', summary: '拡張ヘッダの中身が長さ 0' },

  // ---- entry の型・本体 ----
  ENTRY_TYPE_UNSUPPORTED: { status: 'ARCHIVE_UNSUPPORTED', family: 'entry', summary: '扱いを決めていない型' },
  ENTRY_BODY_ON_BODYLESS_TYPE: { status: 'ARCHIVE_INVALID', family: 'entry', summary: '中身を持てない型に本体がある' },
  ENTRY_BODY_TRUNCATED: { status: 'ARCHIVE_INVALID', family: 'entry', summary: '本体の詰め物が欠けている' },
  DUPLICATE_PATH_CONFLICT: { status: 'ARCHIVE_INVALID', family: 'entry', summary: '同じパスが 2 回' },
  ANCESTOR_TYPE_CONFLICT: { status: 'ARCHIVE_INVALID', family: 'entry', summary: '祖先が directory でない' },

  // ---- リンク ----
  LINK_TARGET_EMPTY: { status: 'ARCHIVE_INVALID', family: 'link', summary: 'リンクの指す先が空' },
  LINK_TARGET_NOT_A_PATH: { status: 'ARCHIVE_INVALID', family: 'link', summary: '指す先の綴りを受け取れない' },
  LINK_TARGET_NOT_CANONICAL: { status: 'ARCHIVE_INVALID', family: 'link', summary: '指す先が正規形でない' },
  LINK_TARGET_TRAILING_SLASH: { status: 'ARCHIVE_INVALID', family: 'link', summary: '指す先が / で終わる' },
  HARDLINK_TARGET_MISSING: { status: 'ARCHIVE_INVALID', family: 'link', summary: 'hardlink の指す先が無い' },
  HARDLINK_TARGET_NOT_A_FILE: { status: 'ARCHIVE_INVALID', family: 'link', summary: '指す先が通常ファイルでない' },
  HARDLINK_SELF_REFERENCE: { status: 'ARCHIVE_INVALID', family: 'link', summary: '自分自身を指す hardlink' },
  HARDLINK_CHAIN_UNRESOLVED: { status: 'ARCHIVE_INVALID', family: 'link', summary: 'hardlink の連鎖を解決できない' },

  // ---- 終端 ----
  END_OF_ARCHIVE_LONE_ZERO_BLOCK: { status: 'ARCHIVE_INVALID', family: 'eoa', summary: '終端の印のあとに中身が続く' },
  END_OF_ARCHIVE_MISSING: { status: 'ARCHIVE_INVALID', family: 'eoa', summary: '終端の印を見ないまま尽きた' },

  // ---- 上限（方針であって archive の欠陥ではない）----
  LIMIT_ENTRY_COUNT_UNSUPPORTED: { status: 'ARCHIVE_UNSUPPORTED', family: 'limit', summary: 'entry が多すぎる' },
  LIMIT_ENTRY_BYTES_UNSUPPORTED: { status: 'ARCHIVE_UNSUPPORTED', family: 'limit', summary: 'entry が大きすぎる' },
  LIMIT_BODY_BYTES_UNSUPPORTED: { status: 'ARCHIVE_UNSUPPORTED', family: 'limit', summary: '本体が大きすぎる' },
  LIMIT_TOTAL_BYTES_UNSUPPORTED: { status: 'ARCHIVE_UNSUPPORTED', family: 'limit', summary: '合計が大きすぎる' },

  /**
   * ---- ここから下が v0.6.14 で足した 5 つ（外部監査 P0・すべてこちらで再現済み）----
   */
  /** 壊れた gzip。**v16 notes は「付けた」と書いていたが、実装されていなかった** */
  GZIP_DECODE_FAILED: { status: 'ARCHIVE_INVALID', family: 'container', summary: 'gzip を展開できない' },
  /** 手元の archive ファイルが、展開する前の時点で大きすぎる */
  LIMIT_COMPRESSED_BYTES_UNSUPPORTED: { status: 'ARCHIVE_UNSUPPORTED', family: 'limit', summary: '圧縮された状態で大きすぎる' },
  /** source として渡された root が symlink。**指す先ごと差し替えられる** */
  SOURCE_ROOT_SYMLINK: { status: 'ARCHIVE_INVALID', family: 'source', summary: 'source root が symlink' },
  /** source directory を読めない（権限・消えた・その他 OS のエラー） */
  SOURCE_DIRECTORY_UNREADABLE: { status: 'ARCHIVE_UNSUPPORTED', family: 'source', summary: 'source ディレクトリを読めない' },
  /** directory の中に FIFO・socket・device がある */
  SOURCE_SPECIAL_NODE: { status: 'ARCHIVE_UNSUPPORTED', family: 'source', summary: '通常ファイルでも directory でもないノード' },
}

/**
 * **`*_OTHER` は予期しない内部不具合の受け皿だけ。**
 * 既知の経路がここへ落ちたら、それは catalog への登録漏れである。
 */
export const OTHER_CODES = ['ARCHIVE_INVALID_OTHER', 'ARCHIVE_UNSUPPORTED_OTHER']

/** catalog に載っているか。載っていなければ投げる（静かに `*_OTHER` へ落とさない） */
export function assertCatalogued(code) {
  if (!Object.hasOwn(REASON_CODES, code)) {
    throw new Error(`stableReasonCode "${code}" は catalog（scripts/reasonCodes.mjs）に無い。`
      + '**新しい止め方を足したら catalog にも足すこと。**登録しないと受け手は機械で分岐できない。')
  }
  return code
}

/** その code で止まるときの CLI status */
export function statusOf(code) {
  return assertCatalogued(code) && REASON_CODES[code].status
}

export const TOOL_VERSION = 17

/**
 * **この道具が出しうる status と、そのときの終了コード（v0.6.11・外部監査 §7）。**
 *
 * v0.6.10 まで、試験はこの一覧を**ソースの正規表現から拾って**いた。
 * `status` の書き方を三項演算子へ変えただけで拾えなくなり、
 * **「増えたら気づく」はずの検査が黙って空振りした。**一覧は道具が名乗る。
 *
 * **v0.6.12: 終了コードもここへ入れた。**それまで終了コードは
 * ①この上のコメント ②`buildReleaseEvidence.mjs` の `EXIT_OF`
 * ③配布物へ載る `howToVerifyYourself` の 1 行 の 3 か所に手書きされていて、
 * **②と③は 5 種類しか知らないまま v0.6.11 として出荷された。**
 * `VERIFICATION_INCOMPLETE` はその版の目玉なのに、受け手に伝わっていなかった。
 * **同じ境界は 1 か所で持つ。**
 *
 *   OK                      … 必須の工程が全部終わり、全件一致した
 *   MISMATCH                … 不一致・記録漏れ・自己参照がある
 *   VERIFICATION_INCOMPLETE … 必須の工程を実行できていない
 *   ARCHIVE_INVALID         … source が壊れている／曖昧
 *   ARCHIVE_UNSUPPORTED     … 展開はできるが、この道具の範囲の外
 *   SOURCE_UNAVAILABLE      … source を取れなかった
 *   MANIFEST_UNAVAILABLE    … manifest を読めなかった
 *   NOTHING_TO_VERIFY       … 入力 0 件で何も見ていない
 */
/**
 * **v0.6.14: status に紐づくものを全部ここへ入れた（外部監査 P1-C）。**
 *
 * v0.6.13 まで、`KNOWN_LOAD_KINDS`（loader が返してよい status の 2 要素配列）と
 * `NOTE`（受け手向けの注記の map）が**別の場所に手書き**されていた。
 * status を足したとき `KNOWN_LOAD_KINDS` を直し忘れると、
 * **その status は黙って `SOURCE_UNAVAILABLE` へ丸められる**——
 * 「取れなかった」と「壊れていた」が入れ替わる、いちばん避けたい丸め方である。
 *
 *   exit      … その status のときの終了コード
 *   fromLoad  … source の読み込みが返してよい status か（false なら丸める対象）
 *   note      … 受け手向けの注記。**分岐に使わない**（無い status は注記も無い）
 */
export const CLI_STATUS_META = {
  OK: { exit: 0, fromLoad: false },
  MISMATCH: { exit: 1, fromLoad: false },
  VERIFICATION_INCOMPLETE: { exit: 1, fromLoad: false },
  ARCHIVE_INVALID: {
    exit: 2,
    fromLoad: true,
    note: '**これは不一致ではない。**archive そのものが壊れているか、安全に読めない形だったので、'
      + '中身を見ていない。渡した source を疑うこと。',
  },
  ARCHIVE_UNSUPPORTED: {
    exit: 2,
    fromLoad: true,
    note: '**これは不一致ではない。archive が壊れているとも言っていない。**'
      + 'ふつうの tar なら展開できるが、この道具が扱うと決めた範囲の外だったので中身を見ていない。'
      + '別の経路（展開してから --source <ディレクトリ>）で確かめられることがある。',
  },
  SOURCE_UNAVAILABLE: {
    exit: 2,
    fromLoad: true,
    note: '**これは不一致ではない。**source を取れなかったので、検証していない。'
      + 'network を使わずに確かめるなら --source <展開済みディレクトリ> を渡すこと。',
  },
  MANIFEST_UNAVAILABLE: { exit: 2, fromLoad: false },
  NOTHING_TO_VERIFY: { exit: 2, fromLoad: false },
}

/** **導出する。**別に並べると、また 2 つ目の一覧になる */
export const CLI_STATUS_EXIT = Object.fromEntries(
  Object.entries(CLI_STATUS_META).map(([s, m]) => [s, m.exit]),
)
export const CLI_STATUSES = Object.keys(CLI_STATUS_META)

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
/**
 * **manifest に縛られていない範囲定義を、明示的に許す（v0.6.11・外部監査 §1）。**
 * v0.3.0 より前の tag は manifest に `inputScope` を持たないので、ここを通さないと検算できない。
 * **許しても `OK` にはならない**——縛られていない範囲では「範囲の中に漏れが無い」と言えないため。
 */
const ALLOW_UNPINNED_SCOPE = argv.includes('--allow-unpinned-scope')

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
/**
 * **受け手向けの結果は、それ自身が何であるかを名乗る（v0.6.11・外部監査 §7）。**
 *
 * v0.6.10 まで、この出力に契約は無かった。受け手は**こちらが回した記録**
 * （`source-verification-result.v1`）の説明を CLI の status 一覧として読むしかなく、
 * その 2 つは**出る status が違う**（作業ツリーを読む経路では archive 系が出ない）。
 * 別の schema にして、**出力そのものに `schemaId` を入れる。**
 *
 * `exitCode` も入れる——**JSON を保存したあとで終了コードを復元できない**ため。
 */
const done = (payload, code) => {
  console.log(JSON.stringify({
    schemaVersion: 1,
    schemaId: 'trs-jack-3d-source-verifier-cli-result.v1',
    kind: 'source-verifier-cli-result',
    toolVersion: TOOL_VERSION,
    exitCode: code,
    /** 止めた理由の変わらない名前。`OK` / `MISMATCH` では null */
    stableReasonCode: payload.stableReasonCode ?? null,
    /** **この道具が受け入れる archive の範囲。**受け手が「何を通す道具か」を機械で読める */
    archivePolicy: {
      acceptedHeaderFormats: ['posix-ustar', 'old-gnu', 'v7', 'unknown'],
      prefixUsedOnlyFor: 'posix-ustar',
      acceptedTypeflags: [...SUPPORTED_TYPEFLAGS].sort(),
      endOfArchiveConvention: 'two-zero-blocks; trailing partial block after the terminator is ignored',
      limits: TAR_LIMITS,
      /**
       * **ここに載っていない規則がある（v0.6.14・外部監査 P1-D）。**
       * `archivePolicy` という名前は「この道具が受け入れる範囲の全部」と読めるが、
       * 実際に機械で読める形にしてあるのは上の 5 つだけ。
       * PAX の鍵の扱い・パスの綴り・リンクの指す先・checksum・重複は、
       * **止め方の名前（`stableReasonCode`）でしか表に出ていない。**
       * 名前を変えると schema が狭まって下流が止まるので、**覆っていない範囲を明示する欄を足した。**
       */
      notMachineReadableHere: [
        'pax-key-handling', 'path-spelling', 'link-target-resolution',
        'header-checksum', 'duplicate-path', 'root-strip',
      ],
      /** 上の 6 つを含む止め方の全体像は、この道具が返す stableReasonCode で見る */
      reasonCodeFamilies: [...new Set(Object.values(REASON_CODES).map((r) => r.family))].sort(),
    },
    ...payload,
  }, null, 1))
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

/**
 * **止め方は catalog に登録した名前でしか作れない（v0.6.14・外部監査 P0）。**
 *
 * v0.6.13 まで、`stableReasonCode` を付け忘れた経路は**黙って `*_OTHER` へ落ちて**いた。
 * 実測（2026-08-12）: 壊れた gzip も、source root が symlink の場合も
 * `ARCHIVE_INVALID_OTHER` を返していた。**しかも v16 notes は
 * 「gzip の失敗に `GZIP_DECODE_FAILED` を付けた」と書いていた**——その名前は
 * source 全体でコメント 1 件にしか存在しなかった。
 *
 * ここで投げるようにすると、**付け忘れは実行した瞬間に分かる。**
 * catalog の `status` と例外の種類が食い違うのも同時に止める——
 * `ARCHIVE_UNSUPPORTED` の code を `ArchiveInvalid` で投げると、
 * 受け手は「壊れている」と「範囲の外」を読み分けられなくなる。
 */
function assertCodeFor(kind, detail) {
  const code = detail?.stableReasonCode
  if (!code) {
    throw new Error(`${kind} を stableReasonCode 無しで作ろうとした。`
      + '**付け忘れた止め方は黙って *_OTHER へ落ちる。**scripts/reasonCodes.mjs に登録して名前を渡すこと。')
  }
  assertCatalogued(code)
  const want = REASON_CODES[code].status
  if (want !== kind) {
    throw new Error(`stableReasonCode "${code}" は catalog では ${want} だが、${kind} として投げている。`
      + '**受け手は「壊れている」と「範囲の外」を読み分けるので、ここを取り違えない。**')
  }
}

/** archive が壊れている／敵対的であることを表す。**取れなかった（SOURCE_UNAVAILABLE）とは別物** */
export class ArchiveInvalid extends Error {
  constructor(reason, detail = {}) {
    super(reason)
    this.name = 'ArchiveInvalid'
    assertCodeFor('ARCHIVE_INVALID', detail)
    this.detail = detail
  }
}

/**
 * **壊れてはいないが、この道具が扱う範囲の外（v0.6.7・外部監査 P1-C）。**
 *
 * v0.6.6 までは、`ARCHIVE_INVALID` が 2 つの別々のことを言っていた。
 *
 * ```
 * ふつうの tar が展開できない（矛盾・破損・実装間で結末が割れる）
 * ふつうの tar は展開できるが、こちらが対応範囲に入れていない
 * ```
 *
 * **後者を「壊れている」と言うのは嘘である。**実測（2026-08-10）:
 *
 * ```
 * base-256 の size 欄     検算 v11 ARCHIVE_INVALID ／ bsdtar exit 0 ／ python exit 0
 * typeflag 7（contiguous） 検算 v11 ARCHIVE_INVALID ／ bsdtar exit 0 ／ python exit 0
 * ```
 *
 * **exit code も status の重みも変えない**（どちらも 2 で、`OK` にはならない）。
 * 変わるのは受け手が読む理由だけ——「この archive を直せ」なのか
 * 「この道具では読めないので別の経路で確かめてくれ」なのかが分かれる。
 */
export class ArchiveUnsupported extends Error {
  constructor(reason, detail = {}) {
    super(reason)
    this.name = 'ArchiveUnsupported'
    assertCodeFor('ARCHIVE_UNSUPPORTED', detail)
    this.detail = detail
  }
}

/**
 * **`{ kind: 'ARCHIVE_*' }` を直に組み立てず、ここを通す（v0.6.14・外部監査 P0）。**
 *
 * 直に組み立てていた 5 か所は、`stableReasonCode` を持たないまま `*_OTHER` になっていた。
 * `kind` は catalog から引くので、**code と kind が食い違いようがない。**
 */
export function archiveError(code, error, detail = {}) {
  assertCatalogued(code)
  return {
    error,
    kind: REASON_CODES[code].status,
    detail: { ...detail, stableReasonCode: code },
    stableReasonCode: code,
  }
}

/** ヘッダの checksum を検算する。checksum 欄を空白 8 個で埋めた状態の総和 */
/**
 * **USTAR の数値欄を、欄まるごと読む（v0.6.8・外部監査 P0-A）。**
 *
 * v0.6.7 までは `size` だけを `/^[0-7]+$/` で見て、
 * **`mode` / `uid` / `gid` / `mtime` / `devmajor` / `devminor` は読んでもいなかった。**
 * そのため、欄に `abc` を書いて checksum を取り直した archive を `status OK` と言っていた。
 * 実測（2026-08-11）:
 *
 * ```
 * mode=abc / uid=abc / gid=abc / mtime=abc （checksum は取り直し）
 *   検算 v12  READ（a.txt が source にある、と言う）
 *   bsdtar    exit 0 — a.txt を作る
 *   python    exit 0 — **黙って a.txt を作らない**（OK と表示して終わる）
 * ```
 *
 * **同じ archive から別の木ができる。**受け手が python 側で展開すると、
 * 検算器が「あった」と言ったファイルが手元に無い。
 *
 * 受け入れる形は実物を測って決めた（2026-08-11・4 種類あった）:
 *
 * ```
 * GitHub tarball / git archive   7 桁 + NUL          size と mtime は 11 桁 + NUL
 * macOS tar (bsdtar)             6 桁 + 空白 + NUL   size と mtime は 11 桁 + 空白
 * checksum 欄                    7 桁 + NUL ／ 6 桁 + NUL + 空白
 * ```
 *
 * まとめると **「先頭の空白（任意）＋ 8 進数字 1 個以上 ＋ NUL と空白だけの詰め物」**。
 * 空欄（全部 NUL か空白）は 0 とみなす——古い writer が device 欄を空で書くため。
 * ただし **checksum 欄だけは空を許さない**（数字が無ければ検算しようがない）。
 *
 * @param required 空欄を 0 として受けないなら true（checksum 欄）
 */
function parseTarNumericField(bytes, name, entryIndex, required = false) {
  /** base-256 表記（GNU 拡張）。**壊れているのではなく、この道具が読まないだけ** */
  if ((bytes[0] & 0x80) !== 0) {
    throw new ArchiveUnsupported(
      `${name} 欄が base-256 表記である（この道具は 8 進数の欄しか読まない）`,
      { field: name, entryIndex , stableReasonCode: 'HEADER_NUMERIC_FIELD_BASE256_UNSUPPORTED' },
    )
  }
  const text = bytes.toString('latin1')
  if (/^[\0 ]*$/.test(text)) {
    if (required) {
      throw new ArchiveInvalid(`${name} 欄が空である`, { field: name, entryIndex, stableReasonCode: 'HEADER_NUMERIC_FIELD_SYNTAX' })
    }
    return 0
  }
  const m = /^ *([0-7]+)[\0 ]*$/.exec(text)
  if (!m) {
    throw new ArchiveInvalid(
      `${name} 欄が 8 進数の書式になっていない`,
      { field: name, entryIndex, raw: JSON.stringify(text).slice(0, 40) , stableReasonCode: 'HEADER_NUMERIC_FIELD_SYNTAX' },
    )
  }
  const v = parseInt(m[1], 8)
  if (!Number.isSafeInteger(v)) {
    throw new ArchiveInvalid(`${name} 欄が扱える範囲を超えている`, { field: name, entryIndex, stableReasonCode: 'HEADER_NUMERIC_FIELD_RANGE' })
  }
  return v
}

/**
 * ヘッダの checksum を検算する。checksum 欄を空白 8 個で埋めた状態の総和。
 *
 * **歴史的な signed 版も通す（v0.6.8・外部監査 P1-C）。**
 *
 * 古い tar は、ヘッダのバイトを **符号つき char** として足していた。
 * 128 以上のバイト（非 ASCII のパスなど）があると値が食い違う。実測（2026-08-11）:
 *
 * ```
 * 非 ASCII の名前 + signed checksum
 *   検算 v12  ARCHIVE_INVALID — ヘッダの checksum が合わない
 *   bsdtar    exit 0 ／ python exit 0（どちらも展開する）
 * ```
 *
 * **どちらの和でも合えば受ける。**両方を計算するだけで、緩めたことにはならない
 * （どちらにも合わないヘッダは、これまでどおり落ちる）。
 */
function headerChecksumOk(header, entryIndex) {
  // 欄の書式そのものを見る（前方一致だけだと、8 進のあとの junk を見逃す）
  const stored = parseTarNumericField(header.subarray(148, 156), 'checksum', entryIndex, true)
  let unsigned = 0
  let signed = 0
  for (let i = 0; i < 512; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : header[i]
    unsigned += b
    signed += b >= 128 ? b - 256 : b
  }
  return stored === unsigned || stored === signed
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
  /**
   * **長さの上限は方針であって、archive の欠陥ではない（v0.6.7・外部監査 P1-C）。**
   * 実測（2026-08-10）: 1,100 文字のパスを bsdtar も python も exit 0 で展開する
   * （tar は階層を 1 つずつ作るので PATH_MAX に当たらない）。
   */
  if (name.length > TAR_LIMITS.maxPathLength) {
    throw new ArchiveUnsupported(`entry のパスが長すぎる (${name.length} > ${TAR_LIMITS.maxPathLength})`, { name: name.slice(0, 80), stableReasonCode: 'PATH_TOO_LONG_UNSUPPORTED' })
  }
  if (name.startsWith('/')) throw new ArchiveInvalid('絶対パスの entry がある', { name, stableReasonCode: 'PATH_ABSOLUTE' })
  if (/^[A-Za-z]:/.test(name)) throw new ArchiveInvalid('ドライブレターつきの entry がある', { name, stableReasonCode: 'PATH_DRIVE_LETTER' })
  /**
   * **バックスラッシュは「壊れている」ではなく「OS で意味が変わる」（v0.6.8・外部監査 §7）。**
   * Unix ではふつうの名前の一部になり（GNU tar・bsdtar・python とも同じ木を作る・実測）、
   * Windows では 1 階層上を指す。**受け手の OS で結末が変わるものは、範囲の外と言う。**
   */
  if (name.includes('\\')) {
    throw new ArchiveUnsupported('バックスラッシュを含む entry がある（OS によって意味が変わる）', { name, stableReasonCode: 'PATH_BACKSLASH_UNSUPPORTED' })
  }
  if (name.split('/').includes('..')) throw new ArchiveInvalid('.. を含む entry がある（archive の外を指す）', { name, stableReasonCode: 'PATH_TRAVERSAL' })
  assertCanonicalPath(name)
}

/**
 * **同じ場所を指す別の綴りを拒む（v0.6.2・外部監査 P0-2）。**
 *
 * v0.6.1 は「文字列として同じか」だけを見ていたので、次が別物として通っていた（実測）。
 *
 * ```
 * root/file.txt    = FIRST      ← 検算はこちらを「source にあった」と言う
 * root/./file.txt  = SECOND     ← ふつうの tar で展開するとこちらが残る
 * ```
 *
 * **受け手が検算した中身と、展開して手元にできる中身が違う。**
 * これは「合っている」と言いながら別のものを渡せるということで、
 * checksum を通す意味そのものが無くなる。
 *
 * **正規化して受け入れない。拒む。**正規化して通すと、
 * 「どの綴りで来ても同じ 1 つに畳む」という別の判断が要る——
 * 畳んだ先が衝突したときにどちらを採るかを、また決めることになる。
 * **正しい source archive はこんな綴りを含まない**（実物の GitHub tarball で確認済み）。
 */
function assertCanonicalPath(name) {
  const parts = name.split('/')
  if (parts.includes('.')) {
    throw new ArchiveInvalid('. を含む entry がある（同じ場所を別の綴りで指せてしまう）', { name, stableReasonCode: 'PATH_NOT_CANONICAL' })
  }
  if (parts.some((p) => p === '')) {
    throw new ArchiveInvalid('空のパス要素がある（// や末尾の / を含む）', { name, stableReasonCode: 'PATH_EMPTY_COMPONENT' })
  }
  if (Array.from(name).some((c) => c.codePointAt(0) < 0x20 || c.codePointAt(0) === 0x7f)) {
    throw new ArchiveInvalid('制御文字を含む entry がある', { name: JSON.stringify(name).slice(0, 80), stableReasonCode: 'PATH_CONTROL_CHARACTER' })
  }
  /**
   * **前後の空白を許さない（v0.6.3・外部監査 P0-3）。**
   *
   * v0.6.2 はヘッダの文字列を読むときに `.trim()` していた。
   * そのため `root/file.txt␠`（末尾に空白）が `root/file.txt` として登録され、
   * **ふつうに展開すると空白つきの別ファイルができる**のに、検算は空白なしを見ていた（実測）。
   *
   * 途中の空白は許す（`my file.txt` は正当な名前）。**端の空白だけを拒む。**
   */
  for (const part of name.split('/')) {
    if (part !== part.trim()) {
      throw new ArchiveInvalid('パス要素の前後に空白がある（展開結果と食い違う）', { name: JSON.stringify(name).slice(0, 80), stableReasonCode: 'PATH_SURROUNDING_SPACE' })
    }
  }
}

/**
 * **PAX（`x` / `g`）のレコードを読む（v0.6.3・外部監査 P0-1）。**
 *
 * v0.6.2 は PAX を「中身をファイルとして拾わない」だけで読み飛ばしていた。
 * だが **PAX は後続 entry の意味を変えられる。**実測でこうなった。
 *
 * ```
 * ヘッダの名前 root/file.txt ／ PAX path=root/other.txt ／ 中身 EXPECTED
 *   検算器 : file.txt = EXPECTED     status OK
 *   実展開 : root/other.txt ができ、root/file.txt は存在しない
 *
 * ヘッダの size 8 ／ PAX size=4 ／ 中身 ABCDEFGH
 *   検算器 : file.txt = ABCDEFGH (8 B)  status OK
 *   実展開 : root/file.txt = ABCD (4 B)
 * ```
 *
 * **拾わないことと、無かったことにするのは別である。**
 * 「PAX を完全に実装する」か「意味を変える鍵があったら止める」かの二択で、後者を採る——
 * sparse や `linkpath` まで正しく実装する面積は、この道具が引き受けるべき量を超える。
 *
 * 形式は `"<全長> <鍵>=<値>\n"` で、`<全長>` は自身を含む。
 * **読めない形式も拒む**（読めないものを黙って飛ばすと、そこに何が書いてあっても通る）。
 */
/**
 * **中身の見え方を変える鍵。**`path` はここに入れない——正しく解釈する（下）。
 *
 * | 鍵 | なぜ止めるか |
 * |---|---|
 * | `size` | データの範囲が変わる。実測: ヘッダ 8 / PAX 4 で、展開は 4 バイトになる |
 * | `linkpath` | リンク先が変わる。リンクは読み飛ばすが、名前の衝突判定に影響しうる |
 * | `hdrcharset` | **ヘッダの解釈が変わる**ので、名前そのものが別物になりうる |
 * | `GNU.sparse.*` / `SCHILY.realsize` | 疎ファイル。archive の中身と実ファイルが一致しない |
 *
 * `mtime` / `uid` / `xattr` などは**見え方を変えないので通す。**
 * 実物の macOS tar は `mtime` と `LIBARCHIVE.xattr.*` / `SCHILY.xattr.*` を書く（実測）。
 * ここを prefix `SCHILY.` で一括で止めると、**ふつうに作った tar.gz が読めなくなる。**
 */
/**
 * **PAX の鍵は allowlist で受ける（v0.6.5・外部監査 P0-4）。**
 *
 * v0.6.4 までは「見え方を変える鍵」を denylist で拒み、**未知の鍵は通していた。**
 * その denylist は閉じていない。実測（2026-08-08）:
 *
 * ```
 * PAX x: SUN.holesdata=...（Solaris の sparse map）
 *   検算 v9  status OK（未知の鍵として無視）
 *   bsdtar   exit 1 — Parse error: SUN.holesdata で archive ごと拒否
 *   python   展開できる
 * ```
 *
 * **3 者で結末が割れる。**未知の鍵を通す限り、この形は数え上げでは閉じない。
 *
 * 通す鍵は「**パスにも中身のバイト列にも影響しない**と言えるもの」だけにする。
 * 実物に出てくる鍵は実測で数えた（GitHub tarball は `g:comment` のみ、
 * macOS の `tar` は `x:mtime` と `x:LIBARCHIVE.xattr.*` / `x:SCHILY.xattr.*`）。
 * `path` だけは**解釈する**（GNU tar が長いパスに使う正当な機能）。
 */
const PAX_KEYS_ALLOWED = new Set([
  'path', 'linkpath',                       // 解釈する（linkpath は v0.6.6 で追加）
  'mtime', 'atime', 'ctime',                // 時刻
  'uid', 'gid', 'uname', 'gname',           // 所有者（POSIX 標準・view を変えない）
  'comment',                                // GitHub の global header
])

/**
 * **通す鍵は、値の文法まで見る（v0.6.6・外部監査 P0-2）。**
 *
 * v0.6.5 は**鍵の名前だけ**を見ていた。`uid=abc` や `mtime=abc` のように
 * 数値であるべき欄に読めない値が入っていても通していた。実測（監査）:
 * **GNU tar は `Malformed extended header` で exit 2**、bsdtar・BusyBox・python は通す。
 *
 * **「view を変えない鍵だから通す」という理屈は、値が読める前提に乗っている。**
 * 読めない値は読み手ごとの挙動が決まらないので、そこで割れる。
 *
 * POSIX pax の書式に合わせる（`uid`/`gid` は 10 進整数、時刻は 10 進の秒。
 * 小数部を許す）。`uname`/`gname`/`comment` は自由文字列なので形は見ない。
 */
/**
 * **先頭のゼロを許す（v0.6.8・外部監査 P1-B）。**
 *
 * v0.6.7 は「正規の綴り」まで要求していた（`^(0|[1-9][0-9]*)$`）。
 * だが POSIX pax の値は 10 進の数であって、綴りを 1 つに決めてはいない。実測（2026-08-11）:
 *
 * ```
 * uid=0001 / gid=0001 / mtime=01 / mtime=-01
 *   検算 v12  ARCHIVE_INVALID — 数値として読めない
 *   bsdtar    exit 0 ／ python exit 0（どちらも同じ木を作る）
 * ```
 *
 * **これは前回の監査の勧告どおりに書いた正規表現が、そのまま過剰拒否になった例である。**
 * 範囲の検査は綴りではなく**読んだあとの値**に掛ける（`BigInt('0001')` は 1）。
 * `+1`・指数・NaN・Infinity は引き続き拒む。
 */
const PAX_VALUE_GRAMMAR = {
  uid: /^[0-9]+$/,
  gid: /^[0-9]+$/,
  /**
   * **小数部は省略できる（v0.6.10・外部監査 P1）。**実測（2026-08-11）:
   * `mtime=1.` を bsdtar も python も受理して同じ木を作るのに、こちらは拒んでいた。
   * POSIX は「小数点のあとに数字が無い」形を禁じていない。**範囲検査は読んだあとの値に掛ける。**
   */
  mtime: /^-?[0-9]+(\.[0-9]*)?$/,
  atime: /^-?[0-9]+(\.[0-9]*)?$/,
  ctime: /^-?[0-9]+(\.[0-9]*)?$/,
}

/**
 * **文法を通っても、範囲の外なら止める（v0.6.7・外部監査 P0-C）。**
 *
 * 「読める形をしている」と「読み手が扱える」は別である。実測（2026-08-10）:
 *
 * ```
 * mtime=9223372036854775807   bsdtar exit 0 ／ python exit 2（OverflowError）  ← 割れる
 * mtime=9007199254740992      bsdtar exit 0 ／ python exit 0                    ← 通る
 * mtime=-1 / -9223372036854775808   両方 exit 0                                  ← 通る
 * ```
 *
 * 時刻の上限は **2^53−1（この道具が誤差なく持てる整数の上限）**に置く。
 * 「自分が正確に表せない数を受け取らない」という言い方ができ、
 * 実測でも両実装が通す範囲の内側にある。実物の mtime は 1.8×10^9 なので約 500 万倍の余裕。
 *
 * `uid`/`gid` の上限 2^32−1 は **手元では再現していない。**
 * 手元の 2 実装は 2^64 でも通す（実測）。監査の GNU tar 1.35 が
 * `is out of range 0..4294967295` で拒む、という報告にもとづく。
 * Unix の `uid_t` が 32bit なので、正当な archive がこれを超えることは無い。
 */
const PAX_VALUE_RANGE = {
  uid: [0n, 4294967295n],
  gid: [0n, 4294967295n],
  mtime: [-9007199254740991n, 9007199254740991n],
  atime: [-9007199254740991n, 9007199254740991n],
  ctime: [-9007199254740991n, 9007199254740991n],
}

/**
 * **名前として表示される鍵は、厳密 UTF-8 で読めることまで見る（v0.6.7・外部監査 P0-C）。**
 *
 * 実測（2026-08-10）: `uname` / `gname` に不正な UTF-8 を入れると
 * **bsdtar 3.5.3 は exit 1**（`Uname can't be converted from UTF-8 to current locale.`）、
 * python は通す。**割れるものは受理しない。**
 *
 * **`comment` は入れない。**同じ不正 UTF-8 を `comment` に入れて測ると
 * **bsdtar も python も exit 0** だった（実測）。監査は `comment` も
 * strict text にすることを勧めているが、**こちらの実測では割れないので従っていない。**
 * 塞ぎすぎは 3 版続けて出しているので、根拠のない厳格化はしない。
 *
 * **NUL も入れない。**`uname` に NUL を混ぜて測ると両実装とも exit 0 だった（実測）。
 */
const PAX_KEYS_STRICT_TEXT = new Set(['uname', 'gname'])
/** 値を読まない不透明な metadata。**中身のバイト列の外側**であることを明記して通す */
const PAX_PREFIXES_ALLOWED = ['LIBARCHIVE.xattr.', 'SCHILY.xattr.']
/** 既定拒否のうち、特に何が起きるかを言えるもの（メッセージ用） */
const PAX_KEYS_KNOWN_DANGEROUS = ['size', 'linkpath', 'hdrcharset', 'charset', 'SCHILY.realsize', 'SUN.holesdata']

/**
 * **PAX（`x` / `g`）のレコードを読む（v0.6.3・外部監査 P0-1）。**
 *
 * v0.6.2 は PAX を「中身をファイルとして拾わない」だけで読み飛ばしていた。
 * だが **PAX は後続 entry の意味を変えられる。**実測でこうなった。
 *
 * ```
 * ヘッダの名前 root/file.txt ／ PAX path=root/other.txt ／ 中身 EXPECTED
 *   検算器 : file.txt = EXPECTED     status OK
 *   実展開 : root/other.txt ができ、root/file.txt は存在しない
 *
 * ヘッダの size 8 ／ PAX size=4 ／ 中身 ABCDEFGH
 *   検算器 : file.txt = ABCDEFGH (8 B)  status OK
 *   実展開 : root/file.txt = ABCD (4 B)
 * ```
 *
 * **`path` は拒まずに解釈する。**GNU tar は長いパスを `path=` で書くので、
 * 拒むと**ふつうに作った tar.gz が読めなくなる。**解釈すれば展開と同じものが見える。
 * 見え方を変えるのに解釈しない鍵（`size` など）だけを止める。
 *
 * **レコード長はバイト数である。**v0.6.3 の最初の実装は decode 後の文字列で数えていて、
 * xattr に生バイトを入れる実物の tar（macOS）を「壊れている」と誤判定した。
 * ここは Buffer のまま数える。
 *
 * 形式は `"<全長> <鍵>=<値>\n"` で `<全長>` は自身を含む。
 * **読めない形式も拒む**（読めないものを黙って飛ばすと、そこに何が書いてあっても通る）。
 */
/**
 * **リンクの指す先の綴りを揃える（v0.6.7・外部監査 P1-B）。**
 *
 * v0.6.6 は指す先を**そのまま文字列比較**し、末尾スラッシュだけ剥がしていた。
 * そのため、正当な綴りを拒み、展開できない綴りを受理していた。実測（2026-08-10）:
 *
 * ```
 * root/./A       検算 v11 ARCHIVE_INVALID ／ bsdtar exit 0 ／ python exit 0  ← 過剰拒否
 * ./root/A       検算 v11 ARCHIVE_INVALID ／ bsdtar exit 0 ／ python exit 0  ← 過剰拒否
 * root//A        検算 v11 ARCHIVE_INVALID ／ bsdtar exit 0 ／ python exit 0  ← 過剰拒否
 * root/A/        検算 v11 READ            ／ bsdtar exit 1 ／ python exit 0  ← **false-OK**
 * root/sub/../A  検算 v11 ARCHIVE_INVALID ／ bsdtar exit 1 ／ python exit 0  ← 割れる
 * ```
 *
 * **末尾スラッシュの行（false-OK）は監査の指摘ではなく、こちらの実測で見つけた。**
 * v0.6.6 は `.replace(/\/+$/, '')` で剥がしていたので、
 * bsdtar が `Can't create ...: Not a directory` で展開できない archive を `READ` と言っていた。
 *
 * したがって **`.` と空要素だけ畳み、`..` と末尾スラッシュは畳まずに拒む。**
 * 「どこまで揃えるか」を気分ではなく**実測に合わせる**ということである。
 */
function canonicalLinkTarget(raw, name, entryIndex) {
  if (raw === '') {
    throw new ArchiveInvalid(`リンクの指す先が空である: ${name}`, { name, entryIndex, stableReasonCode: 'LINK_TARGET_EMPTY' })
  }
  if (raw.endsWith('/')) {
    throw new ArchiveInvalid(
      `リンクの指す先が / で終わっている（展開できない）: ${name} -> ${raw.slice(0, 80)}`,
      { name, linkname: raw.slice(0, 200), entryIndex , stableReasonCode: 'LINK_TARGET_TRAILING_SLASH' },
    )
  }
  const joined = raw.split('/').filter((p) => p !== '' && p !== '.').join('/')
  if (!joined) {
    throw new ArchiveInvalid(`リンクの指す先がパスになっていない: ${name} -> ${raw.slice(0, 80)}`, { name, entryIndex, stableReasonCode: 'LINK_TARGET_NOT_A_PATH' })
  }
  /**
   * **entry の名前と同じ規則を当てる。**別々に書くと、片方だけ直したときに規則がずれる。
   * 理由文だけリンク向けに言い換える。
   */
  try {
    assertSafePath(joined)
  } catch (e) {
    // 上限超過は「対応していない」のままにする（壊れているとは言わない）
    if (e instanceof ArchiveUnsupported) throw e
    throw new ArchiveInvalid(
      `リンクの指す先の綴りを受け取れない: ${name} -> ${raw.slice(0, 80)}（${e.message}）`,
      { name, linkname: raw.slice(0, 200), entryIndex , stableReasonCode: 'LINK_TARGET_NOT_CANONICAL' },
    )
  }
  return joined
}

/**
 * **長さ 0 の PAX 値を表す印（v0.6.9）。**空文字列と区別する必要がある——
 * 「上書きを消す」であって「空の名前へ上書きする」ではない。
 */
const ZERO_LENGTH_PAX_VALUE = Symbol('zero-length-pax-value')

/**
 * **名前を消す上書きは受けない（v0.6.9・外部監査 P0-C）。**
 *
 * 指示書は「POSIX の削除意味を実装し、生ヘッダの名前へ戻す」と勧めている。
 * **こちらは採らなかった。**実測（2026-08-11）で**2 実装の結末が割れる**からである。
 *
 * ```
 * x: path=（長さ 0）＋ 生ヘッダ root/raw.txt
 *   検算 v13  READ — files 0 件（member が丸ごと消える＝これが穴）
 *   bsdtar    exit 0 — root/raw.txt を作る（削除意味を実装している）
 *   python    exit 2 — IsADirectoryError（空の名前として扱う）
 *
 * x: linkpath=（長さ 0）＋ 生ヘッダ linkname root/a.txt
 *   bsdtar    root/l -> root/a.txt
 *   python    root/l -> （空の指す先）
 * ```
 *
 * 削除意味を実装すると **bsdtar とは一致するが python とは一致しない。**
 * この道具の約束は「ここに挙げた物が、展開して出てくる物と同じ」なので、
 * **読み手によって出てくる物が違う archive では、その約束を果たせない。**
 * v0.6.6 以来の「割れるものは受理しない」と同じ規則を当てる。
 */
function assertPaxNameValue(v, key, entryIndex) {
  if (v === ZERO_LENGTH_PAX_VALUE) {
    throw new ArchiveInvalid(
      `PAX の ${key} が長さ 0 である。上書きを消すのか空の名前にするのかで読み手ごとに結末が割れる`,
      { key, entryIndex, stableReasonCode: 'PAX_ZERO_LENGTH_NAME_AMBIGUOUS' },
    )
  }
  return v
}

function readPaxRecords(data, kind) {
  const out = new Map()
  let i = 0
  while (i < data.length) {
    const sp = data.indexOf(0x20, i)   // 半角空白
    if (sp < 0) throw new ArchiveInvalid(`PAX (${kind}) のレコードが読めない（長さの区切りが無い）`, { at: i, stableReasonCode: 'PAX_RECORD_INVALID' })
    const lenText = data.subarray(i, sp).toString('ascii')
    const len = Number(lenText)
    if (!/^[0-9]+$/.test(lenText) || !Number.isInteger(len) || len <= 0 || i + len > data.length) {
      throw new ArchiveInvalid(`PAX (${kind}) のレコード長が壊れている`, { at: i, len: lenText.slice(0, 20), stableReasonCode: 'PAX_RECORD_INVALID' })
    }
    const rec = data.subarray(sp + 1, i + len)
    if (rec[rec.length - 1] !== 0x0a) throw new ArchiveInvalid(`PAX (${kind}) のレコードが改行で終わっていない`, { at: i, stableReasonCode: 'PAX_RECORD_INVALID' })
    const eq = rec.indexOf(0x3d)       // =
    if (eq < 0) throw new ArchiveInvalid(`PAX (${kind}) のレコードに = が無い`, { at: i, stableReasonCode: 'PAX_RECORD_INVALID' })
    /**
     * **鍵は厳密に、値は「解釈する鍵」だけ厳密に読む（v0.6.4・外部監査 P0-C）。**
     *
     * v0.6.3 は両方 `toString('utf8')` だったので、`path=` の値に不正なバイトを入れると
     * U+FFFD へ置換されたまま**名前として採用**された（実測: `file<FFFD>.txt` で `status OK`）。
     *
     * **値を一律に厳密化してはいけない。**実物の macOS `tar` は
     * `LIBARCHIVE.xattr.*` / `SCHILY.xattr.*` に**生バイナリ**を書く（実測で弾いた）。
     * これらは見え方を変えないので、読めなくても構わない。
     * 鍵は仕様上 ASCII で、置換しても `path` には化けない（U+FFFD は英字にならない）が、
     * 鍵が読めない時点で分類できないので止める。
     */
    const key = decodePaxText(rec.subarray(0, eq), `PAX (${kind}) の鍵`)
    /**
     * **同じヘッダ内で同じ鍵が 2 回出たら、後の値が勝つ（v0.6.9・外部監査 P1-A）。**
     *
     * v0.6.8 はここで拒んでいたが、**POSIX は同一ヘッダ内の後勝ちを定めている。**
     * 実測（2026-08-11・鍵を変えて 6 通り）: `path` / `linkpath` / `mtime` /
     * `uid` / `size` / `comment` の**どれも bsdtar と python が同じ木を作り、後の値を採る。**
     * つまりこの拒否は**正当な archive を落としていた**（5 版目の過剰拒否）。
     *
     * **別のヘッダをまたいだ上書きの競合は、これとは別**である（そちらは実装が割れる）。
     * `x` を 2 つ続ける形と、PAX と GNU `L`/`K` の混在は、下の状態機械で今までどおり止める。
     */
    const raw = rec.subarray(eq + 1, rec.length - 1)
    /**
     * **長さ 0 の値は、解釈する鍵では受けない（v0.6.9・外部監査 P0-C）。**
     *
     * POSIX は「長さ 0 の値はその上書きを消す」と定めているが、**実装が従っていない。**
     * CI（ubuntu・2026-08-11）で、こちらの材料を測った結果:
     *
     * ```
     * x: mtime=（長さ 0）／ uid=（長さ 0）
     *   GNU tar 1.35  Malformed extended header: invalid mtime= — **archive ごと拒む**
     *   bsdtar        exit 0 — 削除として無視して展開する
     *   python        同じ
     * ```
     *
     * **GNU tar の受け手は、何も手に入らない。**受理すると
     * 「検算器だけがそのファイルはあると言う」状態になる。
     *
     * > **こちらは一度これを「監査が挙げていない過剰拒否」と書いて、間違えた。**
     * > 開発機に GNU tar が無く、手元の 2 実装がそろって通したのを
     * > 「割れていない」と読んだためである。**割れていたのは 3 つ目の実装だった。**
     * > **2 実装で足りるかどうかは、2 実装では決められない。**
     *
     * 解釈しない鍵（xattr・comment 等）は長さ 0 でも見え方を変えないので、何もしない。
     * **`path` と `linkpath` は下の呼び出し側**で止める（名前が消えるとさらに広く割れる）。
     */
    /**
     * **解釈する値だけ読む（v0.6.5）。**`path` は名前になるので NUL も不正 UTF-8 も止める。
     * xattr の値は実物が**生バイナリ**を入れるので読まない——中身のバイト列の外側であり、
     * 読めなくても view は変わらない（v8 と v9 で 2 回、ここで塞ぎすぎた）。
     */
    if (raw.length === 0) {
      /**
       * **鍵は、値が空でも必ず `out` へ入れる（v0.6.10・外部監査 P0-A）。**
       *
       * v0.6.9 はここで `path`/`linkpath` と数値鍵しか `out.set` しなかった。
       * ところが**下の allowlist と known-dangerous 検査は `out.keys()` しか見ない**ので、
       * **値を空にするだけで、その 2 つを丸ごと迂回できた。**実測（2026-08-11）:
       *
       * ```
       * 同じ鍵で、値の長さだけを変える
       *   size=12           ARCHIVE_INVALID（見え方を変える鍵）
       *   size=（長さ 0）     READ               ← 素通り
       *   SUN.holesdata=X   ARCHIVE_INVALID     ／ bsdtar も exit 1 で拒む
       *   SUN.holesdata=    READ               ← 素通り（bsdtar は拒むのに）
       *   ACME.weird=X      ARCHIVE_UNSUPPORTED（未知の鍵）
       *   ACME.weird=       READ               ← 素通り
       * ```
       *
       * **v0.6.9 で「長さ 0 を早く返す」ようにしたときに、こちらが開けた穴。**
       * 分類は値の長さで変わらない——**先に鍵で分類し、そのあとで値の長さを見る。**
       */
      // ここで `continue` すると末尾の `i += len` を飛ばして**無限に回る**（分岐で書く）
      out.set(key, ZERO_LENGTH_PAX_VALUE)
    } else if (key === 'path' || key === 'linkpath') {
      out.set(key, decodePaxText(raw, `PAX (${kind}) の ${key}`))
    } else if (PAX_VALUE_GRAMMAR[key]) {
      const v = decodePaxText(raw, `PAX (${kind}) の ${key}`)
      if (!PAX_VALUE_GRAMMAR[key].test(v)) {
        throw new ArchiveInvalid(
          `PAX (${kind}) の ${key} が数値として読めない: ${JSON.stringify(v.slice(0, 32))}`,
          { kind, key , stableReasonCode: 'PAX_VALUE_SYNTAX' },
        )
      }
      /**
       * **整数部を BigInt で読んで範囲を見る（v0.6.7）。**
       * `Number` で読むと 2^53 を超えたところで丸まり、
       * **範囲の外にある値が範囲の内側の値に化ける。**
       */
      const [lo, hi] = PAX_VALUE_RANGE[key]
      const intPart = BigInt(v.split('.')[0])
      if (intPart < lo || intPart > hi) {
        throw new ArchiveInvalid(
          `PAX (${kind}) の ${key} が扱える範囲の外にある: ${v.slice(0, 32)}（${lo}..${hi}）`,
          { kind, key , stableReasonCode: 'PAX_VALUE_RANGE' },
        )
      }
      out.set(key, v)
    } else if (PAX_KEYS_STRICT_TEXT.has(key)) {
      out.set(key, utf8OrStop(raw, `PAX (${kind}) の ${key}`, null))
    } else {
      out.set(key, raw)
    }
    i += len
  }
  const bad = [...out.keys()].filter(
    (k) => !PAX_KEYS_ALLOWED.has(k) && !PAX_PREFIXES_ALLOWED.some((p) => k.startsWith(p)),
  )
  if (bad.length) {
    const known = bad.filter((k) => PAX_KEYS_KNOWN_DANGEROUS.includes(k))
    /**
     * **見え方を変えると分かっている鍵と、知らない鍵を分ける（v0.6.7・外部監査 P1-C）。**
     *
     * 実測（2026-08-10）:
     * ```
     * SUN.holesdata   bsdtar exit 1（Parse error）／ python exit 0   ← 割れる = 壊れている扱い
     * ACME.weird      bsdtar exit 0 ／ python exit 0                 ← 展開できる = 対応していない
     * ```
     * どちらも受理しないが、**受け手に言うべきことが違う。**
     */
    if (known.length) {
      throw new ArchiveInvalid(
        `PAX (${kind}) に受け入れていない鍵がある: ${bad.join(', ')}`
        + `（${known.join(', ')} は entry の見え方を変える）`,
        { kind, keys: bad , stableReasonCode: 'PAX_KEY_DANGEROUS' },
      )
    }
    throw new ArchiveUnsupported(
      `PAX (${kind}) に、この道具が意味を決めていない鍵がある: ${bad.join(', ')}`
      + '（未知の鍵は既定で受け取らない）',
      { kind, keys: bad , stableReasonCode: 'PAX_KEY_UNSUPPORTED' },
    )
  }
  /**
   * **global（`g`）の `path` / `linkpath` は止める。**後続すべての名前・指す先を
   * 差し替えることになり、「どの entry の話か」が消える。
   * 実物の GitHub tarball の `g` は `comment` だけ（実測）。
   *
   * **`linkpath` は v0.6.7 で足した（外部監査 P0-B）。**v0.6.6 は `g` の `linkpath` を
   * 受け取って**黙って無視**していたが、実装は無視しない。実測（2026-08-10）:
   *
   * ```
   * g linkpath=root/t2 ／ ヘッダの linkname=root/t1 ／ symlink root/ln
   *   検算 v11  READ（無視して header の値を inventory へ）
   *   bsdtar    root/ln -> root/t1     ← header を採る
   *   python    root/ln -> root/t2     ← global を採る
   * ```
   *
   * **同じ archive から別の木ができる。**どちらが正しいかを決める立場にない。
   */
  for (const k of ['path', 'linkpath']) {
    if (kind === 'g' && out.has(k)) {
      throw new ArchiveInvalid(`PAX (g) が全 entry の ${k} を差し替えようとしている`, { kind, key: k, stableReasonCode: 'PAX_GLOBAL_NAME_OVERRIDE' })
    }
  }
  /**
   * **鍵ごとの「長さ 0」方針は、allowlist を通ったあとで当てる（v0.6.10・外部監査 P0-A）。**
   *
   * ここへ来る鍵は `PAX_KEYS_ALLOWED` か xattr の接頭辞だけ。分け方は 3 つ:
   *
   * ```
   * path / linkpath              名前が消える。読み手ごとに結末が割れる（呼び出し側で止める）
   * mtime / atime / ctime        GNU tar が `Malformed extended header` で archive ごと拒む
   * uid / gid
   * uname / gname / comment      見え方を変えない。長さ 0 でも通す
   * LIBARCHIVE./SCHILY.xattr.*   同上（実物が生バイナリを入れる領域）
   * ```
   *
   * 数値鍵の根拠は 2026-08-11 の CI（ubuntu / GNU tar 1.35）で取った実測である。
   * **こちらは一度これを「過剰拒否」と読んで通してしまい、その CI に落とされた。**
   */
  for (const [k, v] of out) {
    if (v !== ZERO_LENGTH_PAX_VALUE) continue
    if (k === 'path' || k === 'linkpath') continue    // 呼び出し側（assertPaxNameValue）で止める
    if (PAX_VALUE_GRAMMAR[k]) {
      throw new ArchiveInvalid(
        `PAX (${kind}) の ${k} が長さ 0 である。GNU tar はこの archive を展開しない`,
        { kind, key: k, stableReasonCode: 'PAX_ZERO_LENGTH_VALUE_INVALID' },
      )
    }
    /**
     * 残るのは `uname` / `gname` / `comment` / xattr。
     * **見え方を変えないので通す**（実測: 2 実装とも同じ木）。
     * 値としては空文字と同じに畳んでおく——sentinel が下流へ漏れないようにする。
     */
    out.set(k, k === 'uname' || k === 'gname' || k === 'comment' ? '' : Buffer.alloc(0))
  }
  return out
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
/**
 * **パスのバイト列を厳密に UTF-8 として読む（v0.6.4・外部監査 P0-C）。**
 *
 * v0.6.3 は `Buffer#toString('utf8')` を使っていた。これは**不正なバイトを U+FFFD へ黙って置換する**ので、
 * `root/file<FF>.txt` が `root/file<FFFD>.txt` になり、manifest 側も同じ置換を受けて一致してしまう。
 * 実測: 検算は `status OK`、bsdtar と python はどちらも生バイトのまま扱う（別のファイル名）。
 *
 * **置換して続けると、検算が見た名前と展開してできる名前が別物になる。**止めるほうを選ぶ。
 * NUL 終端より後ろは tar の詰め物なので、判定の前に落とす。
 */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true })

function utf8OrStop(bytes, where, entryIndex) {
  try {
    return STRICT_UTF8.decode(bytes)
  } catch {
    throw new ArchiveInvalid(`${where}が UTF-8 として読めないバイトを含む`, {
      entryIndex,
      bytes: Buffer.from(bytes).toString('hex').slice(0, 64),
      stableReasonCode: 'TEXT_NOT_UTF8',
    })
  }
}

/**
 * **固定長ヘッダ欄を読む。**USTAR の `name` / `prefix`、GNU long name の本体。
 * これらは**欄を NUL で埋める**仕様なので、最初の NUL より後ろは詰め物として落とす。
 */
function decodeStrict(bytes, where, entryIndex) {
  const nul = bytes.indexOf(0)
  return utf8OrStop(nul === -1 ? bytes : bytes.subarray(0, nul), where, entryIndex)
}

/**
 * **PAX の可変長テキストを読む（v0.6.5・外部監査 P0-3）。**
 *
 * PAX のレコードは**長さで区切る**ので、NUL は詰め物ではなく値の一部である。
 * v0.6.4 は固定長欄と同じ関数で読んでいたため、**NUL 以降を黙って捨てていた。**
 *
 * ```
 * PAX path = root/src/model/a.ts\0evil
 *   検算 v9  root/src/model/a.ts として status OK
 *   bsdtar   NUL 以降を切り捨てる（同じ名前になる）
 *   python   embedded null で展開に失敗する
 * ```
 *
 * **実装ごとに結末が割れる。**切り捨てて続けず、NUL があれば止める。
 */
function decodePaxText(bytes, where) {
  if (bytes.indexOf(0) !== -1) {
    throw new ArchiveInvalid(`${where}に NUL が入っている（実装ごとに結末が割れる）`, {
      bytes: Buffer.from(bytes).toString('hex').slice(0, 64),
      stableReasonCode: 'TEXT_CONTAINS_NUL',
    })
  }
  return utf8OrStop(bytes, where, null)
}

/**
 * **中身を持ちうる entry 型（v0.6.4・外部監査 P0-B）。**
 *
 * `0` / `\0` は通常ファイル。`7`（contiguous）は、対応しない OS では**通常ファイルとして展開される**
 * （実測: bsdtar・python とも通常ファイルを作る）。`S` は GNU sparse で、実サイズも名前も別に持つ。
 * v0.6.3 はこれらを「通常ファイルではない」として素通りさせ、**完全性の検査から消していた。**
 */
const CONTENT_BEARING_NOT_HANDLED = new Set(['7', 'S', 'D', 'M', 'N'])

/**
 * **扱いを決めてある entry 型（v0.6.9・外部監査 P0-B）。**
 *
 * v0.6.8 までは `CONTENT_BEARING_NOT_HANDLED` という**除外表**しか無かった。
 * 表に無い型は素通りするので、**`Z` や空白のような未知の型が
 * inventory にだけ入って `files` に入らない。**実測（2026-08-11）:
 *
 * ```
 * typeflag Z / 空白（本体 5 バイト）
 *   検算 v13  status OK ／ 32 of 32 ／ files 85・inventory 86（中身を数えない）
 *   bsdtar    exit 0 — 通常ファイルとして 5 バイトのファイルを作る
 *   python    同じ
 * ```
 *
 * **除外表は、知らない物を通す側へ倒れる。**許可表にして、載っていない型は止める
 * （[[feedback_exclusion_rules_never_allowlist]] と同じ形の誤り）。
 *
 * 過剰拒否になっていないことは実物で確かめた（2026-08-11 実測）:
 * npm の実 tarball 600 本 51,802 entry は `0` と `5` だけ、
 * `git archive` は `0`/`5`/`g`、macOS の `tar` は `0`/`x`。
 * `3`/`4`/`6`（device・FIFO）はどれにも出ず、手元の 2 実装とも
 * device は作れず FIFO は作る——**どちらも「中身を持つファイル」ではない。**
 */
const SUPPORTED_TYPEFLAGS = new Set(['0', '1', '2', '5', 'x', 'g', 'L', 'K'])

/**
 * **ヘッダ形式を magic + version で決める（v0.6.9・外部監査 P0-A）。**
 *
 * v0.6.8 までは 345..499 を**形式を確かめずに prefix として読んでいた。**
 * だが 345..499 が prefix なのは POSIX ustar のときだけで、
 * old GNU ではそこは atime/ctime/offset/sparse の領域である。実測（2026-08-11）:
 *
 * ```
 * magic が old GNU / V7 / 未知 で、345..499 が非空
 *   検算 v13  src/model/types.ts が「ある」と言う（status OK / 32 of 32）
 *   bsdtar    types.ts を root に作る      ← prefix を使わない
 *   python    src/model/types.ts を作る    ← prefix を使う
 * ```
 *
 * **同じ archive から別の木ができる。**受け手が macOS の tar で展開すると、
 * 検算器が「あった」と言ったファイルが手元に無い。
 *
 * **形式そのものは拒まない。**指示書は「V7・old GNU を実装しないなら
 * `ArchiveUnsupported`」と書いているが、**それは採らなかった。**実測で、
 * 345..499 が空なら old GNU も V7 も未知 magic も **2 実装が同じ木を作る。**
 * しかも **old GNU は GNU tar 自身の既定の出力形式**なので、
 * 形式で拒むと**ふつうに GNU tar で作った tar.gz が読めなくなる。**
 * v9〜v12 で 4 版続けて過剰拒否を出しているので、**止めるのは実装が割れる形だけ**にする。
 *
 * version 欄は判別に使わない。実測で `ustar\0` なら version が
 * `00` / NUL NUL / 空白 2 個のどれでも **2 実装とも prefix を使う。**
 * 指示書の「`ustar\0` + `00` でのみ prefix」は、この 2 つを落とす。
 */
function classifyHeaderFormat(header) {
  const magic8 = header.subarray(257, 265)
  if (magic8.subarray(0, 6).equals(Buffer.from('ustar\0', 'latin1'))) return 'posix-ustar'
  if (magic8.equals(Buffer.from('ustar  \0', 'latin1'))) return 'old-gnu'
  if (magic8.every((b) => b === 0)) return 'v7'
  return 'unknown'
}

function readTar(buf) {
  const files = new Map()
  /** **読み飛ばした entry の名前も覚える。**衝突の判定にはファイル以外も要る（v0.6.2） */
  /** 名前 -> entry 型。hardlink の指す先が**通常ファイルか**まで見るため（v0.6.6） */
  const seenPaths = new Map()
  /**
   * **全 entry を型つきで数え上げる（v0.6.4・外部監査 P0-B）。**
   *
   * v0.6.3 は通常ファイルだけを `files` に入れ、未記録入力の探索もその key しか見なかった。
   * そのため **scope の下に置いた symlink / hardlink / typeflag 7 が探索から消えた**
   * （実測: 検算は `status OK` / 未記録候補 0 件、bsdtar と python はどちらも展開する）。
   * 完全性の検査は「ファイルとして読めたもの」ではなく **archive に在るもの全部**を見る必要がある。
   */
  const inventory = []
  /**
   * **祖先として使われた名前（v0.6.7・外部監査 P0-A）。**
   *
   * `root/src/model/a.ts` を入れたら `root`・`root/src`・`root/src/model` が入る。
   * あとから `root/src` が通常ファイルや symlink として出てきたら、その木は作れない。
   */
  const usedAsDirectory = new Set()
  /** hardlink の名前 -> 最終的に指している通常ファイルの名前（連鎖を辿るため・v0.6.7） */
  const hardlinkResolved = new Map()
  let off = 0
  let longName = null
  /** `longName` を**どの機構が**置いたか。二重に置かれたら止めるため（v0.6.4・P0-A） */
  let longNameFrom = null
  /** GNU `K` / PAX `linkpath` で上書きされた linkname（v0.6.6） */
  let longLink = null
  /**
   * `longLink` を**どの機構が**置いたか（v0.6.7・外部監査 P0-B）。
   * v0.6.6 は linkname の上書きだけ状態を持っていなかったので、
   * 二重の上書きも、宙に浮いた上書きも素通りしていた。**名前と同じ規則にする。**
   */
  let longLinkFrom = null
  /**
   * **local PAX（`x`）は、鍵に関係なく「次の member を待っている」状態を作る（v0.6.8・外部監査 P0-B）。**
   *
   * v0.6.7 は `path` と `linkpath` にしか状態が無かったので、
   * **`mtime` だけを持つ `x` を末尾に置いた archive を受理していた。**実測（2026-08-11）:
   * 検算 v12 は READ ／ bsdtar は exit 1（Damaged tar archive）／ python は exit 2（ReadError）。
   */
  let pendingPax = null
  let entries = 0
  let total = 0
  /** この archive に出たヘッダ形式（受け手が「何を読んだか」を後から見るため・v0.6.9） */
  const headerFormats = new Set()
  /** 終端の zero block を見たか。**見ずに尽きたら切れている**（v0.6.11） */
  let sawTerminator = false

  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    /**
     * **終端のあとに中身が続いていないか見る（v0.6.10・外部監査 P0-B）。**
     *
     * v0.6.9 は最初の zero block で `break` して、**そのあとを一度も見なかった。**
     * だから zero block を 1 個置いて、その後ろに member を隠せた。実測（2026-08-11）:
     *
     * ```
     * 32 入力の source + zero block 1 個 + root/src/model/sneaky.ts
     *   検算 v14  status OK ／ 32 of 32 ／ 未記録候補 0 件（sneaky.ts は一覧に出ない）
     *   実ファイル 中に sneaky.ts は入っている（offset を数えて確認）
     * ```
     *
     * **手元の 2 実装（bsdtar / python）も sneaky.ts を作らない**ので、
     * 「割れる」ことはこちらでは再現できていない（監査は BusyBox が読むと報告）。
     * それでも塞ぐのは、**この道具の約束が「ここに挙げた物が中身の全部」だから**で、
     * 「読み手の一つが読めるものが一覧に無い」時点でその約束は果たせない。
     *
     * 終端の印は zero block **2 個**である。1 個で切って中身が続く形は archive の側の欠陥。
     * 過剰拒否になっていないことは実物で確かめた（2026-08-11 実測）:
     * **npm の実 tarball 600 本すべてが「終端 zero 2 個・その後ろの非 zero 0 件」**、
     * `git archive` と macOS の `tar` も同じ。
     */
    if (header.every((b) => b === 0)) {
      for (let p = off; p + 512 <= buf.length; p += 512) {
        if (!buf.subarray(p, p + 512).every((b) => b === 0)) {
          throw new ArchiveInvalid(
            '終端の zero block のあとに、まだ中身が続いている（この道具も多くの読み手もそこで読むのをやめる）',
            { offset: p, terminatorAt: off, stableReasonCode: 'END_OF_ARCHIVE_LONE_ZERO_BLOCK' },
          )
        }
      }
      sawTerminator = true
      break
    }

    if (++entries > TAR_LIMITS.maxEntries) {
      throw new ArchiveUnsupported(`entry が多すぎる (> ${TAR_LIMITS.maxEntries})`, { entries, stableReasonCode: 'LIMIT_ENTRY_COUNT_UNSUPPORTED' })
    }
    if (!headerChecksumOk(header, entries)) {
      throw new ArchiveInvalid('ヘッダの checksum が合わない', { entryIndex: entries, offset: off, stableReasonCode: 'HEADER_CHECKSUM_MISMATCH' })
    }

    /**
     * **数値欄とパス欄で読み方を分ける（v0.6.3・外部監査 P0-3）。**
     *
     * v0.6.2 は両方に `.trim()` をかけていた。数値欄は実装によって空白で詰められるので
     * trim が要るが、**パス欄で trim すると `root/file.txt␠` が `root/file.txt` に化ける。**
     * 展開すると空白つきの別ファイルができるので、検算の結果と食い違う。
     */
    const pathField = (a, l) => decodeStrict(header.subarray(a, a + l), 'パス欄', entries).replace(/\0.*$/, '')
    const str = (a, l) => header.subarray(a, a + l).toString('utf8').replace(/\0.*$/, '').trim()
    /**
     * **形式を決めてから 345..499 を読む（v0.6.9・外部監査 P0-A）。**
     * POSIX ustar 以外でここが非空なら、**実装ごとに別の名前になる**ので止める。
     */
    const headerFormat = classifyHeaderFormat(header)
    headerFormats.add(headerFormat)
    const prefixRegionEmpty = header.subarray(345, 500).every((b) => b === 0)
    /**
     * **型を先に分類する（v0.6.10・外部監査 P1）。**
     *
     * v0.6.9 は形式と 345..499 の食い違いを、**型を見る前に**落としていた。
     * そのため**正当な old GNU sparse**（typeflag `S`・345..499 は sparse map）が
     * `ARCHIVE_INVALID`（＝壊れている）になっていた。実測（2026-08-11）:
     * bsdtar も python も exit 0 で読む——**壊れてはいない。**
     * こちらが sparse を扱わないだけなので、下の許可表が
     * `ARCHIVE_UNSUPPORTED` と言うべきである。
     *
     * **許可表を 2 つ持たない**ために、ここでは型の判定をせず
     * 「支援する型のときだけ形式の食い違いを見る」形にして、型の話は下の 1 か所へ任せる。
     */
    const typeflagHere = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    if (headerFormat !== 'posix-ustar' && !prefixRegionEmpty && SUPPORTED_TYPEFLAGS.has(typeflagHere)) {
      throw new ArchiveInvalid(
        `ヘッダ形式が ${headerFormat} なのに 345..499 が空でない。`
        + 'この領域を prefix として読むかどうかで読み手ごとに名前が変わる',
        { entryIndex: entries, headerFormat, name: str(0, 100), stableReasonCode: 'HEADER_FORMAT_PREFIX_CONFLICT' },
      )
    }
    /**
     * **数値欄は全部、欄まるごと読む（v0.6.8・外部監査 P0-A）。**
     *
     * v0.6.7 は `size` しか見ておらず、他の欄は**読んでもいなかった。**
     * base-256 の判定も `size` にしか掛かっていなかった。
     * どの欄が壊れていても実装ごとに結末が割れるので、同じ関数で同じように見る。
     */
    for (const [name, at, len] of [['mode', 100, 8], ['uid', 108, 8], ['gid', 116, 8],
      ['mtime', 136, 12], ['devmajor', 329, 8], ['devminor', 337, 8]]) {
      parseTarNumericField(header.subarray(at, at + len), name, entries)
    }
    const size = parseTarNumericField(header.subarray(124, 12 + 124), 'size', entries)
    /**
     * **切れている archive は、上限より先に見る（v0.6.7）。**
     *
     * 宣言した size のぶんの本体が入っていない archive は**壊れている。**
     * 上限の判定を先に置くと、壊れた archive まで「対応範囲の外」と言ってしまう
     * （`declaredSize` を巨大にした材料が実際にそうなった）。
     * **壊れているかどうかは、上限の話より前に決まる。**
     */
    if (off + 512 + size > buf.length) {
      throw new ArchiveInvalid('entry のデータが archive の末尾を超えている', { entryIndex: entries, size, stableReasonCode: 'ENTRY_BODY_TRUNCATED' })
    }
    /**
     * **資源上限は「対応範囲の外」であって、archive の欠陥ではない（v0.6.7）。**
     * 上限そのものは変えていない（監査も「上限維持でよい」と書いている）。
     * 変えたのは言い方だけで、exit code は 2 のまま。
     */
    if (size > TAR_LIMITS.maxEntryBytes) {
      throw new ArchiveUnsupported(`entry が大きすぎる (${size} > ${TAR_LIMITS.maxEntryBytes})`, { entryIndex: entries, name: str(0, 100), stableReasonCode: 'LIMIT_ENTRY_BYTES_UNSUPPORTED' })
    }
    total += size
    if (total > TAR_LIMITS.maxTotalBytes) {
      throw new ArchiveUnsupported(`展開後の総量が大きすぎる (> ${TAR_LIMITS.maxTotalBytes})`, { total, stableReasonCode: 'LIMIT_TOTAL_BYTES_UNSUPPORTED' })
    }

    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    const dataStart = off + 512
    if (dataStart + size > buf.length) {
      throw new ArchiveInvalid('entry のデータが archive の末尾を超えている', { entryIndex: entries, size, stableReasonCode: 'ENTRY_BODY_TRUNCATED' })
    }
    /**
     * **本体は詰め物まで揃っていること（v0.6.11・こちらで見つけた）。**
     *
     * v0.6.10 は生のサイズ分だけを見ていたので、**最後の block が途中で切れている
     * archive を受理**していた。実測（2026-08-11）: 32 入力の source の末尾を 511 バイト
     * 削ると、検算 v15 は `status OK / 32 of 32`（files 86）と言うのに、
     * **bsdtar は `Truncated input file`・python は `ReadError` で 2 実装とも拒む。**
     */
    const padded = dataStart + Math.ceil(size / 512) * 512
    if (padded > buf.length) {
      throw new ArchiveInvalid(
        'entry の本体が詰め物まで揃っていない（archive が途中で切れている）',
        { entryIndex: entries, size, need: padded - buf.length, stableReasonCode: 'ENTRY_BODY_TRUNCATED' },
      )
    }
    const data = buf.subarray(dataStart, dataStart + size)
    off = padded

    /**
     * **PAX は中身を拾わないうえに、意味を変える鍵があれば止める（v0.6.3・外部監査 P0-1）。**
     * v0.6.2 は黙って読み飛ばしていたので、`path=` / `size=` の上書きで
     * 検算の view と展開の view を食い違わせられた（実測）。
     */
    if (type === 'x' || type === 'g') {
      const recs = readPaxRecords(data, type)
      if (type === 'x') {
        /**
         * **`x` が 2 つ続く形は止める（v0.6.8）。**実測（2026-08-11）:
         * metadata だけの `x` を 2 回置くと **bsdtar は exit 1**
         * （`Ignoring malformed pax extended attribute`）、python は通す——割れる。
         */
        if (pendingPax) {
          throw new ArchiveInvalid(
            'local PAX ヘッダが 2 つ続いている（どちらが効くか実装ごとに割れる）',
            { entryIndex: entries , stableReasonCode: 'EXTENSION_HEADER_SEQUENCE_UNSUPPORTED' },
          )
        }
        pendingPax = { entryIndex: entries, keys: [...recs.keys()].slice(0, 8) }
      }
      /**
       * **global header が名前を上書きするのは受けない（v0.6.4）。**
       * `x` の `path` しか解釈しないので、`g` の `path` を黙って捨てると
       * 解釈する実装と view が食い違う。実物の `pax_global_header` は `comment` だけ。
       */
      if (type === 'g' && recs.has('path')) {
        throw new ArchiveInvalid('global PAX header が path を上書きしている', { entryIndex: entries, stableReasonCode: 'PAX_GLOBAL_NAME_OVERRIDE' })
      }
      /**
       * **同じ member に上書き機構が 2 つ効いたら止める（v0.6.4・外部監査 P0-A）。**
       *
       * v0.6.3 は `longName` を後勝ちで置いていたので、実装ごとに結末が割れる archive を
       * 「読めた」と言っていた。実測（同じ archive を 3 者で読む）:
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
      /**
       * **競合と言えるのは、その PAX が実際に名前を上書きするときだけ（v0.6.11・外部監査 P1-A）。**
       *
       * v0.6.10 は `x` が来ただけで落としていたので、
       * **`mtime` しか持たない PAX が GNU `L` のあとに来る正当な形**まで拒んでいた。
       * 実測（2026-08-11）: GNU L の長い名前 → `x: mtime=1`（path なし）→ 実体 で、
       * **bsdtar も python も同じ長い名前を作る。**
       * **`path` を持たない PAX は名前に触らない**ので、待っている `L` と共存できる。
       */
      if (type === 'x' && longNameFrom && recs.has('path')) {
        throw new ArchiveInvalid(
          `同じ entry に名前の上書きが 2 つ効いている（${longNameFrom} のあとに PAX path）`,
          { entryIndex: entries, stableReasonCode: 'EXTENSION_OVERRIDE_CONFLICT' },
        )
      }
      /**
       * **`path` は解釈する（v0.6.3）。**GNU tar は長いパスをこれで書く。
       * 拒むとふつうに作った tar.gz が読めなくなり、解釈すれば展開と同じものが見える。
       * `L`（GNU long name）と同じ扱いで、次の entry の名前になる。
       */
      if (type === 'x' && recs.has('path')) {
        /**
         * **綴りの検査は、member の型が分かってからにする（v0.6.8・外部監査 P1-A）。**
         *
         * v0.6.7 はここで `assertSafePath` を掛けていたので、
         * **directory を指す `path=root/dir/` が「空のパス要素がある」で落ちていた。**
         * 実測（2026-08-11）: bsdtar も python も同じ木を作る＝こちらの過剰拒否。
         * 末尾スラッシュを許してよいかは **typeflag を見ないと決まらない。**
         */
        longName = assertPaxNameValue(recs.get('path'), 'path', entries)
        longNameFrom = 'PAX'
      }
      /**
       * **`linkpath` も解釈する（v0.6.6・外部監査 P1）。**
       *
       * v0.6.5 は allowlist に無い鍵として**拒んでいた**。しかし
       * 長い linkname を持つ archive は GNU tar・bsdtar・BusyBox・python の
       * **4 実装すべてが展開できる**（監査の実測）——正当な形を拒んでいた。
       *
       * リンクの指す先は `files` に入らないので view は変わらないが、
       * **hardlink の指す先の検査には使う**ので、解釈して覚える。
       */
      if (type === 'x' && recs.has('linkpath')) {
        /**
         * **linkname の上書きも、名前と同じ状態機械にする（v0.6.7・外部監査 P0-B）。**
         *
         * v0.6.6 は `longLink` を後勝ちで置くだけだった。実測（2026-08-10）:
         *
         * ```
         * PAX linkpath を 2 回   検算 v11 READ ／ bsdtar exit 1（malformed pax）
         *                                    ／ python は 1 つ目を採る
         * ```
         *
         * **同じ archive で片方が拒み、片方は通す。**どちらが正しいかを決める立場にない。
         */
        if (longLinkFrom) {
          throw new ArchiveInvalid(
            `同じ entry に linkname の上書きが 2 つ効いている（${longLinkFrom} のあとに PAX）`,
            { entryIndex: entries , stableReasonCode: 'EXTENSION_OVERRIDE_CONFLICT' },
          )
        }
        // readPaxRecords が既に文字列へ decode 済み（NUL と不正 UTF-8 はそこで止まる）
        longLink = assertPaxNameValue(recs.get('linkpath'), 'linkpath', entries)
        longLinkFrom = 'PAX'
      }
      continue
    }

    if (type === 'L' || type === 'K') {
      const what = type === 'L' ? 'GNU long name' : 'GNU long linkname'
      const decoded = decodeStrict(data, what, entries).replace(/\0.*$/, '')
      if (type === 'K') {
        /**
         * **GNU の長い linkname（`K`）を受ける（v0.6.6・外部監査 P1）。**
         *
         * v0.6.5 は `K` の分岐が無く、**`K` ヘッダ自身の名前 `././@LongLink` が
         * 正規化検査に当たって `ARCHIVE_INVALID` になっていた**（実測）。
         * 4 実装すべてが展開できる archive を拒んでいたので、こちらの過剰拒否である。
         *
         * **二重の上書きは止める（v0.6.7・外部監査 P0-B）。**
         * PAX `linkpath` と `K` が同じ member に効く形は、
         * **順序によって実装ごとに指す先が分かれる**（監査の 4 実装測定）。
         * 手元の bsdtar と python は 2 つとも「先に来たほうが勝つ」で一致したので、
         * **この割れ方そのものは手元では再現できていない。**
         * ただし `linkpath` を 2 回置く形は手元でも割れており（上）、
         * 名前の上書きでは同じ形を v0.6.4 から止めている。**同じ規則を当てる。**
         */
        if (longLinkFrom) {
          throw new ArchiveInvalid(
            `同じ entry に linkname の上書きが 2 つ効いている（${longLinkFrom} のあとに GNU long linkname）`,
            { entryIndex: entries , stableReasonCode: 'EXTENSION_OVERRIDE_CONFLICT' },
          )
        }
        longLink = decoded
        longLinkFrom = 'GNU long linkname'
        continue
      }
      if (longNameFrom) {
        throw new ArchiveInvalid(
          `同じ entry に名前の上書きが 2 つ効いている（${longNameFrom} のあとに GNU long name）`,
          { entryIndex: entries , stableReasonCode: 'EXTENSION_OVERRIDE_CONFLICT' },
        )
      }
      // 綴りの検査は member の型が分かってから（v0.6.8・上の PAX path と同じ理由）
      longName = decoded
      longNameFrom = 'GNU long name'
      continue
    }

    /**
     * prefix を使ってよいのは POSIX ustar のときだけ（v0.6.9）。
     *
     * **この三項演算子は、単体では落とせない。**上の判別が
     * 「POSIX ustar 以外で 345..499 が非空」を既に止めているので、
     * ここへ来る時点で非 ustar の 345..499 は必ず空である
     * （変異試験で確認: この行を `pathField(345, 155)` に変えても試験は全部通る）。
     * **効いている検査は上の `throw` のほう。**ここは、上の検査を後から弱めたときに
     * 黙って prefix を使い始めないための控えとして残してある。
     */
    const prefixField = headerFormat === 'posix-ustar' ? pathField(345, 155) : ''
    const rawName = longName ?? (prefixField ? `${prefixField}/${pathField(0, 100)}` : pathField(0, 100))
    /**
     * **上書きは、この member で消費し終わる（v0.6.5・外部監査 P1）。**
     *
     * v0.6.4 は `longName` だけを戻し、**`longNameFrom` を戻し忘れていた。**
     * そのため、独立した 2 つの member がそれぞれ長い名前を 1 回ずつ使うだけの
     * **正当な archive を「二重の上書き」として拒んでいた**（実測: bsdtar・python は
     * どちらも 2 件とも展開する）。
     *
     * **この repo の実物では踏まなかった**（最長パス 95 文字で long name 機構を使わない）。
     * 「実物が通る」だけでは、過剰拒否は見つけられない。
     */
    /** 空になった原因を言えるように、**戻す前に**控える（v0.6.11） */
    const nameCameFrom = longNameFrom
    longName = null
    longNameFrom = null
    /** この member 用に控えてから戻す（下の hardlink 検査で使う） */
    const memberLink = longLink
    longLink = null
    longLinkFrom = null
    /** **`x` が待っていた member はこれ。**`L` / `K` は member ではないのでここへ来ない */
    pendingPax = null

    /**
     * **名前が空の member は捨てずに止める（v0.6.11・外部監査 P0-B）。**
     *
     * v0.6.10 まで `continue` で**黙って飛ばして**いた。32 入力の source へ混ぜると
     * `status OK / 32 of 32`。実測（2026-08-11）:
     *
     * ```
     * 生ヘッダの名前が空 ／ GNU L の中身が長さ 0
     *   検算 v15  READ — files 85（その member は一覧に出ない）
     *   bsdtar    tar: Archive entry has empty or unreadable filename ... skipping
     *   python    IsADirectoryError（空の名前を展開先そのものとして開く）
     * ```
     *
     * **飛ばした member は「無かったもの」になる。**上書き機構で空にできる以上、
     * これは「一覧に出ないものを混ぜる」経路そのものである。
     * **どこで空になったか**で名前を分ける——受け手が原因を追えるように。
     */
    if (!rawName) {
      throw new ArchiveInvalid(
        nameCameFrom
          ? `名前の上書き（${nameCameFrom}）の結果が空になっている`
          : '名前が空の entry がある',
        {
          entryIndex: entries,
          type,
          from: nameCameFrom ?? 'raw header',
          stableReasonCode: nameCameFrom ? 'EXTENSION_NAME_EMPTY' : 'PATH_EMPTY_NAME',
        },
      )
    }

    /**
     * **すべての entry 型に、同じパス検査を先にかける（v0.6.3・外部監査 P0-2）。**
     *
     * v0.6.2 は衝突の記録だけを全 type で行い、**正規化の検査は通常ファイルにしかかけていなかった。**
     * そのため、リンクの名前を別の綴りにするだけで衝突検査をすり抜けた（実測）。
     *
     * ```
     * regular root/file.txt        = FIRST         ← 検算はこちらを見る
     * symlink root/./file.txt -> target.txt        ← 別の綴りなので衝突しない扱いだった
     * regular root/target.txt      = SECOND
     *   → 展開すると root/file.txt は symlink になり、中身は SECOND
     * ```
     *
     * ディレクトリ entry の末尾スラッシュだけは tar の表記なので剥がしてから見る。
     * 剥がした名前で衝突を見るので、`root/dir/` と `root/dir` も同じものとして扱う。
     */
    const hadTrailingSlash = rawName.endsWith('/')
    /**
     * **「末尾に / がある」と「directory である」を分ける（v0.6.9）。**
     * v0.6.8 までは同じ変数だった。当時は末尾スラッシュが directory にしか許されて
     * いなかったので一致していたが、リンクにも許した今は**別物**である。
     * ここを一緒にしたままだと、`root/` という名前の symlink が
     * `stripTopLevel` の「頭は directory か」の検査を**directory として通ってしまう。**
     *
     * **ただし、この行も単体では落とせない。**変異試験で確認したところ、
     * 子を持つ形は**祖先の型の検査**が先に止め、子を持たない形は
     * `stripTopLevel` の早期 return に入るので、`isDirEntry` の値に関係なく同じ結末になる。
     * **効いている検査は祖先の検査のほう。**ここは意味を取り違えないための控えである。
     */
    const isDirEntry = hadTrailingSlash && type === '5'
    /**
     * **末尾スラッシュは directory のときだけ許す（v0.6.8・外部監査 P1-A）。**
     *
     * tar で名前が `/` で終わるのは「これは directory である」という意味である。
     * typeflag が directory でないのに `/` で終わるのは、entry が自分自身と矛盾している。
     * 実測（2026-08-11）: 通常ファイル（typeflag 0）で `root/x/` を書くと
     * **bsdtar は directory を作り、python は通常ファイルを作る**——割れる。
     *
     * v0.6.7 は typeflag 0 のときだけ落としていたので、リンクは素通りしていた。
     *
     * **v0.6.9 で型ごとに分けた（外部監査 P1-B）。**v0.6.8 は「directory 以外は全部拒む」
     * だったが、**それは実測を追い越していた。**2026-08-11 の実測:
     *
     * ```
     * type 0（通常ファイル）で root/f/   bsdtar は directory を作り Damaged tar archive と警告
     *                                   python は通常ファイルを作る       → 割れる → 止める
     * type 1（hardlink）で root/link/    2 実装とも root/link を作る       → 通す
     * type 2（symlink）で root/link/     2 実装とも同じ symlink を作る     → 通す
     * ```
     *
     * リンクは**末尾スラッシュを 1 回だけ剥がして**、剥がした名前で
     * canonical・衝突・祖先の検査をやり直す（監査の選択肢 A）。
     */
    if (hadTrailingSlash && !['5', '1', '2'].includes(type)) {
      throw new ArchiveInvalid(
        `名前が / で終わっているのに entry 型が directory ではない（typeflag ${type}）`,
        { name: rawName.slice(0, 80), type, entryIndex: entries, stableReasonCode: 'PATH_TRAILING_SLASH_TYPE_CONFLICT' },
      )
    }
    const name = hadTrailingSlash ? rawName.replace(/\/+$/, '') : rawName
    if (!name) throw new ArchiveInvalid('パスがスラッシュだけの entry がある', { entryIndex: entries, stableReasonCode: 'PATH_EMPTY_COMPONENT' })
    assertSafePath(name)

    /**
     * **同じパスが 2 回出てきたら止める（v0.6.1 P1-A / v0.6.2 P0-2）。**
     *
     * v0.6.0 は `Map` へ入れるだけだったので**後の entry が黙って勝った**（実測: `dup.txt` が `SECOND` になる）。
     * 受け手は manifest のパスでこの Map を引くので、
     * **checksum を通った最初の中身とは別の中身を「source にあった」と読むことになる。**
     * 中身が同一でも拒む——同じ内容を 2 回入れる正当な理由が無く、
     * 「同一なら許す」にすると比較のぶんだけ判断が増える。
     */
    if (seenPaths.has(name)) {
      /**
       * **directory どうしの重複だけは通す（v0.6.10・外部監査 P1）。**
       *
       * v0.6.9 は型を問わず落としていた。だが **directory entry は中身を持たないので、
       * 2 回出てきても「どちらが本物か」という問いが立たない。**実測（2026-08-11）:
       * 同じ `root/dir/`（typeflag 5）を 2 回置いた archive を、
       * bsdtar も python も exit 0 で**同じ木**にする。
       *
       * **通常ファイルの重複は今までどおり落とす**——そちらは中身が違いうるので、
       * 「checksum を通った最初の中身」と「展開してできる中身」が食い違う。
       */
      if (!(type === '5' && seenPaths.get(name) === '5')) {
        throw new ArchiveInvalid(
          '同じパスの entry が 2 回ある（どちらが本物か決められない）',
          { name, entryIndex: entries, type, stableReasonCode: 'DUPLICATE_PATH_CONFLICT' },
        )
      }
    }

    /**
     * **祖先はすべてディレクトリでなければならない（v0.6.7・外部監査 P0-A）。**
     *
     * v0.6.6 は 1 つの entry だけを見ていて、**entry どうしの関係**を見ていなかった。
     * そのため「どの展開器でもこの木は作れない」archive を `status OK` と言っていた。
     * 実測（2026-08-10・こちらの 2 実装で再現）:
     *
     * ```
     * regular root/src ／ regular root/src/model/a.ts
     *   検算 v11  READ（files に src と src/model/a.ts の両方）
     *   bsdtar    exit 1 — Could not stat root/src/model/a.ts: Not a directory
     *   python    exit 2 — NotADirectoryError
     *
     * symlink root/src -> elsewhere ／ regular root/src/model/a.ts
     *   検算 v11  READ
     *   bsdtar    exit 1 — Cannot extract through symlink
     *   python    exit 2 — FileNotFoundError
     * ```
     *
     * これは v0.6.5 で塞いだ「先頭 1 階層が directory か」の**一般形**である。
     * 先頭だけ見ていたので、途中の階層で同じことが起きていた。
     *
     * 向きは 2 つある。**両方見ないと片方から入られる。**
     *   ① あとから来た子の祖先が、すでに非ディレクトリとして出ている
     *   ② あとから来た非ディレクトリが、すでに誰かの祖先として使われている
     */
    const parts = name.split('/')
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/')
      const ancestorType = seenPaths.get(ancestor)
      if (ancestorType !== undefined && ancestorType !== '5') {
        throw new ArchiveInvalid(
          `祖先が ${ancestorType === '0' ? '通常ファイル' : `type ${ancestorType}`} なのに、その下に entry がある`
          + `（どの展開器でもこの木は作れない）: ${ancestor} / ${name}`,
          { name, ancestor, ancestorType, entryIndex: entries , stableReasonCode: 'ANCESTOR_TYPE_CONFLICT' },
        )
      }
      usedAsDirectory.add(ancestor)
    }
    if (type !== '5' && usedAsDirectory.has(name)) {
      throw new ArchiveInvalid(
        `すでに他の entry の祖先として使われているパスが、${type === '0' ? '通常ファイル' : `type ${type}`} として出てきた`
        + `（どの展開器でもこの木は作れない）: ${name}`,
        { name, type, entryIndex: entries , stableReasonCode: 'ANCESTOR_TYPE_CONFLICT' },
      )
    }

    seenPaths.set(name, type)

    /**
     * **archive に在るものは、ファイルとして読まないものも全部数える（v0.6.4・P0-B）。**
     * 未記録入力の探索がここを見る。`files` の key だけを見ていたのが穴だった。
     */
    /**
     * **中身を持てない型に中身があったら止める（v0.6.6・外部監査 P0-3）。**
     *
     * ディレクトリ・リンク・デバイスは中身を持たない。size が 0 でないと、
     * **読み手がその本体を読み飛ばすかどうかで、その先の解釈が丸ごとずれる。**
     * 実測（監査）: GNU tar は exit 2、BusyBox は exit 1 で「壊れている」と言う。
     * こちらの手元（bsdtar 3.5.3 / python 3.14）は読み飛ばして通す——
     * **つまり実装間で割れる。**割れるものは受理しない。
     */
    if (['1', '2', '3', '4', '5', '6'].includes(type) && size !== 0) {
      throw new ArchiveInvalid(
        `中身を持てない entry 型に本体がある（typeflag ${type} / size ${size}）。読み手ごとに解釈がずれる`,
        { name, type, size, entryIndex: entries , stableReasonCode: 'ENTRY_BODY_ON_BODYLESS_TYPE' },
      )
    }

    /**
     * **inventory へは「効いたあとの」指す先を入れる（v0.6.7・外部監査 P0-B）。**
     *
     * v0.6.6 はヘッダの 100 byte 欄をそのまま入れていたので、
     * `K` や PAX `linkpath` で上書きされた archive では、
     * **記録に残る指す先が、展開してできるリンクの指す先と別物**になっていた
     * （実測: PAX linkpath=root/A ／ ヘッダ SHORT のとき、記録は `SHORT`）。
     */
    const effectiveLink = type === '1' || type === '2' ? (memberLink ?? pathField(157, 100)) : null
    inventory.push({ name, type, isDirEntry, linkname: effectiveLink })

    /**
     * **扱いを決めていない「中身を持つ型」は止める（v0.6.4・外部監査 P0-B）。**
     * 通常ファイルとして展開されるのに、こちらは中身を見ない——
     * その差がそのまま「検算が見ていないファイルが source に混じる」経路になる。
     */
    /**
     * **「決めていない」は「壊れている」ではない（v0.6.7・外部監査 P1-C）。**
     * 実測（2026-08-10）: typeflag 7 / S / D / M / N のどれも
     * bsdtar・python とも exit 0 で展開する。**展開できる archive である。**
     * こちらが中身の扱いを決めていないだけなので、そう言って止める。
     */
    /**
     * **許可表に載っていない型は、全部ここで止まる（v0.6.9・外部監査 P0-B）。**
     * `CONTENT_BEARING_NOT_HANDLED` は**知っている型を並べた除外表**だったので、
     * `Z` や空白のような**知らない型が素通りしていた**（実測: 2 実装とも中身つきの
     * 通常ファイルを作るのに、検算器は `files` に入れない）。
     */
    if (!SUPPORTED_TYPEFLAGS.has(type)) {
      throw new ArchiveUnsupported(
        CONTENT_BEARING_NOT_HANDLED.has(type)
          ? `扱いを決めていない entry 型がある（typeflag ${JSON.stringify(type)}）。展開すると中身のあるファイルになりうる`
          : `許可していない entry 型がある（typeflag ${JSON.stringify(type)}）。読み手によって中身のあるファイルになりうる`,
        { name, type, entryIndex: entries, stableReasonCode: 'ENTRY_TYPE_UNSUPPORTED' },
      )
    }

    /**
     * **hardlink の指す先は、この時点で既に出ていなければならない（v0.6.5・外部監査 P0-2）。**
     *
     * tar の hardlink は**同じ archive の先行 member**を指す。
     * v0.6.4 はリンクを「ファイルとして扱わない」だけで、指す先を見ていなかった。実測:
     *
     * ```
     * 指す先が無い          検算 v9 status OK ／ bsdtar・python とも展開に失敗
     * 指す先が後ろにある     同上（前方参照も両実装で展開できない）
     * ```
     *
     * **「検算は通るのに、誰も展開できない」archive を受理していた。**
     * 差分試験は展開できない archive を「比べようがない＝合格」と数えるので、
     * ここを通すと**見えないファイルを混ぜる足場になる**（監査の指摘どおり再現した）。
     * `seenPaths` はここまでに出た名前だけを持つので、前方参照も同じ検査で落ちる。
     */
    if (type === '1') {
      const target = canonicalLinkTarget(effectiveLink, name, entries)
      /**
       * **自分自身を指す hardlink を拒む（v0.6.6・外部監査 P0-1）。**
       *
       * v0.6.5 は、この entry の名前を `seenPaths` へ入れた**あと**に指す先を見ていたので、
       * **自分を指すリンクが「指す先が在る」と判定されていた。**実測:
       * 検算 v10 は status OK ／ bsdtar は `Skipping hardlink pointing to itself` で exit 1 ／
       * python は KeyError。
       */
      if (target === name) {
        throw new ArchiveInvalid(
          `hardlink が自分自身を指している（展開できない）: ${name}`,
          { name, entryIndex: entries , stableReasonCode: 'HARDLINK_SELF_REFERENCE' },
        )
      }
      const targetType = seenPaths.get(target)
      if (targetType === undefined) {
        throw new ArchiveInvalid(
          `hardlink の指す先が、ここまでの entry に無い（展開できない）: ${name} -> ${target || '(空)'}`,
          { name, linkname: target, entryIndex: entries , stableReasonCode: 'HARDLINK_TARGET_MISSING' },
        )
      }
      /**
       * **指す先が通常ファイルであることまで見る（v0.6.6・外部監査 P0-1）。**
       *
       * v0.6.5 は「名前が在るか」しか見ていなかったので、
       * **ディレクトリを指す hardlink**が通っていた。実測: 検算 v10 は status OK ／
       * bsdtar は `Can't create ... Operation not permitted` で exit 1。
       * hardlink は通常ファイルにしか張れない。
       */
      /**
       * **連鎖は辿る（v0.6.7・外部監査 P1-B）。**
       *
       * v0.6.6 は「指す先が通常ファイルか」だけを見ていたので、
       * `A`（通常）→ `B -> A` → `C -> B` という**正当な連鎖**を拒んでいた。
       * 実測（2026-08-10）: bsdtar・python とも exit 0 で `nlink=3` の 3 本ができる。
       * **こちらの過剰拒否が、これで 3 版続けてである。**
       *
       * 指す先は必ず**先行 member**なので、そこまでの解決結果を引けば 1 段で終わる。
       * 循環は「先行 member にしか張れない」ことから作れず、
       * 作ろうとすると「指す先が無い」で先に止まる（実測: bsdtar exit 1 / python KeyError）。
       */
      let finalTarget
      if (targetType === '0') {
        finalTarget = target
      } else if (targetType === '1') {
        finalTarget = hardlinkResolved.get(target)
        if (finalTarget === undefined) {
          throw new ArchiveInvalid(
            `hardlink の連鎖を辿れない（先行 member の解決結果が無い）: ${name} -> ${target}`,
            { name, linkname: target, entryIndex: entries , stableReasonCode: 'HARDLINK_CHAIN_UNRESOLVED' },
          )
        }
      } else {
        throw new ArchiveInvalid(
          `hardlink の指す先が通常ファイルではない（展開できない）: ${name} -> ${target}（type ${targetType}）`,
          { name, linkname: target, targetType, entryIndex: entries , stableReasonCode: 'HARDLINK_TARGET_NOT_A_FILE' },
        )
      }
      hardlinkResolved.set(name, finalTarget)
    }

    // **リンクはファイルとして扱わない。**中身が無いのに「source にあった」ことになる
    if (type === '1' || type === '2') continue
    if (type !== '0') continue
    // 末尾スラッシュは上で型ごとに見ている（v0.6.8。ここに来る通常ファイルは / で終わらない）
    // 重複は上の `seenPaths` で既に止めている（ここへ来る時点で name は初出）
    files.set(name, data)
  }

  /**
   * **宙に浮いた名前の上書きを残したまま終わらない（v0.6.5）。**
   *
   * GNU long name（`L`）や PAX `path=` は「次の entry の名前」なので、
   * 次が来ないまま archive が終わるのは壊れている。実測: `tar` は
   * `Damaged tar archive` で展開を拒む。v0.6.4 は**空の files を返して受理**していた。
   *
   * **これは監査の指摘ではなく、強化した差分試験（受理したのに展開できない）が拾った。**
   */
  if (longNameFrom) {
    throw new ArchiveInvalid(
      `名前の上書き（${longNameFrom}）のあとに entry が無いまま archive が終わっている`,
      { pending: longName , stableReasonCode: 'EXTENSION_HEADER_DANGLING' },
    )
  }
  /**
   * **linkname の上書きも同じ（v0.6.7・外部監査 P0-B）。**
   *
   * v0.6.6 は名前の側にしか終端検査が無かった。実測（2026-08-10）:
   *
   * ```
   * K のあとに entry が無い        検算 v11 READ ／ bsdtar exit 1（Damaged tar archive）
   *                                          ／ python exit 2（ReadError: end of file header）
   * PAX linkpath のあとに entry 無し 同じ
   * ```
   *
   * **どちらの実装も「壊れている」と言う archive を受理していた。**
   */
  if (longLinkFrom) {
    throw new ArchiveInvalid(
      `linkname の上書き（${longLinkFrom}）のあとに entry が無いまま archive が終わっている`,
      { pending: longLink , stableReasonCode: 'EXTENSION_HEADER_DANGLING' },
    )
  }
  /**
   * **終端の印を見ないまま尽きたなら、切れている（v0.6.11・こちらで見つけた）。**
   *
   * 上のループは `off + 512 <= buf.length` で回るので、**512 に満たない端数が残ると黙って抜ける。**
   * 実測（2026-08-11）: 終端 zero block を持たない source の末尾に 100 バイトを足すと、
   * 検算 v15 は `OK 32/32`、**bsdtar は `Truncated tar archive`**（python は通す）＝割れる。
   *
   * 終端の zero block を見て抜けた場合は `sawTerminator` が立つので、ここへは来ない。
   * **終端のあとの端数は別の話**——2 実装とも読み飛ばすので、そちらは受理したままにする。
   */
  if (!sawTerminator && off < buf.length) {
    throw new ArchiveInvalid(
      '終端の印を見ないまま archive が尽きている（切れている）',
      { leftoverBytes: buf.length - off, stableReasonCode: 'END_OF_ARCHIVE_MISSING' },
    )
  }
  /**
   * **鍵に関係なく、`x` のあとに member が無いまま終わるのを拒む（v0.6.8・外部監査 P0-B）。**
   * 上の 2 つは `path` / `linkpath` を持つ `x` しか捕まえない。
   * `mtime` だけの `x` を末尾に置く形が素通りしていた（実測: 2 実装とも拒む archive）。
   */
  if (pendingPax) {
    throw new ArchiveInvalid(
      'local PAX ヘッダのあとに entry が無いまま archive が終わっている',
      { entryIndex: pendingPax.entryIndex, keys: pendingPax.keys , stableReasonCode: 'EXTENSION_HEADER_DANGLING' },
    )
  }
  return { files, inventory, headerFormats: [...headerFormats].sort() }
}

/**
 * GitHub の tarball は `<repo>-<sha>/` を頭に付ける。剥がす。
 *
 * **剥がすかどうかは inventory（全 entry）で決める（v0.6.4）。**
 * `files` の key だけで決めると、ファイル以外が別の root に居る archive を
 * 「単一 root」と誤って判定しうる。剥がす／剥がさないは両方に同じく効かせる。
 */
function stripTopLevel(files, inventory) {
  const all = inventory.map((e) => e.name)
  if (!all.length) return { files, inventory, rootStripped: null }
  const first = all[0].split('/')[0]
  if (!all.every((n) => n === first || n.startsWith(`${first}/`))) {
    return { files, inventory, rootStripped: null }
  }
  /**
   * **剥がす前に、その頭がディレクトリであることを確かめる（v0.6.5・外部監査 P0-1）。**
   *
   * v0.6.4 は「全部が同じ頭で始まる」だけを見て剥がしていた。
   * **その頭が通常ファイルとして archive に入っていても剥がしていた**ので、
   * どの展開器でも作れない木を「source として受理」していた。実測:
   *
   * ```
   * regular root = ROOTFILE ／ regular root/... が 2 件
   *   検算 v9  status OK・files に空文字の key が残る
   *   bsdtar   exit 1（root は directory ではない）
   *   python   NotADirectoryError
   * ```
   *
   * 明示的な root entry が無ければ implicit directory として剥がしてよい。
   * 在るならディレクトリ型（`5` か末尾スラッシュ）だけ許す。
   */
  /**
   * **頭の下に何も無いなら、剥がす話にならない（v0.6.9・こちらで見つけた）。**
   *
   * v0.6.5 からここは「頭が directory でなければ壊れている」と言っていたが、
   * **entry がその頭 1 個しか無いとき**まで同じ扱いにしていた。実測（2026-08-11）:
   *
   * ```
   * 単独の symlink / 単独の通常ファイル（名前は頭と同じ）
   *   検算 v13  ARCHIVE_INVALID
   *   bsdtar    exit 0 — そのとおりの symlink / ファイルを作る
   *   python    同じ
   * ```
   *
   * **2 実装が同じ木を作るものを「壊れている」と言っていた**＝過剰拒否。
   * 剥がさずに返す（ファイルが 0 件なら、そのあと `NOTHING_TO_VERIFY` になる）。
   * v0.6.9 で末尾スラッシュつきの root を試したときに、この試験自身が見つけた。
   */
  if (all.every((n) => n === first)) return { files, inventory, rootStripped: null }
  const explicitRoot = inventory.find((e) => e.name === first)
  if (explicitRoot && !(explicitRoot.type === '5' || explicitRoot.isDirEntry)) {
    throw new ArchiveInvalid(
      `先頭の 1 階層 "${first}" が ${explicitRoot.type === '0' ? '通常ファイル' : `type ${explicitRoot.type}`} なのに、`
      + 'その下に entry がある（どの展開器でもこの木は作れない）',
      { root: first, type: explicitRoot.type , stableReasonCode: 'ROOT_STRIP_NOT_A_DIRECTORY' },
    )
  }
  const cut = (n) => (n === first ? '' : n.slice(first.length + 1))
  /** **空 key を作らない。**`files` 側は v0.6.4 で filter が抜けていた */
  const strippedFiles = new Map()
  for (const [n, v] of files) { const c = cut(n); if (c) strippedFiles.set(c, v) }
  return {
    files: strippedFiles,
    inventory: inventory.map((e) => ({ ...e, name: cut(e.name) })).filter((e) => e.name),
    rootStripped: first,
  }
}

/** gunzip。**展開後のサイズに上限を置く**（zip bomb で落ちないため） */
function gunzipLimited(buf) {
  try {
    return gunzipSync(buf, { maxOutputLength: TAR_LIMITS.maxTotalBytes })
  } catch (e) {
    throw new ArchiveInvalid(`gzip を展開できない: ${String(e.message).split('\n')[0]}`,
      { stableReasonCode: 'GZIP_DECODE_FAILED' })
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
        // 資源上限は方針であって、相手が送ってきたものの欠陥ではない（v0.6.7）
        throw new ArchiveUnsupported(
          `受け取った本文が大きすぎる (> ${limit} バイト)`,
          { receivedBytes: total, limit , stableReasonCode: 'LIMIT_BODY_BYTES_UNSUPPORTED' },
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
    const { files, inventory, headerFormats } = readTar(gzip ? gunzipLimited(buf) : buf)
    return { ...stripTopLevel(files, inventory), headerFormats }
  } catch (e) {
    /**
     * **止めた理由に、文章とは別の安定した名前を付ける（v0.6.9・外部監査 §6）。**
     * 文章は版ごとに書き換わる。受け手が機械で分岐するなら、変わらない名前が要る。
     * 具体値（欄名・型・パス）は `detail` に置き、**欄ごとの code は作らない**（監査 §6）。
     */
    /** **対応していない（v0.6.7）と壊れている（v0.6.0）を分ける。**扱いはどちらも「中身を見ない」 */
    if (e instanceof ArchiveUnsupported) {
      return { error: e.message, kind: 'ARCHIVE_UNSUPPORTED', detail: e.detail, stableReasonCode: e.detail?.stableReasonCode ?? 'ARCHIVE_UNSUPPORTED_OTHER' }
    }
    if (e instanceof ArchiveInvalid) {
      return { error: e.message, kind: 'ARCHIVE_INVALID', detail: e.detail, stableReasonCode: e.detail?.stableReasonCode ?? 'ARCHIVE_INVALID_OTHER' }
    }
    return { error: `archive を読めない: ${String(e.message).split('\n')[0]}`, kind: 'ARCHIVE_INVALID', stableReasonCode: 'ARCHIVE_INVALID_OTHER' }
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
        // 資源上限は方針であって、archive の欠陥ではない（v0.6.7）。kind は catalog から引く
        ...archiveError('LIMIT_COMPRESSED_BYTES_UNSUPPORTED',
          `source archive が大きすぎる (${size} > ${TAR_LIMITS.maxCompressedBytes} バイト)`,
          { path, size, limit: TAR_LIMITS.maxCompressedBytes }),
      }
    }
    buf = readFileSync(abs)
  } catch (e) {
    return { error: `source archive を読めない (${path}): ${e.message}`, kind: 'SOURCE_UNAVAILABLE' }
  }
  const r = readArchiveBuffer(buf, { gzip: /\.(tgz|tar\.gz)$/i.test(path) })
  return r.error ? r : { files: r.files, inventory: r.inventory, rootStripped: r.rootStripped, origin: `archive:${path}` }
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
    return archiveError('SOURCE_ROOT_SYMLINK', `source がシンボリックリンクである: ${dir}`, { path: dir })
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
  /**
   * **archive と同じ上限をディレクトリにも効かせる（v0.6.2・外部監査 P1）。**
   *
   * v0.6.1 は archive 側にだけ上限があり、ディレクトリ経路は**中身を全部 `readFileSync`** していた。
   * 実測（2026-08-06）: 検証に使わない 70 MB のファイルを 1 個置くだけで、
   * **最大 RSS が 43.8 MB → 114.8 MB** になった。**検算に使わないデータで潰せる。**
   *
   * 読む前に `lstat` で件数・パス長・サイズ・総量を見る。
   * **上限は archive と同じ値を使う**（片方だけ緩いと、緩いほうから入られる）。
   */
  let count = 0
  let total = 0
  const walk = (rel) => {
    for (const n of readdirSync(join(abs, rel) || abs).sort()) {
      const r = rel ? `${rel}/${n}` : n
      if (n === 'node_modules' || n === '.git') continue
      const st = lstatSync(join(abs, r))
      if (st.isSymbolicLink()) { skippedLinks.push(r); continue }
      if (st.isDirectory()) { walk(r); continue }
      /**
       * **通常ファイル以外を黙って飛ばさない（v0.6.11・外部監査 P0-C）。**
       *
       * v0.6.10 は `if (!st.isFile()) continue` で**FIFO・socket・device を落として**いた。
       * 実測（2026-08-11）: 範囲の中に `src/model/sneaky.fifo` を置くと、
       * 検算 v15 は `status OK / 未記録探索 performed:true / 候補 0 件`——
       * **探したと言いながら、その名前は出力に一度も出てこない。**
       *
       * symlink は archive 側（typeflag 2）と同じく「読み飛ばしたと記録する」。
       * それ以外は**この道具が中身を決められない型**なので、archive 側の許可表と同じく止める。
       */
      if (!st.isFile()) {
        const kind = st.isFIFO() ? 'fifo' : st.isSocket() ? 'socket'
          : st.isCharacterDevice() ? 'chardev' : st.isBlockDevice() ? 'blockdev' : 'unknown'
        throw new ArchiveUnsupported(
          `扱いを決めていない種別のノードがある（${kind}）: ${r}`,
          { name: r, nodeKind: kind, stableReasonCode: 'ENTRY_TYPE_UNSUPPORTED' },
        )
      }

      if (++count > TAR_LIMITS.maxEntries) {
        throw new ArchiveUnsupported(`ファイルが多すぎる (> ${TAR_LIMITS.maxEntries})`, { count, stableReasonCode: 'LIMIT_ENTRY_COUNT_UNSUPPORTED' })
      }
      if (r.length > TAR_LIMITS.maxPathLength) {
        throw new ArchiveUnsupported(`パスが長すぎる (${r.length} > ${TAR_LIMITS.maxPathLength})`, { name: r.slice(0, 80), stableReasonCode: 'PATH_TOO_LONG_UNSUPPORTED' })
      }
      if (st.size > TAR_LIMITS.maxEntryBytes) {
        throw new ArchiveUnsupported(`ファイルが大きすぎる (${st.size} > ${TAR_LIMITS.maxEntryBytes})`, { name: r, size: st.size, stableReasonCode: 'LIMIT_ENTRY_BYTES_UNSUPPORTED' })
      }
      total += st.size
      if (total > TAR_LIMITS.maxTotalBytes) {
        throw new ArchiveUnsupported(`総量が大きすぎる (> ${TAR_LIMITS.maxTotalBytes})`, { total, stableReasonCode: 'LIMIT_TOTAL_BYTES_UNSUPPORTED' })
      }
      // **読むのは上限を全部通ったあと。**判定より先に載せない
      files.set(r, readFileSync(join(abs, r)))
    }
  }
  try {
    walk('')
  } catch (e) {
    /**
     * **上限超過（ArchiveInvalid）と、fs のエラーを分ける。**
     * 前者は「取れたが受け取れない量／形」、後者は「取れなかった」。
     * どちらも生の例外で落とさない——出力が JSON でなくなると、
     * 受け手は「合わなかった」と「道具が落ちた」を区別できない。
     */
    if (e instanceof ArchiveUnsupported) {
      return {
        error: `source ディレクトリ (${dir}): ${e.message}`,
        kind: 'ARCHIVE_UNSUPPORTED',
        detail: e.detail,
        stableReasonCode: e.detail?.stableReasonCode ?? 'SOURCE_DIRECTORY_UNREADABLE',
      }
    }
    if (e instanceof ArchiveInvalid) {
      return {
        error: `source ディレクトリ (${dir}): ${e.message}`,
        kind: 'ARCHIVE_INVALID',
        detail: e.detail,
        stableReasonCode: e.detail?.stableReasonCode ?? 'ARCHIVE_INVALID_OTHER',
      }
    }
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
  /**
   * ディレクトリ入力の inventory は、読めた通常ファイルに
   * **読み飛ばした symlink の名前も足す**（v0.6.4・P0-B）。
   * archive 経由と同じく、完全性の検査が「在るもの全部」を見られるようにするため。
   */
  const dirInventory = [
    ...[...files.keys()].map((name) => ({ name, type: '0', isDirEntry: false })),
    ...skippedLinks.map((name) => ({ name, type: '2', isDirEntry: false })),
  ]
  const { files: stripped, inventory: strippedInv, rootStripped } = stripTopLevel(files, dirInventory)
  return {
    files: stripped,
    inventory: strippedInv,
    rootStripped,
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
  return r.error ? r : { files: r.files, inventory: r.inventory, rootStripped: r.rootStripped, origin: `git-archive:${tag}` }
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
    return archiveError('LIMIT_COMPRESSED_BYTES_UNSUPPORTED',
      `GitHub が申告した本文が大きすぎる (${declared} > ${TAR_LIMITS.maxCompressedBytes} バイト)`,
      { declaredBytes: declared, limit: TAR_LIMITS.maxCompressedBytes })
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
    if (e instanceof ArchiveUnsupported) return { error: e.message, kind: 'ARCHIVE_UNSUPPORTED', detail: e.detail }
    if (e instanceof ArchiveInvalid) return { error: e.message, kind: 'ARCHIVE_INVALID', detail: e.detail }
    return { error: `本文を受け取れなかった: ${String(e.message).split('\n')[0]}`, kind: 'SOURCE_UNAVAILABLE' }
  }
  const r = readArchiveBuffer(gz, { gzip: true })
  return r.error ? r : { files: r.files, inventory: r.inventory, rootStripped: r.rootStripped, origin: `github-tarball:${REPO}@${tag}` }
}

// ---------------------------------------------------------------------------

/**
 * **import されたときは実行しない（v0.6.0）。**
 * `test/tarHardening.test.ts` が parser を直接呼ぶため。
 * 以前は import した時点で main が走り、`process.exit(2)` でテストごと落ちていた。
 *
 * **v0.6.13: 名前ではなく「起動された本体か」で判定する。**
 * v0.6.12 まで `/verifyReleaseSourceInputs\.mjs$/` とファイル名を見ていたので、
 * **受け手がコピーの名前を変えたり symlink を張ったりすると、何も出さずに `exit 0`** で終わった。
 * 実測（2026-08-12）: `renamed.mjs` も `link.mjs` も **出力 0 バイト / exit 0**。
 * **終了コードだけを見る受け手には、合格と区別が付かない。**
 *
 * `realpathSync` を両側に掛けるのは symlink のため——Node は既定で実 path を解決して
 * module を読むので、`import.meta.url` は実体を指すのに `process.argv[1]` は
 * symlink のままになる。片側だけだと symlink 経由の起動を取りこぼす。
 */
const RUN_AS_CLI = (() => {
  if (typeof process.argv[1] !== 'string') return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    // path を解決できない起動のされ方（消えた実体・権限）では CLI として走らない
    return false
  }
})()

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
     * **4 つを潰さない（v0.6.0 P1 / v0.6.7 で 1 つ増えた）。**
     *   SOURCE_UNAVAILABLE  … 取れなかった（無い・繋がらない・timeout）。検証していない
     *   ARCHIVE_INVALID     … 取れたが archive が壊れているか敵対的。**中身を信用しない**
     *   ARCHIVE_UNSUPPORTED … 取れて、ふつうの tar なら展開できるが、**この道具の範囲の外**
     *   MISMATCH            … 読めたが記録と合わない（下の突き合わせで出る）
     * v0.5.2 までは前 2 つが同じ SOURCE_UNAVAILABLE だった。
     * **受け手が記録を保存しても、通信の問題なのか改竄なのか読み分けられない。**
     * v0.6.6 までは 3 つ目が 2 つ目に混ざっており、**展開できる archive を「壊れている」と言っていた。**
     */
    /**
     * **loader が返してよい status かは `CLI_STATUS_META` が持つ（v0.6.14・外部監査 P1-C）。**
     * 手書きの 2 要素配列だったときは、status を足すと黙って丸められる経路が残った。
     */
    const kind = CLI_STATUS_META[loaded.kind]?.fromLoad ? loaded.kind : 'SOURCE_UNAVAILABLE'
    const NOTE = Object.fromEntries(
      Object.entries(CLI_STATUS_META).filter(([, m]) => m.note).map(([s, m]) => [s, m.note]),
    )
    done({
      status: kind,
      /**
       * **止めた理由の名前を、いちばん外まで通す（v0.6.11・外部監査 §7）。**
       * `readArchiveBuffer` は付けていたのに、CLI の出力へ渡していなかった——
       * **受け手が機械で分岐できるのは、ここに出たものだけ。**
       */
      stableReasonCode: loaded.stableReasonCode
        ?? loaded.detail?.stableReasonCode
        ?? `${kind}_OTHER`,
      reason: loaded.error,
      detail: loaded.detail ?? null,
      manifest: MANIFEST,
      tag: TAG,
      fetch: FETCH,
      note: NOTE[kind],
    }, 2)
  }

  const src = loaded.files
  /** archive 経由なら全 entry の型つき一覧。ディレクトリ入力では null（走査時に自分で列挙する） */
  const srcInventory = loaded.inventory ?? null

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
  /**
   * **範囲定義は manifest に縛る（v0.6.11・外部監査 P0-A）。**
   *
   * v0.6.10 まで、`--scope` は**中身を一切確かめずに**受け取っていた。
   * manifest は `inputScope.sha256` を持っているのに、**照合していなかった。**実測（2026-08-11）:
   *
   * ```
   * --scope /nonexistent/s.json     status OK / exit 0（performed:false なのに OK）
   * src/model を除いた scope        status OK / 未記録候補 0（範囲を狭めれば何でも隠せる）
   * ```
   *
   * **範囲を差し替えられるなら、「範囲の中に記録漏れは無い」は何も言っていない。**
   * 記録された sha256 と**完全一致**したときだけ、その範囲を信じる。
   */
  function loadScope() {
    const pinned = manifest.inputScope?.sha256 ?? null
    const bind = (text, origin) => {
      const actual = createHash('sha256').update(text).digest('hex')
      if (pinned && actual !== pinned) {
        return {
          error: `範囲定義が manifest の記録と違う（${origin}）`,
          detail: { expectedSha256: pinned, actualSha256: actual, origin },
          code: 'SCOPE_SHA256_MISMATCH',
        }
      }
      let scope
      try { scope = JSON.parse(text) } catch (e) {
        return { error: `範囲定義を parse できない（${origin}）: ${e.message}`, code: 'SCOPE_UNPARSEABLE' }
      }
      /** **形も見る。**JSON として読めても、別物なら範囲を名乗れない */
      if (!scope || typeof scope !== 'object' || !Array.isArray(scope.recursiveDirectories)) {
        return { error: `範囲定義の形が違う（${origin}）: recursiveDirectories が無い`, code: 'SCOPE_SCHEMA_INVALID' }
      }
      /**
       * **manifest が範囲を記録していないなら、その範囲は誰にも縛られていない（v0.6.11・監査 §1）。**
       * v0.3.0 より前の tag はここに当たる。**黙って受けると、範囲を差し替え放題になる。**
       * 明示的に `--allow-unpinned-scope` を渡したときだけ先へ進み、
       * それでも `OK` にはしない（下の `incomplete` へ入る）。
       */
      if (!pinned && !ALLOW_UNPINNED_SCOPE) {
        return {
          error: `manifest が範囲定義を記録していない（${origin}）。`
            + '古い tag を検算するなら --allow-unpinned-scope を明示すること（結果は OK にならない）',
          code: 'SCOPE_NOT_PINNED',
        }
      }
      return { scope, origin, boundTo: pinned ? 'manifest.inputScope.sha256' : null, sha256: actual, unpinned: !pinned }
    }
    if (SCOPE_OVERRIDE) {
      let text
      try { text = readFileSync(resolve(ROOT, SCOPE_OVERRIDE), 'utf8') } catch (e) {
        return { error: `--scope ${SCOPE_OVERRIDE} を読めない: ${e.message}`, code: 'SCOPE_UNREADABLE' }
      }
      return bind(text, `override:${SCOPE_OVERRIDE}`)
    }
    const buf = src.get(SCOPE_FILE)
    if (buf === undefined) {
      return {
        error: `検証対象の source に ${SCOPE_FILE} が無い`
          + '（v0.3.0 以前の tag には入っていない）。--scope <file> で明示すれば検出できる。',
        code: 'SCOPE_ABSENT',
      }
    }
    return bind(buf.toString('utf8'), `source:${SCOPE_FILE}`)
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
    /**
     * **母集団は `src`（通常ファイル）ではなく inventory（archive に在るもの全部）（v0.6.4・P0-B）。**
     *
     * v0.6.3 は `src.keys()` を走査していた。`src` には通常ファイルしか入らないので、
     * **scope の下に置いた symlink / hardlink / ディレクトリ以外の型が探索から消えた**——
     * 検算は `未記録候補 0 件` と言い、bsdtar と python はどちらもそれを展開する（実測）。
     * ディレクトリ entry だけは中身を持たないので母集団から外す。
     */
    const present = srcInventory
      ? srcInventory.filter((e) => e.type !== '5' && !e.isDirEntry).map((e) => e.name)
      : [...src.keys()]
    const inScope = new Set()
    for (const d of scope.recursiveDirectories ?? [])
      for (const p of present) if (p.startsWith(`${d}/`)) inScope.add(p)
    const presentSet = new Set(present)
    for (const p of [...(scope.requiredExactFiles ?? []), ...(scope.allowedGeneratedInputs ?? [])])
      if (presentSet.has(p)) inScope.add(p)
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
  /**
   * **`OK` は「必須の工程が全部終わった」ときだけ（v0.6.11・外部監査 P0-A / §7）。**
   *
   * v0.6.10 まで、`status` は**不一致が無いこと**しか見ていなかった。
   * だから**記録漏れの探索をしていなくても `OK`** になった——
   * 受け手には「探して見つからなかった」と読める。実測: 存在しない `--scope` で `OK / exit 0`。
   *
   * **やらなかったことは、合格ではない。**やれなかった工程があるなら
   * `VERIFICATION_INCOMPLETE` と言う（exit も 0 にしない）。
   */
  const incomplete = scope
    ? (loadedScope.unpinned ? ['scope-not-pinned-to-manifest'] : [])
    : ['unrecorded-input-detection']
  const status = bad.length || extra.length || selfReferencing.length
    ? 'MISMATCH'
    : incomplete.length ? 'VERIFICATION_INCOMPLETE' : 'OK'

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
        /** **どの記録に縛られているか。**null なら manifest が範囲を記録していない古い版 */
        boundTo: loadedScope.boundTo,
        scopeSha256: loadedScope.sha256,
      }
    : {
        performed: false,
        scopeSource: null,
        stableReasonCode: loadedScope.code ?? 'SCOPE_UNAVAILABLE',
        detail: loadedScope.detail ?? null,
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
    /** **終わっていない必須工程。**空でなければ `OK` にはならない（v0.6.11） */
    incompletePhases: incomplete,
    /**
     * **先頭 1 階層を剥がしたかどうか（v0.6.11・外部監査 §7）。**
     * GitHub の tarball は `trs-jack-3d-<sha>/` を頭に持つ。剥がした事実を出さないと、
     * 受け手は「manifest のパスと source のパスが一致した」の意味を確かめられない。
     */
    rootTransform: { stripped: loaded.rootStripped ?? null },
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
