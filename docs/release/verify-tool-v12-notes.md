# 検算ツール `verifyReleaseSourceInputs.mjs` を v12 にしました（受け手向け）

対象: 配布物に同梱している `verifyReleaseSourceInputs.mjs`
出力の `toolVersion` が **11 → 12** になります。

v11（v0.6.6）の続きです。外部監査（2026-08-10）が **P0 3 件と P1 3 件**の反例を出しました。

> **今回の監査パケットも checksum が合いました**（`shasum -a 256 -c` が exit 0）。

## 手元で確かめられた範囲

GNU tar と BusyBox はこの環境にありません。**bsdtar 3.5.3 と Python 3.14 の 2 実装**で測りました。
監査は GNU tar 1.35 / BusyBox 1.37 / libarchive 3.7.4 / python の 4 実装で測っています。

**指摘は 6 群あり、そのうち手元で再現できたのは 4 群です。**
再現できなかったものは下の「7」に分けて書きます。

## 1. 祖先が通常ファイルや symlink でも、その下の entry を受理していた（手元で再現）

**これがいちばん効く指摘です。**

```
regular root/src ／ regular root/src/model/a.ts
  検算 v11  READ（files に src と src/model/a.ts の両方が入る）
  bsdtar    exit 1 — Could not stat root/src/model/a.ts: Not a directory
  python    exit 2 — NotADirectoryError

symlink root/src -> elsewhere ／ regular root/src/model/a.ts
  検算 v11  READ
  bsdtar    exit 1 — Cannot extract through symlink
  python    exit 2 — FileNotFoundError
```

**どの展開器でもこの木は作れないのに、`status OK` を返していました。**

原因は、v11 が **entry を 1 つずつしか見ていなかった**ことです。
v0.6.5 で「先頭 1 階層が directory か」を塞ぎましたが、
**それは途中の階層でも同じことが起きるという一般形の、特殊な場合でした。**

v12 は祖先の型を持ち、**両方向**を見ます。片方だけではもう片方から入られます。

```
① あとから来た子の祖先が、すでに非ディレクトリとして出ている
② あとから来た非ディレクトリが、すでに誰かの祖先として使われている
```

こちらの実測では、hardlink を祖先にする形と、順序を逆にした 2 形も同じく通っていました
（**監査の反例は 2 個ですが、同じ穴から 5 個作れます**）。

## 2. linkname の上書きに状態機械が無かった（一部を手元で再現）

v11 は指す先の上書き（GNU `K` / PAX `linkpath`）を**後勝ちで置くだけ**でした。
名前の上書きには v0.6.4 から状態機械があるのに、指す先の側には無かったということです。

**手元で再現できたもの:**

```
global の linkpath（g ヘッダ）
  検算 v11  READ（受け取って黙って無視・inventory にはヘッダの値）
  bsdtar    root/ln -> root/t1   ← ヘッダの値を採る
  python    root/ln -> root/t2   ← global の値を採る      **同じ archive から別の木**

linkpath を 2 回
  検算 v11  READ
  bsdtar    exit 1 — Ignoring malformed pax extended attribute
  python    exit 0（1 つ目を採る）

K のあとに entry が無いまま archive が終わる ／ linkpath のあとに entry が無い
  検算 v11  READ
  bsdtar    exit 1 — Damaged tar archive
  python    exit 2 — ReadError: end of file header
```

**手元では再現できなかったもの:**

```
PAX linkpath → GNU K ／ GNU K → PAX linkpath
  bsdtar と python は**一致して「先に来たほう」を採る**（割れない）
  監査は GNU tar と BusyBox で指す先が分かれると報告している
```

v12 は `longLinkFrom` を持ち、**名前の上書きと同じ規則**を当てます。
`inventory` に入れる指す先も、**上書きが効いたあとの値**に直しました
（v11 はヘッダの 100 byte 欄をそのまま記録していたので、
`linkpath` を使う archive では**記録と展開結果が別物**でした）。

## 3. PAX の値の契約（一部を手元で再現）

```
uname / gname が不正 UTF-8
  検算 v11  READ
  bsdtar    exit 1 — Uname can't be converted from UTF-8 to current locale.
  python    exit 0                                         **割れる**

mtime = 9223372036854775807（int64 の上限）
  検算 v11  READ
  bsdtar    exit 0
  python    exit 2 — OverflowError: timestamp out of range  **割れる**
```

v12 は `uname` / `gname` を厳密 UTF-8 で読み、時刻・uid・gid に**範囲**を置きます。

時刻の上限は **±(2^53−1)** にしました。**この道具が誤差なく持てる整数の上限**です。
実測で両実装が通す範囲の内側にあり（`281474976710655` は両方 exit 0）、
実物の mtime（1.8×10^9）の約 500 万倍の余裕があります。

**uid / gid の上限 2^32−1 は手元では再現していません**（下の「7」）。

### 監査の勧告に従わなかったところ

