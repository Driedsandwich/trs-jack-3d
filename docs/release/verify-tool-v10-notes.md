# 検算ツール `verifyReleaseSourceInputs.mjs` を v10 にしました（受け手向け）

対象: 配布物に同梱している `verifyReleaseSourceInputs.mjs`
出力の `toolVersion` が **9 → 10** になります。

v9（v0.6.4）の続きです。外部監査（2026-08-08）が **P0 4 件と P1 1 件**の反例を出し、
**こちらで全件再現してから**直しています。

> **P1 はこちらの過剰拒否でした。**v9 が**正当な archive を拒んでいた**もので、
> 「実物が通る」だけを見ていては見つかりません。下の 5 に書きます。

## 反例をどう確かめたか

GNU tar はこの環境に無いので、**bsdtar 3.5.3（libarchive 3.7.4）と Python 3.14 の `tarfile`**
の 2 実装で測りました。監査は GNU tar 1.35 と比べています。

## 1. 先頭 1 階層を、ディレクトリか確かめずに剥がしていた

GitHub の tarball は `<repo>-<sha>/` を頭に付けるので、検算器はそれを剥がします。
v9 は「全部が同じ頭で始まる」だけを見ており、**その頭が通常ファイルでも剥がしていました。**

```
regular root = ROOTFILE ／ regular root/... が 2 件
  検算 v9  status OK・files に**空文字の key** が残る
  bsdtar   exit 1（root は directory ではない）
  python   NotADirectoryError
```

**どの展開器でも作れない木を「source として受理」していました。**

v10 は、明示的な root entry があるならディレクトリ型だけ許します
（無ければ従来どおり implicit directory として剥がします）。空 key も作りません。

## 2. 受理するのに、誰も展開できない archive があった

```
正常なファイル 2 件 ＋ 指す先の無い hardlink
  検算 v9  status OK / 2 件中 2 件一致 / 未記録 0
  bsdtar   exit 1 — Hard-link target not found
  python   KeyError: linkname not found
```

**これは差分試験の足場になります。**「展開できない archive は比べようがない＝合格」と
数えていたので、ここを通すと**見えないファイルを混ぜられます**（監査の指摘どおり再現しました）。

v10 は hardlink の指す先が**ここまでの entry に在ること**を要求します。
前方参照（後ろの entry を指す）も両実装で展開できないので、同じ検査で落ちます。

## 3. PAX の `path` に入れた NUL を切り捨てていた

PAX のレコードは**長さで区切る**ので、NUL は詰め物ではなく値の一部です。
v9 は固定長ヘッダ欄と同じ関数で読んでいたため、NUL 以降を黙って捨てていました。

```
PAX path = root/src/model/a.ts\0evil
  検算 v9  root/src/model/a.ts として status OK
  bsdtar   同じく切り捨てる
  python   embedded null で展開に失敗する
```

v10 は固定長欄用と PAX テキスト用で読み方を分け、PAX 側では NUL を拒みます。

## 4. PAX の denylist は閉じていなかった → allowlist にしました

v9 は「見え方を変える鍵」を数え上げて拒み、**未知の鍵は通していました。**

```
PAX x: SUN.holesdata=...（Solaris の sparse map）
  検算 v9  status OK（未知の鍵として無視）
  bsdtar   exit 1 — Parse error: SUN.holesdata で archive ごと拒否
  python   展開できる
```

**3 者で結末が割れます。**数え上げでは閉じないので、**通す鍵を並べる形**へ変えました。

```
通す   path（解釈する）／ mtime・atime・ctime ／ uid・gid・uname・gname ／ comment
       LIBARCHIVE.xattr.* ／ SCHILY.xattr.*（値は読まない不透明な metadata）
拒む   上記以外すべて（未知の vendor 鍵を含む）
```

**通す鍵は実物を数えてから決めました。**GitHub の tarball は `g:comment` だけ、
macOS の `tar` は `x:mtime` と `x:LIBARCHIVE.xattr.*` / `x:SCHILY.xattr.*` です（実測）。

