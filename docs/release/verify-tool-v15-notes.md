# 検算ツール `verifyReleaseSourceInputs.mjs` を v15 にしました（受け手向け）

対象: 配布物に同梱している `verifyReleaseSourceInputs.mjs`
出力の `toolVersion` が **14 → 15** になります。

v14（v0.6.9）の続きです。外部監査（2026-08-11）が **P0 2 件と P1 3 件**の反例を出しました。
**5 群すべてを、こちらで再現してから直しています。**

> **今回の監査パケットには checksum の控え（`.sha256`）が付いていませんでした。**
> 前回までは同梱されていたので、**パケット自体の完全性は照合していません。**
> 受け取った実物の digest は `ea3fe6c1…` です。
> 同梱の fixtures には控えがあり、そちらは `shasum -a 256 -c` が exit 0 でした。

## 手元で確かめられた範囲

開発機（macOS）は **bsdtar 3.5.3 / libarchive 3.7.4 と Python 3.14.6** の 2 実装。
CI は **ubuntu（GNU tar 1.35）と macOS** の matrix です。
**BusyBox は開発機にも CI にもありません。**

## 1. **長さ 0 の PAX 鍵が、鍵の分類を丸ごと迂回していました**（P0-A）

**これは v14 でこちらが開けた穴です。**

v14 で「長さ 0 の値を早く返す」ようにしたとき、`path`/`linkpath` と数値鍵しか
`out` へ入れなくなりました。ところが**その後ろの allowlist と
known-dangerous 検査は `out.keys()` しか見ません。**
つまり**値を空にするだけで、その 2 つを飛ばせました。**

実測（2026-08-11・同じ鍵で値の長さだけを変える）:

```
size=12            ARCHIVE_INVALID（見え方を変える鍵）
size=（長さ 0）      READ                    ← 素通り
SUN.holesdata=X    ARCHIVE_INVALID          ／ bsdtar も exit 1 で拒む
SUN.holesdata=     READ                    ← 素通り（bsdtar は拒むのに）
ACME.weird=X       ARCHIVE_UNSUPPORTED（未知の鍵）
ACME.weird=        READ                    ← 素通り
```

32 入力の source に混ぜると **`status OK / 32 of 32`** になりました。

**分類は値の長さで変わりません。**先に鍵で分類し、そのあとで値の長さを見ます。

## 2. **終端 zero block のあとを、一度も見ていませんでした**（P0-B）

```
32 入力の source + zero block 1 個 + root/src/model/sneaky.ts
  検算 v14  status OK ／ 32 of 32 ／ 未記録候補 0 件
  実ファイル 中に sneaky.ts は入っている（offset を数えて確認）
```

**手元の 2 実装も sneaky.ts を作りません**（どちらも最初の zero block で読むのをやめる）。
**つまり「実装が割れる」ことは、こちらでは再現できていません。**
監査は BusyBox が読むと報告していますが、**BusyBox はこちらにありません。**

それでも塞いだのは、この道具の約束が「**ここに挙げた物が中身の全部**」だからです。
読み手の一つが読めるものが一覧に無い時点で、その約束は果たせません。

終端の印は zero block **2 個**です。1 個で切って中身が続く形は archive 側の欠陥として止めます。
**過剰拒否になっていないことは実物で確かめました**——npm の実 tarball **600 本すべてが
「終端 zero 2 個・その後ろの非 zero 0 件」**、`git archive` と macOS の `tar` も同じでした。

## 3. **こちらの過剰拒否が 3 件**（P1）

```
正当な old GNU sparse   typeflag S・345..499 は sparse map。2 実装とも読めるのに
                        「壊れている」と言っていた（型より先に形式を見ていた）
mtime=1.                小数点のあとに数字が無い形。2 実装とも受理するのに拒んでいた
冪等な directory の重複  同じ root/dir/ を 2 回。2 実装とも同じ木を作るのに拒んでいた
```

sparse は「壊れている」ではなく「**こちらが扱わない**」ので `ARCHIVE_UNSUPPORTED` です。
directory は中身を持たないので「どちらが本物か」という問いが立ちません——
**通常ファイルの重複は今までどおり止めます。**

## 4. 止めた理由に、すべて名前が付きました

止め方 65 か所すべてに `stableReasonCode` を付け、
**corpus の材料が `*_OTHER` を返したら試験が落ちる**ようにしました
（いま止まる材料は 105 件、`*_OTHER` は 0 件）。

監査の family 名に加えて、こちらの判断で
`END_OF_ARCHIVE_LONE_ZERO_BLOCK` / `PAX_KEY_DANGEROUS` / `PAX_KEY_UNSUPPORTED` /
`PAX_ZERO_LENGTH_VALUE_INVALID` / `DUPLICATE_PATH_CONFLICT` などを使っています。

## 5. **止める理由のうち、根拠が無いものが増えました（2 → 8 件）**

```
GNU tar 側でだけ根拠が取れる   12 件（v0.6.9 は 11 件）
bsdtar 側でだけ根拠が取れる     9 件
どちらでも取れていない          8 件（v0.6.9 は 2 件）
```

**増えた 6 件は、新しく直した箇所ではありません。**
材料を足したときに、**この試験自身が「前から根拠なく止めていたもの」を炙り出しました。**

```
zero-hdrcharset / nonzero-size        「見え方を変える鍵は解釈しない」という方針
eoa-lone-zero-then-member / -junk      手元の 2 実装も読まないので割れない（BusyBox 依拠）
dup-regular-same/different-content     v0.6.1 からの方針（どちらを検算したか言えなくなる）
```

**「実装が割れているから止めた」と書けないものは、そう書きます。**
方針で止めているなら方針だと言うほうが、受け手には正確です。

## 塞ぎすぎていないこと

```
GitHub の実 tarball（v0.6.7）   entry 330
git archive HEAD                entry 331
macOS tar が作ったもの           通る
npm の実 tarball 600 本          51,802 entry・終端 zero 2 個・その後ろの非 zero 0 件
監査の normal.tar（32 入力）      status OK / 32 of 32
```

壊れた tar の corpus は **146 個 13 種類 → 170 個 16 種類**、
うち「通す」材料が **49 → 59 件**です。

## 変わらないこと

- **read-only** です。書き込み API を使わず、tar は展開せずメモリ上で読みます
- モデルの数値は 1 つも動いていません。`profileId` も v0.6.9 のままです
- 受け手向けの `source-verifier-cli-result.v1` schema（監査 §5）は**まだ作っていません**

## 戻し方

変更は検算ツールと試験だけです。`profileId`・区間・event・`verifiedPhysical` は動きません。
受け手は v14 の道具を使い続けられます（出力の `toolVersion` で見分けられます）。
判定が変わるのは、**上の 1〜3 に当たる archive を検算したときだけ**です。
