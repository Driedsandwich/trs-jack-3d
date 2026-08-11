# 検算ツール `verifyReleaseSourceInputs.mjs` を v13 にしました（受け手向け）

対象: 配布物に同梱している `verifyReleaseSourceInputs.mjs`
出力の `toolVersion` が **12 → 13** になります。

v12（v0.6.7）の続きです。外部監査（2026-08-11）が **P0 2 件と P1 4 件**の反例を出しました。
**6 群すべてを、こちらで組み立て直して再現できました。**

> **今回の監査パケットも checksum が合いました**（`shasum -a 256 -c` が exit 0）。

## 手元で確かめられた範囲

開発機（macOS）は **bsdtar 3.5.3 / libarchive 3.7.4 と Python 3.14** の 2 実装。
CI は **ubuntu（GNU tar 1.35 / Python 3.12.3）と macOS** の matrix です。BusyBox はありません。

## 1. **生の USTAR 数値欄を、`size` しか見ていませんでした**（P0-A）

```
mode=abc / uid=abc / gid=abc / mtime=abc（checksum は取り直し）
  検算 v12  READ — 「a.txt が source にある」と言う
  bsdtar    exit 0 — a.txt を作る
  python    exit 0 — **黙って a.txt を作らない**（OK と表示して終わる）

checksum 欄が「8 進の頭 + junk」
  検算 v12  READ — 同上
  bsdtar    exit 0 だが Damaged tar archive と警告し、a.txt を作らない
  python    a.txt を作らない
```

**同じ archive から別の木ができます。**受け手が python で展開すると、
検算器が「あった」と言ったファイルが手元にありません。

原因は 2 つです。**`mode`/`uid`/`gid`/`mtime`/`devmajor`/`devminor` は読んでもいませんでした。**
checksum 欄は `/^[0-7]+/` の**前方一致**でしか見ておらず、そのあとの junk を見逃していました。

v13 は `parseTarNumericField` に集約し、**欄まるごと**見ます。
受け入れる形は実物を測って決めました（2026-08-11 実測・4 通りありました）。

```
GitHub tarball / git archive   7 桁 + NUL      size と mtime は 11 桁 + NUL
macOS tar (bsdtar)             6 桁 + 空白 + NUL   size と mtime は 11 桁 + 空白
checksum 欄                    7 桁 + NUL ／ 6 桁 + NUL + 空白
```

まとめると「**先頭の空白（任意）＋ 8 進数字 1 個以上 ＋ NUL と空白だけの詰め物**」。
base-256 はどの欄でも `ARCHIVE_UNSUPPORTED` です（v12 は `size` にしか掛けていませんでした）。

## 2. 宙に浮いた local PAX ヘッダ（P0-B）

```
全入力のあとに「x: mtime=1」だけを置き、後続 member を置かない
  検算 v12  READ
  bsdtar    exit 1 — Damaged tar archive
  python    exit 2 — ReadError: end of file header
```

v12 は `path` と `linkpath` にしか pending 状態がありませんでした。
**鍵に関係なく `x` は「次の member を待つ」状態を作ります。**

`L` / `K` は member ではないので pending を消費しません（実測: `x` → `L` → member は 2 実装とも通る）。
`x` が 2 つ続く形は止めます（実測: bsdtar は `Ignoring malformed pax extended attribute` で exit 1）。

## 3. **こちらの過剰拒否が 4 件**（P1）

```
directory の PAX path が / で終わる（path=root/dir/ ＋ type 5）
  検算 v12  ARCHIVE_INVALID — 空のパス要素がある
  bsdtar・python とも同じ木を作る

PAX の値の先頭ゼロ（uid=0001 / gid=0001 / mtime=01 / mtime=-01）
  検算 v12  ARCHIVE_INVALID — 数値として読めない
  bsdtar・python とも通す

歴史的な signed checksum（非 ASCII のパスを含む）
  検算 v12  ARCHIVE_INVALID — ヘッダの checksum が合わない
  bsdtar・python とも展開する

backslash を含むパス
  検算 v12  ARCHIVE_INVALID — 壊れている扱い
  Unix では 3 実装とも同じふつうの名前を作る（Windows では 1 階層上を指す）
```

