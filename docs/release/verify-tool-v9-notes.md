# 検算ツール `verifyReleaseSourceInputs.mjs` を v9 にしました（受け手向け）

対象: 配布物に同梱している `verifyReleaseSourceInputs.mjs`
出力の `toolVersion` が **8 → 9** になります。

v8（v0.6.3）の続きです。**v8 で塞いだつもりだった穴が 3 つ残っていました。**
外部監査（2026-08-06）が反例を出し、**こちらで再現してから**直しています。

## 反例をどう確かめたか

GNU tar はこの環境に無いので、**bsdtar 3.5.3（libarchive 3.7.4）と Python 3.14 の `tarfile`**
の 2 実装を oracle にしました。監査は GNU tar 1.35 と比べています。

**どれが「正しい」かを決める必要はありません。**実装間で結末が割れること自体が欠陥です。

## 1. 同じ member に名前の上書きが 2 つ効くと、実装ごとに結末が割れた

v8 は PAX の `path=` を解釈するようにしましたが、**GNU long name（`L`）と同じ変数へ後勝ちで
置いていた**ので、両方が効く archive を「読めた」と言っていました。

```
                          検算 v8     bsdtar      python
PAX path= → GNU L         gnu.txt     pax.txt     pax.txt     ← 両方と食い違う
GNU L → PAX path=         pax.txt     gnu.txt     gnu.txt     ← 両方と食い違う
PAX path= を 2 回          two.txt     拒否        one.txt     ← 三者が全部違う
PAX path= → PAX x(mtime)  pax.txt     拒否        pax.txt
```

v9 は、**上書き機構が 2 つ効いたら止めます。**global header（`g`）が `path` を持つ場合も止めます。

> **どれが正しいかを決める立場にありません。**正しい source archive にこの形は出てこないので、
> 「実装間で結末が割れるもの」は読まずに止めるほうを選びました。

## 2. 展開されるのに、検算の母集団から消える entry があった

v8 は通常ファイル（`typeflag 0`）だけを内部の Map に入れ、
**未記録入力の探索もその key しか見ていませんでした。**

```
scope 配下（src/model/）に置くと
  typeflag 7（contiguous）   検算 status OK・未記録候補 0 件 ／ bsdtar・python とも通常ファイルとして展開
  symlink                    検算 status OK・未記録候補 0 件 ／ 展開木には在る
  hardlink                   検算 status OK・未記録候補 0 件 ／ 展開木には在る
```

配布中の v8 で直接確かめた実測です。

```
scope 配下に symlink を仕込んだ source archive を渡す
  v8   status OK        未記録候補 []                      exit 0
  v9   status MISMATCH  未記録候補 ["src/model/sneaky.ts"]  exit 1
  対照 正常な source     未記録候補 0 件                     exit 0
```

v9 は**全 entry の型つき一覧（inventory）**を作り、範囲の完全性検査はそちらを母集団にします。
**リンクは止めません。**正当な archive にも出てくるので、止める代わりに「見える」ようにしました。
`typeflag 7` / `S` / `D` / `M` / `N` は、中身を持つのに扱いを決めていないので止めます。

## 3. パスの不正なバイトが U+FFFD へ置換されていた

v8 は `Buffer#toString('utf8')` でパスを読んでいました。これは**不正なバイトを黙って
U+FFFD へ置換します。**

```
raw   root/file<FF>.txt
  検算 v8  root/file<FFFD>.txt を検証して status OK
  bsdtar   生バイトのまま扱う（別のファイル名）
  python   生バイトのまま扱う（別のファイル名）
```

**置換して続けると、検算が見た名前と展開してできる名前が別物になります。**
v9 は `TextDecoder('utf-8', { fatal: true })` で読み、読めなければ止めます。
USTAR の name / prefix、GNU long name、PAX の鍵、PAX の `path` に効かせています。

> **値を一律に厳密化してはいけません。**実物の macOS `tar` は
> `LIBARCHIVE.xattr.*` / `SCHILY.xattr.*` に**生バイナリ**を書きます。
> 一度そう実装して実物の tarball を弾いたので、**解釈する値（`path`）だけ**厳密にしています。
> v8 でも同じ形の塞ぎすぎをやっており、2 回目です。

## 差分試験が片方向だったことも直しました

v0.6.3 で入れた「実展開との差分試験」は、**検算器が返した key を展開木で探す**方式でした。
これは **「展開されるのに検算器が数えない」欠陥を見られません。**

実測: `typeflag 7` の検査を外す変異を入れても、片方向の 48 件は **1 件も落ちませんでした。**

v9 では逆向きも見ます。

```
展開してできた通常ファイルは、検算器の files か inventory のどちらかに
現れていなければならない。どちらにも無いなら、
**検算器から見えていないファイルが source に混じる**。
```

## どの検査が効いているか（変異試験）

各検査を 1 つずつ外して、落ちる件数を測りました。

| 外した検査 | `tarHardening` | 実展開 oracle |
|---|---:|---:|
| 名前の上書きが 2 つ効く形を止める | 3 | 2 |
| 中身を持つ未対応 type を止める | 2 | 0 |
| パスの厳密 decode | 3 | 3 |
| inventory に全 entry を載せる | 0 | 2 |

**どちらか一方の試験だけでは足りません。**上 2 つと下 2 つで、捕まえる側が入れ替わります。

## 塞ぎすぎていないこと

```
GitHub の実 tarball    v0.5.2 = 246 ファイル ／ v0.6.2 = 284 ファイル
HEAD の source          289 ファイル
macOS tar が作ったもの   通る（LIBARCHIVE.xattr に生バイナリを含む）
```

壊れた tar の corpus は **26 個 6 種類 → 38 個 8 種類**に増えました。
v8 で `safe` だったものの結末は変わっていません。

## 変わらないこと

- **read-only** です。書き込み API を使わず、tar は展開せずメモリ上で読みます
- network は既定で使いません（`--fetch github` を明示したときだけ）
- `status` の種類は増えていません。`ARCHIVE_INVALID` は v5 のままで、
  v1 の自己申告 schema では表現できないままです（既知）
