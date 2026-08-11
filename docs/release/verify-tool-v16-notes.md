# 検算ツール `verifyReleaseSourceInputs.mjs` を v16 にしました（受け手向け）

対象: 配布物に同梱している `verifyReleaseSourceInputs.mjs`
出力の `toolVersion` が **15 → 16** になります。

v15（v0.6.10）の続きです。外部監査（2026-08-11）が **P0 3 件と P1 3 件**の反例を出しました。
**6 群すべてを、こちらで再現してから直しています。**
**加えて 2 件、こちらで見つけて塞ぎました。**

> **今回も監査パケットに checksum の控え（`.sha256`）が付いていませんでした。**
> **パケット自体の完全性は照合していません**（受け取った実物の digest は `10c22d3f…`）。
> 同梱 fixtures の控えは在り、そちらは `shasum -a 256 -c` が exit 0 でした。

## **⚠ 判定の意味が変わります**

**`OK` は「必須の工程が全部終わった」ときだけになりました。**

v15 まで、`status` は**不一致が無いこと**しか見ていませんでした。
そのため、**記録漏れの探索をしていなくても `OK`** になりました。
受け手には「探して見つからなかった」と読めます。**やらなかったことは、合格ではありません。**

```
できていない工程がある  → VERIFICATION_INCOMPLETE（exit 1）
```

**v0.3.0 より前の tag を検算すると、これに当たります。**その tag には範囲定義が無く、
manifest も範囲を記録していないので、記録漏れの探索ができません。
sha256 の突き合わせは今までどおり実施していて、**そちらの結果は有効**です。

## 1. **範囲定義が manifest に縛られていませんでした**（P0-A）

`--scope` を**中身も確かめずに**受け取っていました。実測（2026-08-11）:

```
--scope /nonexistent/s.json     status OK / exit 0（探索していないのに）
src/model を除いた scope        status OK / 未記録候補 0 件
```

manifest は `inputScope.sha256` を持っているのに、**照合していませんでした。**
**範囲を差し替えられるなら、「範囲の中に記録漏れは無い」は何も言っていません。**

v16 は記録された sha256 と**完全一致**したときだけその範囲を信じます。
古い tag のために `--allow-unpinned-scope` を用意しましたが、
**それでも `OK` にはなりません**（縛られていない範囲では言えないため）。

## 2. **名前が空の member を黙って捨てていました**（P0-B）

```
生ヘッダの名前が空 ／ GNU L の中身が長さ 0
  検算 v15  status OK / 32 of 32（その member は一覧に出ない）
  bsdtar    Archive entry has empty or unreadable filename ... skipping
  python    IsADirectoryError（空の名前を展開先そのものとして開く）
```

**飛ばした member は「無かったもの」になります。**
どこで空になったかで名前を分けました（`PATH_EMPTY_NAME` / `EXTENSION_NAME_EMPTY`）。

## 3. **directory を渡したとき、特殊なノードが一覧から消えていました**（P0-C）

範囲の中に `src/model/sneaky.fifo` を置くと、
検算 v15 は `status OK / 探索 performed:true / 候補 0 件`——
**探したと言いながら、その名前は出力に一度も出てきませんでした。**

v16 は FIFO・socket・device を `ARCHIVE_UNSUPPORTED` で止め、**名前を出します。**

## 4. **切れている archive を 2 形、受理していました（こちらで見つけました）**

```
本体の詰め物が欠けている        検算 v15 OK 32/32 ／ bsdtar `Truncated input file`・python `ReadError`
終端の印を見ないまま尽きる      検算 v15 READ    ／ bsdtar `Truncated tar archive`（python は通す）
```

`ENTRY_BODY_TRUNCATED` / `END_OF_ARCHIVE_MISSING` で止めます。
**終端のあとの端数は別の話**で、2 実装とも読み飛ばすので受理したままです。

## 5. **こちらの過剰拒否が 1 件**（P1-A）