**先頭ゼロは、前回の監査が勧めた正規表現がそのまま過剰拒否になった件です。**
`^-?(0|[1-9][0-9]*)…` を採ったので `uid=0001` が落ちていました。
POSIX の値は 10 進の数であって、綴りを 1 つに決めてはいません。
**範囲の検査は綴りではなく、読んだあとの値に掛けます**（`BigInt('0001')` は 1）。

v13 は綴りの検査を **member の型が分かるまで遅らせ**、
**末尾スラッシュは directory のときだけ**許します。
通常ファイルで `/` が付く形は止めます——実測で
**bsdtar は directory を作り、python は通常ファイルを作る**からです。

signed checksum は、**unsigned と signed の両方を計算してどちらか合えば受けます。**
どちらにも合わないヘッダは、これまでどおり落ちます。

backslash は `ARCHIVE_UNSUPPORTED` に移しました。
**壊れているのではなく、受け手の OS で意味が変わる**からです（監査 §7 の分類）。

## 4. 確かめる側の欠陥も 1 つ見つけました

`mode` 欄を壊した archive を展開すると**権限 0 のファイル**ができ、
木を歩く試験の道具が読めずに落ちていました。
**読めなかった事実を木に記録する**形に直したら、この件は手元でも根拠が取れました
（bsdtar は読めないファイルを作り、python は `filter=tar` で mode を丸める＝**違う木**）。

差分試験そのものも直しました（監査 §6）。

- **パスの一覧ではなく型つきの木**で比べます（型・指す先・中身のバイト）。
  v12 は名前だけを並べていたので、**同じ名前で片方が directory・片方が通常ファイル**でも差が出ませんでした。
- **python が無ければ「合格」ではなく失敗**にします。必須 oracle が動いていないなら、
  それは合格ではなく「確かめていない」です。

## 5. 止める理由が、どちらの実装で裏を取れるか

```
GNU tar 側でだけ根拠が取れる   9 件
bsdtar 側でだけ根拠が取れる    9 件
どちらでも取れていない         3 件
```

`none` の 3 件は、名前・指す先の上書きが 2 つ効く形の**片方の順序** 2 件と、
**symlink の名前が `/` で終わる形**です。
前 2 件は監査が BusyBox で裏を取ったと報告しています（こちらには BusyBox がありません）。
最後の 1 件は、手元の 2 実装がどちらも `/` を捨てて同じ symlink を作ります——
**typeflag は symlink・名前は directory と、entry が自分自身と矛盾している**ので止めています。

## 塞ぎすぎていないこと

```
GitHub の実 tarball v0.6.7    entry 330（数値欄の書き方まで実測して受け入れ範囲を決めた）
macOS tar が作ったもの         通る（6 桁 + 空白 + NUL の欄を含む）
git archive HEAD              entry 331
```

壊れた tar の corpus は **99 個 11 種類 → 119 個 12 種類**、
うち「通す」材料が **24 → 34 件**です。

## 変わらないこと

- **read-only** です。書き込み API を使わず、tar は展開せずメモリ上で読みます
- モデルの数値は 1 つも動いていません。`profileId` も v0.6.7 のままです
- 受け手向けの CLI 結果 schema と `stableReasonCode`（監査 §8）は**まだ作っていません**

## 戻し方

変更は検算ツールと試験だけです。`profileId`・区間・event・`verifiedPhysical` は動きません。
受け手は v0.6.7 の道具を使い続けられます（出力の `toolVersion` で見分けられます）。
判定が変わるのは、**上の 1〜3 に当たる archive を検算したときだけ**です。