監査は `comment` も strict text にすること、`uname` の NUL も拒むことを勧めています。
**測ったら、どちらも割れませんでした。**

```
comment に不正 UTF-8   bsdtar exit 0 ／ python exit 0
uname に NUL           bsdtar exit 0 ／ python exit 0
```

**根拠のない厳格化はしません。**塞ぎすぎは 3 版続けて出しており、
それは corpus に「通す」材料が薄いから見つからなかったものです。
この 2 つは**通す材料として corpus に入れました**——
あとから理由なく厳しくしたら試験が落ちます。

## 4. **こちらの過剰拒否が、これで 3 版続けてです**（手元で再現）

```
負の時刻（GNU tar がふつうに書く。1970 年より前の mtime）
  検算 v11  ARCHIVE_INVALID — mtime が数値として読めない: "-1"
  bsdtar    exit 0 ／ python exit 0

hardlink の連鎖（A 通常 → B -> A → C -> B）
  検算 v11  ARCHIVE_INVALID — 指す先が通常ファイルではない
  bsdtar    exit 0 ／ python exit 0（nlink=3 の 3 本ができる）

指す先の別の綴り（root/./A ・ ./root/A ・ root//A）
  検算 v11  ARCHIVE_INVALID — 指す先が、ここまでの entry に無い
  bsdtar    exit 0 ／ python exit 0
```

**`mtime=-1` は監査が「GNU tar が実際に生成した archive」で示してきたものです。**

v12 は負の時刻を通し、hardlink の連鎖を辿り、`.` と空要素だけ畳みます。
**`..` は畳みません**——実測で bsdtar が `Path contains '..'` で exit 1 になり、python は通すので、
そこは割れます。**どこまで揃えるかを、気分ではなく実測に合わせました。**

## 5. **監査に無い false-OK を 1 件、こちらの実測で見つけました**

上の「別の綴り」を測っている途中で出ました。

```
hardlink の指す先が / で終わる（root/B -> root/A/）
  検算 v11  READ            ← 受理していた
  bsdtar    exit 1 — Can't create 'root/B': Not a directory
  python    exit 0
```

v11 は指す先の末尾スラッシュを `.replace(/\/+$/, '')` で**剥がしてから**照合していました。
**剥がした結果は存在するので通り、実際には展開できません。**
v12 は剥がさずに拒みます。

## 6. `ARCHIVE_UNSUPPORTED` を新設しました（監査 P1-C）

v11 まで、止める理由は全部 `ARCHIVE_INVALID` でした。
だが実測で、**ふつうの tar が何事もなく展開する archive**をいくつも「壊れている」と言っていました。

```
base-256 の size 欄       bsdtar exit 0 ／ python exit 0
typeflag 7 / S / D / M / N  bsdtar exit 0 ／ python exit 0
1,100 文字のパス          bsdtar exit 0 ／ python exit 0
未知の vendor 鍵          bsdtar exit 0 ／ python exit 0
```

**「対応していない」を「壊れている」と言うのは嘘です。**

| | 意味 |
|---|---|
| `ARCHIVE_INVALID` | 矛盾・破損・曖昧、または accepted subset で展開できない |
| `ARCHIVE_UNSUPPORTED` | ふつうの tar なら展開できるが、**この道具が扱うと決めた範囲の外** |

**exit code は両方 2 のままで、`OK` にはなりません。**変わるのは受け手が読む理由だけです。

資源上限（entry 数・entry の大きさ・総量・パス長・圧縮入力の大きさ）も
`ARCHIVE_UNSUPPORTED` に寄せました。**上限は方針であって、archive の欠陥ではない**からです。
上限の値そのものは変えていません（監査も「上限維持でよい」と書いています）。

**ただし、切れている archive は上限より先に見ます。**
宣言した size のぶんの本体が入っていない archive は、上限と関係なく壊れています
（実測: bsdtar は `Truncated tar archive` で exit 1）。

## 7. **実測で裏の取れていない拒否が 12 件あります**

止めているもののうち、**手元の 2 実装がそろって通し、同じ木を作るもの**が 12 件あります。
`test/tarExtractionOracle.test.ts` の `INVALID_WITHOUT_LOCAL_EVIDENCE` に、
**理由つきで機械が読める形**にしてあります（件数もそこで固定しています）。

| 分類 | 件数 | 中身 |
|---|---:|---|
| `measured-elsewhere` | **10** | 監査の GNU tar 1.35 / BusyBox が拒むと報告。**こちらでは再現していない** |
| `spec` | 1 | 先頭の `+` は POSIX pax の書式に無い（`mtime=+1`。2 実装とも通す） |
| `portability` | 1 | `..\evil.txt`。Unix ではふつうの名前、**Windows では 1 階層上を指す** |

`measured-elsewhere` の 10 件は、名前の上書きが 2 つ効く形（2）・指す先の上書きが 2 つ効く形（2）・
PAX の値が数値でない形（4）・uid/gid が 32bit を超える形（2）です。