`x` が来ただけで「名前の上書きが 2 つ」と落としていたので、
**`mtime` しか持たない PAX が GNU `L` のあとに来る正当な形**まで拒んでいました。
実測: bsdtar も python も同じ長い名前を作ります。
**`path` を持たない PAX は名前に触らない**ので、待っている `L` と共存できます。

## 6. status と reason code

`status` の一覧を**道具側の定数**（`CLI_STATUSES`・8 種類）にしました。
v15 まで試験はこれを**ソースの正規表現から拾って**おり、
書き方を変えただけで拾えなくなって**空振り**していました。

ディレクトリ側の資源上限を `ARCHIVE_UNSUPPORTED` へそろえ（archive 側と同じ扱い）、
gzip の失敗に `GZIP_DECODE_FAILED` を付けました。
**corpus で止まる材料 110 件・`*_OTHER` は 0 件**です。

止める理由が、どちらの実装で裏を取れるか:

```
GNU tar 側でだけ根拠が取れる   15 件
bsdtar 側でだけ根拠が取れる    11 件（v0.6.10 は 9 件）
どちらでも取れていない          5 件
```

増えた 2 件は今回の新しい材料で、**どちらも切れ方に関するもの**です
（名前が空・終端の印が無い）。**bsdtar は exit 1 で拒み、GNU tar と python は通します**
——**切れていることに気づくのは 3 実装のうち 1 つだけ**でした。
これは CI の ubuntu 側が落として分かりました。

## 塞ぎすぎていないこと

```
作業ツリー（正しい source）      status OK / 32 of 32 / boundTo: manifest.inputScope.sha256
終端のあとに端数がある archive   通る（2 実装とも読み飛ばす）
GNU L + metadata だけの PAX      通る（長い名前で）
```

壊れた tar の corpus は **170 個 16 種類 → 182 個 19 種類**、
うち「通す」材料が **59 → 66 件**です。

## 変わらないこと

- **read-only** です。書き込み API を使わず、tar は展開せずメモリ上で読みます
- モデルの数値は 1 つも動いていません。`profileId` も v0.6.10 のままです
- **既存の schema 22 本は 1 行も動いていません**（新設が 1 本増えるだけ）

## 7. **受け手向けの契約を新設しました**（監査 §7）

`schemas/source-verifier-cli-result.v1.schema.json` を足しました（**schema は 22 → 23 本**）。

v15 まで、受け手はこの出力を読むのに
`source-verification-result.v1`（**こちらが回した記録**）の説明を使うしかありませんでした。
その 2 つは**出る status が違います**——記録側は作業ツリーを読む経路なので
`ARCHIVE_INVALID` も `ARCHIVE_UNSUPPORTED` も `VERIFICATION_INCOMPLETE` も出ません。
**記録側の enum を CLI の一覧として読むと取りこぼします。**

出力に `schemaId` / `exitCode` / `stableReasonCode` / `archivePolicy` /
`incompletePhases` / `rootTransform` を入れました。
`archivePolicy` は**この道具が何を通すか**（受け入れる形式・typeflag・終端の約束・上限）で、
受け手が機械で読めます。

> **監査の草案には `INTERNAL_ERROR` がありますが、入れていません。**
> この道具は出さないので、書くと「出うる」と嘘になります。
> 草案どおりに書くほうが楽ですが、**受け手は来ない分岐を実装することになります。**

**既存の 22 本は 1 行も動いていません**（`v0.6.10` tag との byte 差分 0 行）。
新設は別 id なので、**下流はどこでも止まりません**（判定器の記録も `BUMP 0`）。

契約は手で確かめていません——**status ごとに実際に道具を走らせて、
出てきた JSON を ajv へ通しています**（8 経路すべて）。

## 戻し方

変更は検算ツールと試験だけです。`profileId`・区間・event・`verifiedPhysical` は動きません。
受け手は v15 の道具を使い続けられます（出力の `toolVersion` で見分けられます）。
**ただし v16 は `OK` の意味を狭めています**——古い tag で `OK` を期待している自動処理があれば、
`VERIFICATION_INCOMPLETE` を受け取ることになります。