## 5. **v9 は正当な archive を拒んでいました**（こちらの過剰拒否）

v9 は「同じ member に名前の上書きが 2 つ効いたら止める」を入れましたが、
**上書きの出所を member 消費時に戻し忘れていました。**

```
独立した 2 つの member が、それぞれ長い名前を 1 回ずつ使う
  検算 v9  ARCHIVE_INVALID（二重の上書きだと誤認）
  bsdtar   2 件とも展開する
  python   2 件とも展開する
```

**この repo の実物では踏みません**——最長パスが 95 文字で、long name 機構を使わないためです。
**「実物が通る」だけでは、過剰拒否は見つかりません。**

## 6. 差分試験を 2 実装にしました

v9 の差分試験は `tar`（この環境では bsdtar）**1 実装だけ**を機械で強制していました。
**oracle が持つ癖と同じ癖を検算器が持っていると、差分は出ません。**実測:

```
PAX path の NUL 切り捨てを v9 の形へ戻す変異
  差分試験（bsdtar のみ）  0 件が落ちる  ← bsdtar も同じく切り捨てるため
  期待値の表              1 件が落ちる
  差分試験（+ python）     1 件が落ちる  ← 2 実装目で初めて割れる
```

v10 からは **bsdtar と python tarfile の両方**を必須にし、
**2 つが違う木を作る archive は受理しません。**（GNU tar・BusyBox はまだ入っていません。）

あわせて、v9 の差分試験にあった弱点を 3 つ直しました。

- **展開失敗を「合格」と数えていた** → 受理したのに展開できないなら、その時点で食い違い
- **中身を UTF-8 文字列で比べていた** → 生バイトで比べる（不正バイトが U+FFFD に潰れて一致して見える）
- **剥がした頭を `endsWith` で推測していた** → 記録した値で戻す

## 7. 強化した試験が、もう 1 件見つけました

**これは監査の指摘ではありません。**上の「受理したのに展開できない」を入れたところ、
既存の材料が 1 件落ちました。

```
GNU long name のあとに entry が無いまま archive が終わる
  検算 v9  空の files を返して受理
  tar      Damaged tar archive で展開を拒む
```

v10 は、宙に浮いた名前の上書きを残したまま終わる archive を拒みます。

## 塞ぎすぎていないこと

```
GitHub の実 tarball    v0.5.2 = 246 ／ v0.6.2 = 284 ／ v0.6.4 = 293 ファイル
HEAD の source          295 ファイル
macOS tar が作ったもの   通る（生バイナリ xattr を含む・長いパスを含む）
```

壊れた tar の corpus は **39 個 8 種類 → 50 個 9 種類**に増えました。

## どの検査が効いているか（変異試験）

| 外した検査 | `tarHardening` | 差分試験 |
|---|---:|---:|
| root がディレクトリかの検査 | 3 | 3 |
| hardlink の指す先の検査 | 3 | 2 |
| PAX の NUL 切り捨てを戻す | 1 | 1 |
| PAX allowlist を素通しに | 3 | 3 |
| 上書きの出所を戻さない（v9 の過剰拒否） | 5 | 0 |

> **`ARCHIVE_INVALID` を投げる行だけを消す変異は、どれも落ちませんでした。**
> NUL は既存の制御文字検査が、未知鍵は allowlist が、それぞれ後段で拾うためです。
> **「その検査が無いと素通りする」形の変異でないと、効いていることは示せません。**

## 変わらないこと

- **read-only** です。書き込み API を使わず、tar は展開せずメモリ上で読みます
- network は既定で使いません（`--fetch github` を明示したときだけ）
- `status` の種類は増えていません。`ARCHIVE_INVALID` は v1 の自己申告 schema では
  表現できないままです（受け手向けの CLI 結果 schema は**まだ作っていません**）