**この表は「まだ確かめていないこと」の一覧です。**
黙って増やせないようにしてあります——根拠のない拒否を足すと試験が落ち、
理由を書かないと通りません。

## 8. CI を **GNU tar と bsdtar の matrix**にしました（監査 P0-C）

v11 まで CI は ubuntu 1 本で、開発は macOS でした。
**つまり GNU tar と bsdtar が、同じ変更に対して同時に効いたことが一度もありません。**

```yaml
strategy:
  fail-fast: false
  matrix:
    os: [ubuntu-latest, macos-latest]
```

差分試験は PATH の `tar` を使うので、これがそのまま 2 実装の強制になります
（ubuntu では GNU tar、macOS では bsdtar）。実装と版は job のログに残します。

> **この matrix は、まだ一度も回っていません。**
> ubuntu 側で GNU tar が何を言うかは、こちらでは分かりません。
> **上の 7 の 10 件について、そこで初めて裏が取れます。**
> 通す材料のうち `uname` の NUL・`comment` の不正 UTF-8・`K` と `L` の併用は、
> GNU tar が拒む可能性があり、その場合は最初の run が赤くなります。
> **赤くなったら、それがこちらの見落としです。**そのまま直します。

## どの検査が効いているか（変異試験）

新しい検査を 1 つずつ外して、試験が落ちることを確かめました。
**「その検査が無ければ素通りする」形の変異**にしています。

| 外した検査 | `tarHardening` | 差分試験 |
|---|---:|---:|
| 祖先が非ディレクトリなら拒む（順方向） | 3 | 3 |
| すでに祖先として使われた名前を非ディレクトリで出さない（逆方向） | 2 | 2 |
| linkname の上書きが 2 つ効く形を拒む（PAX 側） | 2 | 1 |
| linkname の上書きが 2 つ効く形を拒む（GNU `K` 側） | 1 | 0 |
| 宙に浮いた linkname の上書きを拒む（archive 末尾） | 3 | 2 |
| global の `linkpath` を拒む | 1 | 0 |
| 指す先の末尾スラッシュを拒む | 2 | 1 |
| 指す先の綴りに entry と同じ規則を当てる | 1 | 0 |
| PAX の値の範囲を見る | 3 | 1 |
| `uname` / `gname` を厳密 UTF-8 で読む | 2 | 2 |
| base-256 の数値欄を「対応していない」と言う | 1 | 1 |
| 切れている archive を上限より先に見る | 1 | 0 |
| hardlink の連鎖を辿る（外すと**過剰拒否に戻る**） | 3 | 2 |
| 負の時刻を通す（外すと**過剰拒否に戻る**） | 2 | 2 |

**差分試験の列が 0 の 4 つは、手元の 2 実装では捕まりません。**
手元の実装が検算器と同じ答えを返す形だからで、
**oracle を増やさない限りこの列は 0 のままです。**（8 の matrix がそこに効くはずです）

## 塞ぎすぎていないこと

```
GitHub の実 tarball    v0.5.2 = 246 ファイル（entry 数まで実測で一致）
macOS tar が作ったもの   通る（生バイナリ xattr を含む・長いパスを含む）
HEAD の source          検算 32 件すべて一致
```

壊れた tar の corpus は **63 個 10 種類 → 99 個 11 種類**。
**「通す」材料を 15 個足しました**（hardlink の連鎖・別の綴り 3 種・負の時刻 2 種・
上限のすぐ内側・`uname` の NUL・`comment` の不正 UTF-8・`K` と `L` の併用・正当な木 3 種など）。
**過剰拒否は、止める材料しか無ければ corpus では見つかりません。**

## 変わらないこと

- **read-only** です。書き込み API を使わず、tar は展開せずメモリ上で読みます
- network は既定で使いません（`--fetch github` を明示したときだけ）
- モデルの数値は 1 つも動いていません。`profileId` も v0.6.6 のままです
  （この道具は配布物ですが**入力ではない**ので、digest を動かしません）
- 受け手向けの CLI 結果 schema は**まだ作っていません**。
  監査の draft（`source-verifier-cli-result.v1`）は受け取っています。
  `ARCHIVE_UNSUPPORTED` という語彙はこれで揃ったので、次はそこです

## 戻し方

この版の変更は検算ツールと試験だけです。`profileId`・区間・event・`verifiedPhysical` は動きません。

- **受け手側**: v0.6.6 の `verifyReleaseSourceInputs.mjs` をそのまま使い続けられます。
  出力の `toolVersion` で見分けてください。判定が変わるのは
  **上の 1〜6 に当たる archive を検算したときだけ**です。
- **`ARCHIVE_UNSUPPORTED` を知らない下流**: この status は v11 までの `ARCHIVE_INVALID` から
  分かれたものです。`status !== 'OK'` で分岐しているなら影響はありません。
  文字列で `ARCHIVE_INVALID` を見ている場合だけ、追加してください
  （**自己申告の schema には入れていません。**あちらの経路では出ないためです）。
