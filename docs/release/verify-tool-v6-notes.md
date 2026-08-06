# 検算ツール `verifyReleaseSourceInputs.mjs` を v6 にしました（受け手向け）

> この文書の HTML 版（同名 `.html`）は `npm run docs:html` で生成しています。**HTML を直接編集しないでください。**

対象: 配布物に同梱している `verifyReleaseSourceInputs.mjs`
出力の `toolVersion` が **5 → 6** になります。

v5（v0.6.0）の続きです。**v5 で塞いだつもりだった穴が 3 つ残っていました。**
外部監査（2026-08-06）が反例を出し、**こちらで再現してから**直しています。

## 何が変わるか

### 1. 同じパスの entry が 2 回あると止まります

v5 は `Map` へ入れるだけだったので、**後の entry が黙って勝ちました。**

```
root/dup.txt = FIRST
root/dup.txt = SECOND
   ↓ v5
dup.txt = SECOND      エラーなし
```

受け手は manifest のパスでこの表を引きます。つまり
**checksum を通った最初の中身とは別の中身を「source にあった」と読む**ことになります。

v6 は `ARCHIVE_INVALID` で止まります。**中身が同一でも拒みます**——
同じものを 2 回入れる正当な理由が無く、「同一なら許す」にすると判断が 1 つ増えるためです。

### 2. ディレクトリ入力の symlink ループで、構造化 JSON を返します

`--source <ディレクトリ>` に `loop -> .` が 1 本あるだけで、v5 は**生のスタックトレースを吐いて落ちました。**

```
v5   exit 1 / stdout 0 行 / stderr に ELOOP のスタック
v6   exit 1 / stdout に JSON（symlink は読み飛ばした旨を origin に残す）
```

**出力が JSON でないと、「合わなかった」と「道具が落ちた」を受け手が区別できません。**

symlink は `lstat` で見て**追わずに読み飛ばします。**archive 側（typeflag `1` / `2`）と同じ扱いで、
中身が無いのに「source にあった」ことにしないためでもあります。

### 3. 圧縮された入力そのものに上限を置きました

v5 は展開後（`maxTotalBytes` 256 MB）にしか上限がなく、
**入力を全部メモリへ載せてから**判定していました。

| 入力 | v5 の最大 RSS | v6 |
|---|---:|---:|
| 120 MB | 165.0 MB | **43.6 MB**（読む前に止まる） |
| 1 MB | 45.0 MB | 変わらず |

`maxCompressedBytes` は **64 MB**です。実物の source tarball 9.76 MB の約 6.5 倍で、
**正常な archive が弾かれることはありません**（v0.5.2 の実物で確認済み）。

- ローカルファイルは `stat` で先に大きさを見ます
- network は `Content-Length` を**補助として**見たうえで、**受け取りながら**上限で打ち切ります
  （`arrayBuffer()` は読み終えてからしか返さないので使いません）

## 塞ぎすぎていないこと

同じテストで確かめています（`test/tarHardening.test.ts`）。

- 26 個・6 種類の壊れた tar は v5 と同じ結末
- 正常な tar・gzip・**実物の GitHub tarball（v0.5.2・246 ファイル）**は今までどおり読める
- 重複していない tar、ループの無いディレクトリは何も変わらない

## `ARCHIVE_INVALID` と schema の話（**まだ残っています**）

道具は v5 から `ARCHIVE_INVALID` を出しますが、
同梱の `source-verification-result.v1.schema.json` の `status` enum には**入っていません。**

```
道具が出す   OK / MISMATCH / SOURCE_UNAVAILABLE / MANIFEST_UNAVAILABLE / NOTHING_TO_VERIFY / ARCHIVE_INVALID
v1 が受ける  OK / MISMATCH / SOURCE_UNAVAILABLE / MANIFEST_UNAVAILABLE / NOTHING_TO_VERIFY
```

**enum へ足すと受理する文書が増えて言語が広がるので v2 になり、下流の lock が止まります。**
v0.6.1 では版を上げず、次の 3 つだけ入れました。

1. schema 自身が「この v1 では `ARCHIVE_INVALID` を表現できない」と名指しで書く
2. こちらの生成器が、表現できない status を**近い値へ丸めずに止まる**
3. ずれが `ARCHIVE_INVALID` 1 個だけであることをテストで固定（7 個目が増えたら落ちる）

**受け手が道具を直接回したときの stdout は、この schema の対象ではありません。**
`ARCHIVE_INVALID` はそのまま出ます（`exitCode` は 2）。
`status` を allowlist で持っている場合は、**`ARCHIVE_INVALID` を
`SOURCE_UNAVAILABLE` とも `MISMATCH` とも別のものとして**足してください。

- `SOURCE_UNAVAILABLE` … 取れなかった。**検証していない**
- `ARCHIVE_INVALID` … 取れたが archive が壊れているか敵対的。**中身を信用しない**
- `MISMATCH` … 読めたが記録と合わない

## 変わらないこと

- **read-only** です。書き込み API を使わず、tar は展開せずメモリ上で読みます
- network は既定で使いません（`--fetch github` を明示したときだけ）
- 判定の意味（`OK` / `MISMATCH` / 3 種類の「検証していない」）は v5 と同じです
