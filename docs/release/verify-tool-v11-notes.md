# 検算ツール `verifyReleaseSourceInputs.mjs` を v11 にしました（受け手向け）

対象: 配布物に同梱している `verifyReleaseSourceInputs.mjs`
出力の `toolVersion` が **10 → 11** になります。

v10（v0.6.5）の続きです。外部監査（2026-08-08）が **P0 3 件と P1** の反例を出しました。

> **今回の監査パケットは checksum が合いました**（前回は合いませんでした）。

## 手元で確かめられた範囲

GNU tar と BusyBox はこの環境にありません。**bsdtar 3.5.3 と Python 3.14 の 2 実装**で測りました。
監査は GNU tar 1.35 / BusyBox / libarchive / python の 4 実装で測っています。

**このため、指摘のうち 2 件は手元では再現できていません。**下の「4」に分けて書きます。

## 1. 自分自身を指す hardlink を受理していた（手元で再現）

```
root/self -> root/self
  検算 v10  status OK / 32 件中 32 件一致 / 未記録 0
  bsdtar    exit 1 — Skipping hardlink pointing to itself
  python    KeyError: linkname 'root/self' not found
  （監査側の GNU tar は exit 2）
```

原因は **この entry の名前を先に `seenPaths` へ入れていた**ことです。
自分を指すリンクが「指す先が在る」と判定されていました。

## 2. ディレクトリを指す hardlink を受理していた（手元で再現）

```
root/hdir -> root（ディレクトリ）
  検算 v10  status OK
  bsdtar    exit 1 — Can't create 'root/hdir': Operation not permitted
  （監査側の GNU tar は exit 2、BusyBox は exit 1）
```

v10 は「名前が在るか」しか見ていませんでした。**hardlink は通常ファイルにしか張れません。**
v11 は指す先の型まで見ます。

## 3. **v10 は、正当な archive を拒んでいました**（手元で再現）

**2 回続けて、こちらの過剰拒否が見つかりました。**

```
GNU の長い linkname（K ヘッダ）
  検算 v10  ARCHIVE_INVALID — 「. を含む entry がある」
  bsdtar    exit 0（展開できる）
  python    exit 0（展開できる）
  （監査側の GNU tar・BusyBox も exit 0）

PAX の linkpath
  検算 v10  ARCHIVE_INVALID — 「受け入れていない鍵がある: linkpath」
  4 実装すべて exit 0
```

`K` は**分岐そのものが無く**、`K` ヘッダ自身の名前 `././@LongLink` が
正規化検査に当たって落ちていました。`linkpath` は allowlist に入れ忘れです。

v11 は**どちらも解釈します。**リンクの指す先は `files` に入らないので view は変わりませんが、
**hardlink の指す先の検査には使います**（`linkpath` で存在しない先へ上書きする形は止まります）。

## 4. 手元では再現できなかった 2 件（構造の理屈で直しました）

**この 2 件は、こちらの 2 実装が検算器と同じ答えを返します。**
監査は GNU tar が拒むと報告していますが、**こちらでは確かめられていません。**

```
PAX の値が読めない（uid=abc / mtime=abc / atime=nan / ctime=1e999）
  検算 v10  status OK
  bsdtar    exit 0     python  exit 0        ← 手元の 2 実装は通す
  （監査側の GNU tar は exit 2 — Malformed extended header）

中身を持てない型に本体がある（type 5 で size≠0）
  検算 v10  status OK
  bsdtar    exit 0     python  exit 0        ← 手元の 2 実装は通す
  （監査側の GNU tar は exit 2、BusyBox は exit 1、libarchive は exit 1）
```

**それでも直したのは、構造として理屈が立つからです。**

- 値が読めない PAX は、**「view を変えない鍵だから通す」という v10 の理屈が崩れます。**
  その理屈は値が読める前提に乗っていて、読めなければ読み手の挙動は決まりません。
- 中身を持てない型に本体があると、**読み手がその本体を読み飛ばすかどうかで、
  その先の解釈が丸ごとずれます。**1 個の entry の問題では済みません。

どちらも正当な source archive には出てこない形なので、拒んでも実物は通ります（下の「塞ぎすぎ」）。

**「監査がそう言ったから直した」ではありません。**手元で確かめられなかったことは、
そのままここに書いてあります。

## 意図して受け入れていない形（監査の P1・そのままにしたもの）

```
9 MB を超える単一 entry     ARCHIVE_INVALID（4 実装は通す）
  → 資源上限。実物の最大 entry は 1.27 MB で、上限 8 MB の 16%。
    上限を外すと、細工した archive でメモリを使い切られる側が緩くなる。

scope 配下の正当な hardlink   MISMATCH（4 実装は通す）
  → 未記録入力として報告する。scope の下に、記録されていないパスが増えるため。
    v0.6.4 で塞いだ穴（展開されるのに数えない entry）と同じ理由で、これは意図した挙動。
```

**どちらも「壊れている」とは言っていません。**`ARCHIVE_INVALID` / `MISMATCH` の理由文に
何が起きたかが書いてあります。

## 塞ぎすぎていないこと

```
GitHub の実 tarball    v0.5.2 = 246 ／ v0.6.2 = 284 ／ v0.6.4 = 293 ファイル
HEAD の source          299 ファイル
macOS tar が作ったもの   通る（生バイナリ xattr を含む・長いパスを含む）
```

壊れた tar の corpus は **50 個 9 種類 → 63 個 10 種類**。
**「通す」材料を 3 つ足しました**（`K` の長い linkname・PAX `linkpath`・size 0 のディレクトリ）。

## どの検査が効いているか（変異試験）

| 外した検査 | `tarHardening` | 差分試験 |
|---|---:|---:|
| 自分自身を指す hardlink を拒む | 1 | 0 |
| 指す先が通常ファイルかを見る | 2 | 1 |
| PAX の値の文法を見る | 4 | 0 |
| 中身を持てない型の本体を拒む | 3 | 1 |

**上 2 つと 3 つ目は、差分試験では捕まりません。**
手元の 2 実装が検算器と同じ答えを返す形だからで、
**oracle を増やさない限り、この列は 0 のままです。**

## 変わらないこと

- **read-only** です。書き込み API を使わず、tar は展開せずメモリ上で読みます
- network は既定で使いません（`--fetch github` を明示したときだけ）
- `status` の種類は増えていません。受け手向けの CLI 結果 schema は**まだ作っていません**
- **oracle は 2 実装のまま**です。GNU tar・BusyBox は入っていません
