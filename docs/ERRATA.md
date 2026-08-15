# 正誤表

**公開した release 本文は編集しない。**編集すると、受け手が読んだ文と手元の控えがずれ、
しかも本文のほうが黙って書き換わるので、「いつ何が直ったか」が誰にも分からなくなる。
代わりに、**公開後に見つかった誤りをここへ積む。**

各項目には、**誤りに気づいた方法**と**実測の手順**を書く。
読んだ人が同じ結果を再現できないなら、訂正になっていない。

---

## v0.6.11（2026-08-12 記載）

### 1. **`VERIFICATION_INCOMPLETE` になる tag の範囲が違う**

| | |
|---|---|
| 誤 | 「**v0.3.0 より前の tag** を検算すると、これに当たります」 |
| 正 | 「**v0.4.0 より前の tag** を検算すると、これに当たります」 |
| 場所 | release notes 冒頭「⚠ 先に読むところ」の 1 番目 ／ `verify-tool-v16-notes.md` の同じ節 |

**`v0.3.0` 自身も対象**である。範囲定義（`manifest.inputScope`）が入ったのは **v0.4.0** から。

```
tag ごとに、その tag の source に対して同梱の検算ツール（toolVersion 16）を回した結果
  v0.1.0 / v0.1.1   manifest 自体が無い（MANIFEST_UNAVAILABLE）
  v0.2.0            VERIFICATION_INCOMPLETE   incompletePhases=["unrecorded-input-detection"]
  v0.3.0            VERIFICATION_INCOMPLETE   同上
  v0.4.0            OK                        incompletePhases=[]
  v0.4.1            OK
```

再現手順（21 tag すべてで回せる）:

```sh
T=$(mktemp -d); git archive v0.3.0 | tar -x -C "$T"
node scripts/verifyReleaseSourceInputs.mjs \
  --manifest "$T/artifacts/source-input-manifest.json" --source "$T"
# → status=VERIFICATION_INCOMPLETE / exit 1
```

**なぜ間違えたか。** 境界を実際に走らせずに書いた。`inputScope` を足した版を思い違いしていた。
**「より前」と書く前に、その版そのものを踏むこと。**

> tag ごとの `inputScope` の有無を数えるときは、`"$t:artifacts/..."` と書かないこと。
> zsh は `$t:a` をパス修飾子として解釈するので、**全 tag が同じように「無い」と出る。**
> `${t}:artifacts/...` と書く。これで一度、誤った結論を出しかけた。

### 2. **「通す材料 66 件」は誰も検査していない旗の数だった**

| | |
|---|---|
| 誤 | 「うち『通す』材料が 59 → **66 件**」 |
| 正 | 実際に通る材料は **72 件** |
| 場所 | release notes 「塞ぎすぎていないこと」節 ／ `verify-tool-v16-notes.md` の同じ節 |

corpus が**同じ境界を 2 つの一覧**で持っていた。材料ごとの `ok` 旗と、期待値表である。
**検査されていたのは期待値表だけ**で、旗は 1 か所から `!ok` としてしか読まれておらず、
**`ok: true` が本当に通ることは一度も確かめられていなかった。**両者は 10 件でずれていた。

v0.6.12 で旗を消し、判定を `test/_tarExpectations.mjs` の期待値表へ一本化した。
数は試験が固定する（`通る材料は 72 件`）。

### 3. **同梱 artifact が status を 5 種類と書いていた**

| | |
|---|---|
| 誤 | 配布物 `source-verification-result.json` の `howToVerifyYourself`: 「status は OK(0) / MISMATCH(1) / SOURCE_UNAVAILABLE(2) / MANIFEST_UNAVAILABLE(2) / NOTHING_TO_VERIFY(2)」 |
| 正 | 同梱ツールは **8 種類**返す。`VERIFICATION_INCOMPLETE(1)` / `ARCHIVE_INVALID(2)` / `ARCHIVE_UNSUPPORTED(2)` が抜けていた |
| 場所 | **配布物そのもの**（release notes ではない） |

**これは文書の誤りではなく、配布物の誤りである。**
足りない 3 つは v0.6.10 と v0.6.11 で足したもので、
とくに `VERIFICATION_INCOMPLETE` は **v0.6.11 の目玉**なのに受け手に伝わっていなかった。

**v0.6.11 の配布物を使う場合は、この行を読まないこと。**
`verifyReleaseSourceInputs.mjs` が返す値が正しく、`schemas/source-verifier-cli-result.v1.schema.json`
の `status.enum`（8 種類・同じ配布物に入っている）がその正本である。

v0.6.12 で、この行は道具の定数から生成するようにした。

---

## v0.6.12 以前（2026-08-12 記載・**v0.6.13 で直しました**）

### 4. **検算ツールを別名で走らせると、何も出さずに `exit 0` で終わる**

| | |
|---|---|
| 対象 | v0.6.12 までに配布した `verifyReleaseSourceInputs.mjs` **全部** |
| 症状 | コピーの名前を変える／symlink を張ると、**検算せずに終了コード 0** を返す |
| 影響 | **終了コードだけを見る受け手には、合格と区別が付かない** |
| 直した版 | v0.6.13 |

原因は入口の判定がファイル名の正規表現（`/verifyReleaseSourceInputs\.mjs$/`）だったこと。

```
実測（2026-08-12・v0.6.12 の道具）
  verifyReleaseSourceInputs.mjs   exit 0 / 出力 4,318 バイト
  renamed.mjs                     exit 0 / 出力     0 バイト
  link.mjs（symlink）             exit 0 / 出力     0 バイト
```

再現手順:

```sh
cp verifyReleaseSourceInputs.mjs renamed.mjs
node renamed.mjs --manifest source-input-manifest.json --source <展開した source>
echo "exit=$?"   # → exit=0 だが、標準出力は空
```

**同梱の手順どおり（名前を変えずに）回していれば起きません。**
黙る経路は JSON を 1 バイトも出さないので、**出力を読んでいたなら気づけています。**

**`toolVersion` は上げていません**（16 のまま）。判定は変わらず、
黙る経路は `toolVersion` を出さないので、受け手が「16 なのに挙動が違う」に出会う場面がないためです。
**v0.6.12 と v0.6.13 の道具は版数では見分けられません**——`tool.sha256` で見てください。

**気づいた経緯**: v0.6.12 の release 準備中に、新旧の道具の出力を比べようとして
旧版を別名でコピーしたところ、**旧版が黙って何も出さず**、それを一度「判定が変わった」と読みかけた。
**道具が落ちているときと、根拠が無いときは出力が同じに見える。**

---

## v0.6.13 以前（2026-08-12 記載・**v0.6.14 で直しました**）

### 5. **`stableReasonCode` が公開 CLI の全経路を覆っていなかった**

| | |
|---|---|
| 対象 | v0.6.13 までに配布した `verifyReleaseSourceInputs.mjs` **全部** |
| 症状 | gzip の失敗・source root が symlink・圧縮サイズ上限で `ARCHIVE_INVALID_OTHER`（または code 無し） |
| 影響 | **受け手が機械で分岐できない。**`stableReasonCode` は公開契約として schema に載っている |
| 直した版 | v0.6.14 |

**外部監査（2026-08-12）の指摘を、こちらで再現しました。**

```
壊れた gzip             ARCHIVE_INVALID / ARCHIVE_INVALID_OTHER
source root が symlink  ARCHIVE_INVALID / ARCHIVE_INVALID_OTHER
圧縮サイズ上限           code 無し
```

**さらに、こちらが公開した文書が虚偽でした。**

```
verify-tool-v16-notes.md:「gzip の失敗に GZIP_DECODE_FAILED を付けました」
実測: その名前は source 全体で 1 件、しかも**コメントの中だけ**（実装されていない）
```

**「corpus で止まる材料 110 件・`*_OTHER` は 0 件」は真でしたが、
それは corpus が踏んだ経路についてだけです。**走らせて集めた実測では、
catalog の 55 種類のうち **corpus が踏むのは 37 種類**でした。

v0.6.14 で catalog（配布物 1 ファイルに同梱）を正本にし、
**catalog に無い名前・status の食い違いは、その場で例外**にしました。

### 6. **配布ソースの冒頭に、5 種類だけの status 一覧が残っていた**

| | |
|---|---|
| 対象 | v0.6.13 までの `verifyReleaseSourceInputs.mjs` の冒頭コメント（28〜32 行） |
| 症状 | 道具は 8 種類を返すのに、ソースを読む受け手には 5 種類と見える |
| 直した版 | v0.6.14（**一覧そのものを消し、`CLI_STATUS_META` を正本にした**） |

**v0.6.12 で artifact の手順書を直したときに、配布ソース側の同じ一覧を見落としました。**

### 7. **配布 schema が「v0.3.0 より前」と書いていた**

| | |
|---|---|
| 対象 | v0.6.13 までの `schemas/source-verifier-cli-result.v1.schema.json` |
| 症状 | `status.description` の歴史の境界が誤り（正しくは **v0.4.0 より前・v0.3.0 自身も対象**） |
| 直した版 | v0.6.14 |

**この正誤表の §1 で v0.6.11 の notes を訂正したのに、
同じ誤りが配布 schema に残っていました。**——同じ境界を 2 か所で持ち、片方だけ直した形です。

### **`toolVersion` を 17 へ上げました**

v0.6.13 では 16 に据え置きました。**入口の変更だけなら判定は変わらない**（正規の名前での出力が
byte 一致）ためで、その判断自体は今も誤りだと思っていません。

**v0.6.14 は判定の出力そのものが変わります**——`ARCHIVE_INVALID_OTHER` だったものが
`GZIP_DECODE_FAILED` などになります。**受け手が機械で分岐する値が変わる**ので、
版上げ規則（「判定の意味を変えたら上げる」）にそのまま当たります。

> v0.6.12 と v0.6.13 の道具は、**どちらも `toolVersion` 16 を名乗ります。**
> その 2 つを見分けるには `tool.sha256` を使ってください。

---

## v0.6.14 以前（2026-08-14 記載・**v0.6.15 で直しました**）

### 8. **配布ソースに、2 つ目の status 一覧がまだ残っていた**

| | |
|---|---|
| 対象 | v0.6.14 の `verifyReleaseSourceInputs.mjs`（`CLI_STATUS_META` の 12 行上） |
| 症状 | 手書きの 8 status 一覧。**「同じ境界は 1 か所で持つ」と書いた同じコメント塊の中にあった** |
| 直した版 | v0.6.15（一覧を消し、意味は `CLI_STATUS_META` の `summary` へ畳んだ） |

**v0.6.14 の notes と作業指示で「一覧そのものを消しました」と書きましたが、消したのは
冒頭 28〜32 行の 5 種類版だけでした。**正本のすぐ上にある 8 種類版を見落としています。

```
変異対照（2026-08-14）
  コメントから VERIFICATION_INCOMPLETE の行を消す → 新たに落ちた試験 **0 件**
  SECURITY.md の版数を v0.9.9 に書き換える        → **1236 件すべて緑**
```

**文言は 1 か所も検査されていませんでした。**v0.6.15 で
`test/staleWordingAndPaths.test.ts` を置き、live なファイルの禁止語句と
**文中で指したパスの実在**を検査します（免除する記録はパスで名指しし、
**その記録がいまもその語句を含むか**も確かめます）。

### 9. **受け手向けのエラー文が、存在しないファイルを指していた**

| | |
|---|---|
| 対象 | v0.6.14 の `verifyReleaseSourceInputs.mjs`（2 か所） |
| 症状 | 「`scripts/reasonCodes.mjs` に登録すること」と言うが、**そのファイルは同じ版で消してある** |
| 直した版 | v0.6.15 |

catalog を単一ファイル配布の制約のため本体へ移したときに、**案内の文だけ古いまま**でした。

### 10. **catalog に載せた止め方のうち 2 つが、一度も出なかった**

| | |
|---|---|
| 対象 | v0.6.14 の `SOURCE_SPECIAL_NODE` / `SOURCE_DIRECTORY_UNREADABLE` |
| 症状 | 名前は在るが実装は別の code を返す。**受け手は来ない分岐を実装することになる** |
| 直した版 | v0.6.15 |

**外部監査（2026-08-12）の指摘を、こちらで再現しました。**

```
実測 2026-08-14（v0.6.14 の道具）
  FIFO を置いた directory   → ENTRY_TYPE_UNSUPPORTED（SOURCE_SPECIAL_NODE は出ない）
  読めない directory        → SOURCE_UNAVAILABLE / SOURCE_UNAVAILABLE_OTHER
```

再現手順:

```sh
D=$(mktemp -d); mkfifo "$D/pipe"
node scripts/verifyReleaseSourceInputs.mjs --manifest artifacts/source-input-manifest.json --source "$D"
```

v0.6.15 で `SOURCE_SPECIAL_NODE` を実際に配線し、
`SOURCE_DIRECTORY_UNREADABLE` の status を `SOURCE_UNAVAILABLE` へ直しました。
あわせて catalog へ `reachability` を足し、**宣言と実測を両方向で照合**します
——到達すると宣言した code は出ること、しないと宣言した code は出ないこと。

**このとき、こちらでもう 1 件見つけました。**`SOURCE_ARCHIVE_MISSING`（v0.6.15 で新設）は
到達しません——存在しない path は、先に directory の判定が `SOURCE_DIRECTORY_MISSING` で止めます。
`loadFromArchive` の存在検査は死んでいます。**`defensive-invariant` として宣言しました。**

### 11. **`archivePolicy` は、形すら検査されていなかった**

| | |
|---|---|
| 対象 | v0.6.14 までの `schemas/source-verifier-cli-result.v1.schema.json` |
| 症状 | 覆っている範囲の一覧を消しても、偽値に差し替えても、**schema に適合した** |
| 直した版 | v0.6.15 |

**外部監査の反例 7 件を、自分の道具の実出力と自分の ajv で再現しました（2026-08-14）。**

```
                                        v0.6.14    v0.6.15
notMachineReadableHere / families を消す   適合    → 落ちる
中身を ['TOTALLY_FAKE'] に差し替える        適合    → 落ちる
acceptedTypeflags を偽値に                 適合    → 落ちる
endOfArchiveConvention を偽値に            適合    → 落ちる
limits を {} にする                        適合    → 落ちる
acceptedHeaderFormats を [] にする         適合    → 落ちる
stableReasonCode を TOTALLY_FAKE に        適合    → 落ちる
対照: status を enum の外へ                落ちる  → 落ちる
対照: archivePolicy ごと削除               落ちる  → 落ちる
```

`ARCHIVE_POLICY` を道具の中の唯一の正本にし、`policyId` / `policyVersion` /
`policySha256` / `coverage` を足しました。**schema を狭めましたが版は据え置きです**
——版数判定器で `HOLD_RECORD`（狭まった＝据え置き可・要記録）と実測したためです。

> ⚠️ **`policySha256` は改竄されていないことの証明にはなりません。**
> 同じ道具が policy と digest の両方を書いているので、両方書き換えれば一致します。
> 捕まえられるのは、版を跨いだ取り違えと、途中で欠けた欄だけです。

### 12. **`OK` の出力から `stableReasonCode` が丸ごと消えた（v0.6.15 の作業中）**

公開版の誤りではなく、**この版の作業中にこちらが作って、こちらの検査が捕まえたもの**です。
`done()` は固定の欄を組んだあとに `...payload` を展開するので、
呼び出し側が `undefined` を渡すと**欄そのものが消えます**（`JSON.stringify` が落とす）。
schema の必須項目検査が落ちて分かりました。展開のあとで立て直す形に直しています。

### **`toolVersion` を 18 へ上げました**

`stableReasonCode` が `OK` 以外のすべての status に付くようになり、
2 つの code の意味と status が変わります。**受け手が機械で分岐する値が変わります。**

---

## v0.6.15（2026-08-14 記載・**v0.6.16 で直しました**）

### 13. **v0.6.15 は `NOT_READY` です。配ったテスト証拠が v0.6.14 のものでした**

| | |
|---|---|
| 対象 | **公開済みの v0.6.15 release**（asset は上書きしません） |
| 症状 | 同梱の `test_counts.json` が **v0.6.14 の実行**（1236 件・`1c79e059`・2026-08-12） |
| 影響 | `validation-results.json` が `releaseReadinessStatus: READY` を名乗っているが、**その根拠は前の版の実行である** |
| 直した版 | v0.6.16（門を新設。**v0.6.15 の asset は直しません**） |

**release notes には 1304 件と書き、CI も 1304 件を通していました。**
配った機械可読の証拠だけが 1236 件のままです。

```
公開した test_counts.json     total 1236 / generatedAt 2026-08-12
                              generatedFromCommit 1c79e059…（v0.6.14 第2段）
公開した validation-results   testEvidence.total 1236 / releaseReadinessStatus READY
tag 時点の CI                 1304 件 / 32 ファイル / 失敗 0
```

**なぜ 3 つの門が全部通したか。**

```
check:vacuity      byFile を「これ以上減ってはいけない下限」として使う
                   → 1304 ≥ 1236 なので通る（空振り検査としては正しい）
check:doc-numbers  docs/TEST_RESULTS.md と test_counts.json を突き合わせる
                   → **どちらも古いので一致する**
release:evidence   allPassed / failed / exitCode しか見ない
                   → 古いかどうかは一度も見ていない
```

**一致は現在性の証拠になりません。古いもの同士は仲良く一致します。**

変異対照（2026-08-14）——v0.6.15 が実際に配った 1236 件の証拠を戻して測りました。

```
                        v0.6.15 の門    v0.6.16 の門
check:vacuity              exit 0          exit 0（下限のまま。これは正しい）
check:test-evidence-current （無い）        **exit 1**
release:evidence           READY           **NOT_READY**
release:stage              exit 0          **exit 1**
```

**受け手への影響。**v0.6.15 の profile の数値・区間・event は変わりません
（`profileId` も変わりません）。変わるのは「そのテスト証拠を根拠にできるか」だけです。
**v0.6.15 の `test_counts.json` と `validation-results.testEvidence` は使わないでください。**
tag `v0.6.15` の CI が 1304 件で通っていることが実際の状態です。

### 14. **道具が、自分の配った schema に反する出力を出していました**

| | |
|---|---|
| 対象 | v0.6.15 の `verifyReleaseSourceInputs.mjs`（`toolVersion` 18） |
| 症状 | 2 経路で `SOURCE_UNAVAILABLE_OTHER` を返す。**同梱 schema の 80 種類の enum に無い値** |
| 直した版 | v0.6.16（`toolVersion` 19） |

```
実測 2026-08-14（公開した道具そのもの）
  --source も --tag も渡さない   SOURCE_UNAVAILABLE / SOURCE_UNAVAILABLE_OTHER
  GitHub 取得中に fetch が失敗    同じ
```

再現手順:

```sh
node verifyReleaseSourceInputs.mjs --manifest source-input-manifest.json
# → stableReasonCode が SOURCE_UNAVAILABLE_OTHER になり、同梱 schema に適合しない
```

**v0.6.15 で enum へ狭めたときに、名前を付け忘れた経路が残っていたのが原因です。**
v0.6.16 では出口に関門を置き、契約を破る出力は**そもそも出しません**
（JSON を出さず、終了コード **3** で止まります——`MISMATCH` の 1 と紛れないため）。

### 15. **「到達しない」と宣言した 8 件のうち 4 件は、実際の経路でした**

| | |
|---|---|
| 対象 | v0.6.15 の catalog の `reachability` |
| 症状 | `SOURCE_GIT_ARCHIVE_FAILED` / `SOURCE_FETCH_FAILED` / `SOURCE_HTTP_ERROR` / `SOURCE_BODY_UNREADABLE` を `defensive-invariant` と宣言していた |
| 直した版 | v0.6.16（4 件とも `cli-route` へ。defensive は 4 件だけ） |

**v0.6.15 の両方向照合は、この誤りを通しました。**
「この run で出なかった」を「出ない」の証拠として使っていたためで、
**その経路を踏む試験を書いていなければ、当然出ません。**
route の母集団を試験が手で持っていたことが穴でした。

v0.6.16 では `globalThis.fetch` を注入して踏みます（**道具は 1 バイトも変えません**）。
route の表は `test/_cliRoutes.mjs` の 1 つだけにし、契約の検査と到達性の照合が同じ表を使います。

### 16. **文言の検査そのものが、手書きの一覧を使っていました**

v0.6.15 で新設した `staleWordingAndPaths.test.ts` は「全面へ当てる」と説明しながら、
**`LIVE_FILES` という手書きの allowlist を使っていました**——**それ自体が同じ形の欠陥**です。

```
実測 2026-08-14: docs/ へ新しい文書を作り、古い言い方と実在しないパスを両方書いて
                 全試験を回すと **14 件すべて緑**
```

v0.6.16 で `git ls-files` からの探索へ変え、免除はパスで名指しし、
**その免除がいまも要るか**も確かめます。作り直した検査は、
**旧版が見ていなかった実在しない参照を 1 件見つけました**
（`test/_corruptTar.d.mts` が `test/_tarExpectations.ts` を指していた。実体は `.mjs`）。

---

## v0.6.16（2026-08-15 記載・**v0.6.17 で直しました**）

### 17. **v0.6.16 は `NOT_READY` です。版を据え置いたまま公開契約を広げました**

| | |
|---|---|
| 対象 | **公開済みの v0.6.16 release**（asset は上書きしません） |
| 症状 | `source-verifier-cli-result.v1` を **v1 のまま**、言語を 3 か所広げた |
| 影響 | **v0.6.16 の出力が、v0.6.15 の同じ v1 schema を通りません** |
| 直した版 | v0.6.17（`v2` を新設・`toolVersion` 20。**v0.6.16 の asset は直しません**） |

実測（2026-08-15・両 tag の実物と、repo 自身の判定器）:

```
diffSchemaObjects(v0.6.15 の v1, v0.6.16 の v1) = **BUMP**
  WIDEN  /properties/stableReasonCode/enum
           + CLI_ARGUMENTS_MISSING, SOURCE_FETCH_TIMEOUT
  WIDEN  /properties/archivePolicy/properties/coverage/properties/reasonCodeFamilies/items/enum
           + usage
  WIDEN  /properties/archivePolicy/properties/reasonCodeFamilies/items/enum
           + usage
対照  同じ schema どうしを比べると HOLD（何にでも BUMP と言う判定器ではない）
```

**外部監査の記述より影響が広いことが分かりました。**
監査は「新しい 2 つの code を返す結果が不適合」としていましたが、
`usage` 族は `archivePolicy` に載るので**全出力に出ます**。実測:

```
ajv で v0.6.15 の v1 schema に当てる
  引数不足の出力（CLI_ARGUMENTS_MISSING）  → 不適合（3 か所）
  **`OK` の正常な出力**                     → **不適合（2 か所）**
```

つまり、**v0.6.16 の道具の出力は 1 つも v0.6.15 の schema を通りません。**

**なぜ検査が通したか。**`test/schemaVersioningPolicy.test.ts` の母集団が
`LATEST_TAG = 'v0.5.1'` に固定されており、**v0.5.1 に在った 21 本だけ**を見ていました。
`source-verifier-cli-result.v1` は v0.6.11 の新設なので、**一度も母集団に入っていません。**
「比較した本数 === 母集団の本数」という空振り検査は付いていましたが、
**数えていたのは古いほうの一覧**です。

```
対照（2026-08-15）: BUMP が実在する状態で、v0.6.16 の検査を回すと **57/57 全緑**
```

コメントには「上げた回はここを新しい tag へ進める」と書いてありました。
**11 版のあいだ進みませんでした。**v0.6.17 では `package.json` の版数から
直前 release を毎回その場で決め、母集団を**現行の schema 全部**にしました。
反例（v0.6.15 → v0.6.16）を**違反として捕まえる回帰試験**も入れています。

**受け手への影響。**profile の数値・区間・event は変わりません。
**v0.6.16 が出した保存済みの検算結果は、v0.6.16 と一緒に配った v1 schema で検証してください**
（`$id` から最新版を引かないこと）。v1 のファイルは変更していません。

### 18. **証拠の由来 3 欄を、契約が要求していませんでした**

| | |
|---|---|
| 対象 | v0.6.16 の `validation-results.v2.schema.json` |
| 症状 | `testCountsSha256` / `testCountsGeneratedFromCommit` / `testCountsGeneratedAt` が**未定義かつ任意**。`additionalProperties` も無し |
| 直した版 | v0.6.17（`validation-results.v3`） |

**値は正しく入っていました。要求していなかっただけです。**変異対照（2026-08-15）:

```
                                  v2（旧）   v3（新）
基準（無変更）                       適合       適合
testCountsSha256 を消す              適合     **不適合**
testCountsGeneratedFromCommit を消す 適合     **不適合**
testCountsGeneratedAt を消す         適合     **不適合**
SHA を 63 桁にする                   適合     **不適合**
commit を短縮する                    適合     **不適合**
日付を壊す                           適合     **不適合**
未知項目を足す                       適合     **不適合**
```

**外部監査は「狭める変更なので `HOLD_RECORD`」と想定していましたが、判定器の実測は `BUMP` でした。**
`testEvidence` は `oneOf` の中にあり、判定器は枝の言語について単調でないことを理由に
判定不能を返します（条文どおり `BUMP`）。**判定器を緩めず、版を上げました。**

### 19. **2 つの証拠を結び直す工程がありませんでした**

| | |
|---|---|
| 対象 | v0.6.16 の `release:stage` |
| 症状 | `test_counts.json` の鮮度と `READY` を**別々に**見ていた |
| 直した版 | v0.6.17（`crossBindTestEvidence`） |

**片方だけ作り直した状態は、どちらの検査も単体では通ります。**変異対照（2026-08-15・関門へ直接）:

```
基準（無変更）              通す
test_counts だけ更新        **止める**（testCountsSha256 が指す先と違う）
validation だけ更新         **止める**（total が食い違う）
SHA だけ偽装                **止める**
commit だけ偽装             **止める**
date だけ偽装               **止める**
testEvidence ごと消す       **止める**
```

**関門を切り出してから測っています。**`release:stage` を丸ごと回すと
**手前の鮮度検査が先に落ちて全件が同じ exit 1 になり**、
「この関門が効いた」の証拠になりません（実際に一度そう測って読み違えました）。

### 20. **「両方の門が同じことをする」と書いていました**

| | |
|---|---|
| 対象 | v0.6.16 の `scripts/checkTestEvidenceCurrent.mjs` の説明 |
| 症状 | 「`release:evidence` と `release:stage` の両方が必ず通す」——実装は違う |
| 直した版 | v0.6.17（説明を実装どおりに） |

実装は `release:evidence` が**由来だけ**、`release:stage` が**実測**です。
`release:evidence` の中でテストを回すと、その結果を自分の中へ書くので
**`READY` へ到達できなくなります。**分けているのには理由がありますが、書いていませんでした。

### 21. **「唯一の測り方」と書いた隣に、2 つ目の実装がありました**

| | |
|---|---|
| 対象 | v0.6.16 の `scripts/testCount.mjs` |
| 症状 | `byFile` の作り方・skip の数え方・`allPassed` の決め方を `measureTests.mjs` と**別に**実装 |
| 直した版 | v0.6.17（`summarizeVitestReport` を唯一の集計器に） |

値がたまたま一致していたので、どの検査も鳴っていませんでした。
**同じ境界を 2 つの一覧で持たない**——この repo で 12 回目の同じ形です。

### 22. **`SOURCE_ARCHIVE_MISSING` を「到達しない」に入れていました**

| | |
|---|---|
| 対象 | v0.6.16 の reason code catalog |
| 症状 | `defensive-invariant`（論理的に起こりえない）と宣言。実際は**確認と使用の間で消されれば到達する** |
| 直した版 | v0.6.17（`race-defensive` を新設） |

外部監査の指摘どおりです。あわせて、両方向の照合が
`reachability !== 'defensive-invariant'` という**文字列の否定**で群を分けていたのを、
語彙表（`REACHABILITY_KINDS`）から引く形に変えました。
否定で分けていると、**新しい種類を足した瞬間に黙ってどちらかへ入ります。**

---

## v0.6.17（2026-08-15 記載・**次の版で直します**）

### 23. **attestation の `releaseIndexSha256` が、配った索引を指していません**

| | |
|---|---|
| 対象 | **公開済みの v0.6.17 release** の `release-stage-attestation.v1.json`（asset は上書きしません） |
| 症状 | `releaseIndexSha256` が **repo 側の索引**（`releaseTag: null`）の digest |
| 影響 | 受け手が**配った索引の sha256 を計算しても一致しません** |
| 直した版 | **v0.6.18**（測る先を配布物の側へ。**v0.6.17 の asset は直しません**） |

**公開した直後に、自分で添付を検算して見つけました。**

```
attestation が名乗る値   e9c72e2412fa6e21…  ← repo 側（releaseTag: null）
配布した索引の実測       a014768129b56e18…  ← 受け手が計算する値
違う欄                   releaseTag / releaseCommit（配布時に書き込む）
```

**3 つの digest のうち 2 つは正しい。**`test_counts.json` と
`validation-results.json` は配布時にそのまま写すので、repo 側と配布物が同じ値になります。
**索引だけが写しではない**——`releaseTag` と `releaseCommit` を配布時に書き込むためです。

```
testCountsSha256         一致
validationResultsSha256  一致
releaseIndexSha256       **不一致**
```

**これは「検証した物と出荷した物を別にしない」の再発です。**
attestation を書く工程が `resolve(ROOT, …)` を測っていました。測るべきは `OUT` の側です。

**受け手への影響。**profile の数値・区間・event・`profileId` は変わりません。
`SHA256SUMS` は配布物から作っているので正しく、**索引の検算は `SHA256SUMS` で行えます。**
使えないのは `attestation.releaseIndexSha256` の 1 欄だけです。

v0.6.18 で `OUT` を測るよう直し、**この欠陥を捕まえる検査**を入れました。
変異対照（2026-08-15）: `resolve(ROOT, …)` へ戻すと**その検査だけが落ちます**
（他 8 件は緑のまま＝別の検査の副作用で落ちているのではありません）。

**直ったことを公開物で確かめました**（2026-08-15）。

```
v0.6.18 の添付を取得して attestation の 3 digest を検算
  testCountsSha256         一致
  validationResultsSha256  一致
  releaseIndexSha256       一致   ← v0.6.17 ではここだけ不一致だった
対照  別ファイルの digest と比べると不一致を検出
```

---

## docs（2026-08-15 記載・**同日直しました**）

### 24. **実装済みの道具を「未実装」と書いていました（9 日間）**

| | |
|---|---|
| 対象 | `docs/VERIFICATION_PLAN.md` §「何が決まるか」／`docs/V060_PLAN_20260805.md` |
| 症状 | 「`npm run fit:contacts` の 4極版は**未実装**」と書いていた |
| 実際 | `npm run fit:contacts:trrs` が **2026-08-06 から在る**（`scripts/fitContactsTrrs.ts`） |
| 影響 | **測ってくださる方に、在る道具を「無い」と伝えていました。**手計算を促していた |
| 直した版 | 2026-08-15（release 前・公開済み asset には影響しません） |

**経緯（commit の時刻で実測）:**

```
11:21  6e151bc  docs   「4極版は未実装」と書いた
11:38  7602666  script **その 17 分後**に fitContactsTrrs.ts が入った
15:53  18abe44  docs   同じ文書を再び触ったが、直っていない
```

**なぜ 9 日も残ったか。** この repo の文言検査は「**在ると言ったのに無い**」だけを見ていました
（指したパスが実在するか）。**反対向き＝「無いと言ったのに在る」には検査が 1 つも無かった。**

害は**受け手の側にしか出ません**——書いた本人は道具が在ることを知っているので、
読み返しても違和感がありません。実装が進むほど増える型です。

**同じ型を機械で捕まえる検査を入れました**（`test/staleWordingAndPaths.test.ts`
「「無い」と書いたものが、本当に無いか」）。否定語と同じ行にある npm script 名を拾い、
その script が `package.json` に**無いこと**を要求します。
公開済みの release notes と CHANGELOG は、その時点の記録なので対象外です。

## 判定器（2026-08-15 記載・**同日直しました**）

### 25. **`oneOf` の枝が `$ref` のとき、参照先の変更が見えていませんでした**

| | |
|---|---|
| 対象 | `scripts/schemaLanguageDiff.mjs`（**配布物ではありません**。版を上げるかを決める判定器） |
| 症状 | `oneOf` の枝が `{ $ref: … }` のとき、参照先だけが変わっても「変わっていない」と判定 |
| 影響 | **言語が広がっているのに「据え置き可」と答える。**受け手は旧 schema を pin しているので拒む |
| 直した版 | 2026-08-15（`v0.6.20` 公開後・次の版に入ります） |

```
旧  oneOf: [{type:'string'}, {$ref:'#/definitions/d0'}]   definitions.d0.type = 'boolean'
新  同じ oneOf                                             definitions.d0.type = ['boolean','null']

ajv   null が旧 invalid → 新 valid  ＝ **広がっている**
判定  HOLD（据え置き可）             ← 危険側
```

**原因。** `oneOf` は枝の言語について単調でないので、枝ごとの比較ができません。
そこで「変わったか」を `JSON.stringify(o.oneOf) !== JSON.stringify(n.oneOf)` で見ていました。
枝が `$ref` なら**参照先が変わっても文字列は同じ**です。
root が `$ref` の場合は入口で辿るので前から正しく、**枝だけが素通り**していました。

**見つけ方が今までと違います。** これまでの 4 件は外部監査からでしたが、
これは**ランダム生成した schema 対**から出ました
（`test/schemaLanguageFuzz.test.ts`。計画 `docs/V060_PLAN_20260805.md` §3 が
`[AI]` で約束したまま 10 日落ちていた property-based 試験）。961 対のうち 4 件。

**直す前に回帰テストを入れました**（条文 ①-c3。入れた時点では落ちます）。
修正を戻すと 3 件落ちることも実測しています。

**限界。** 探しているのは「新だけが通す値が実在するのに BUMP でない」だけです。
値は schema 対から作りますが、**作れない値があれば広がりを見逃します。**
探索が働いていることは同じファイルの対照 5 つで確かめています
（既知の広がりで証人が出る／同一 schema では出ない／深いネストと `$ref` を作れている／
判定が BUMP 一色でない／変異が当たった対だけ数えている）。

## v0.6.21（2026-08-15 記載・**同日直しました**・外部監査）

### 26. **同じ根が 2 か所残っていました（`$ref` に sibling がある形）**

| | |
|---|---|
| 対象 | `scripts/schemaLanguageDiff.mjs`（**配布物ではありません**。版を上げるかを決める判定器） |
| 症状 | 節の**文字列は同じまま**参照先だけ変わると、「変わっていない」と判定 |
| 影響 | **言語が広がっているのに「据え置き可」と答える。**§25 と同じ危険側 |
| 見つけた人 | **外部監査**（v0.6.21 の公開物に対する指摘）。§25 はこちらの property-based 試験でした |
| 直した版 | 2026-08-15（`v0.6.21` 公開後・次の版に入ります） |

**§25 で直したのは 1 か所だけでした。**あのとき `expandRefs()` を入れましたが、
展開するのは **`$ref` が唯一の key のとき**だけ（`Object.keys(node).length === 1`）。
`{ $ref: …, description: … }` のように annotation が付いていると展開されません。

```
反例1  oneOf の枝が { $ref: '#/definitions/d0', description: 'branch' }
       旧 d0.type = 'string'  →  新 d0.type = ['string','null']
       ajv  {"x":null} が旧 invalid → 新 valid  ＝ 広がっている
       判定 HOLD / exit 0                        ← 危険側

反例2  definitions.outer = { not: { $ref: '#/definitions/inner' } }   ← 新旧まったく同じ
       旧 inner.type = ['string','null']  →  新 inner.type = 'string'
       ajv  {"x":null} が旧 invalid → 新 valid  ＝ 広がっている（not の中が狭まると外は広がる）
       判定 HOLD / exit 0                        ← 危険側
```

**原因は 1 つです。**「節の文字列が変わっていない」を「意味が変わっていない」の
証拠にしていました。`$ref` は**参照先を指すだけ**なので、指す先が変われば
文字列が同じままで意味が変わります。**同じ節を同じにしておけば検査を免れる**形でした。

**その置き方が 3 か所にありました。**§25 で直したのは 1 か所目です。

| | 直した版 | 見つけた人 |
|---|---|---|
| `oneOf` の枝の比較 | §25（v0.6.21） | property-based 試験 |
| 同上・**枝に sibling がある形** | §26（この版） | **外部監査** |
| allowlist ゲート（未対応 keyword が `$ref` を包む） | §26（この版） | **外部監査** |
| `anyOf` / `allOf` の早期 `continue` | §26（この版） | **こちら**（上の 2 つを直すとき数え直して見つけた） |

3 か所目は監査の指摘には無く、**直す前に「文字列の一致を意味の一致と置いた箇所」を
数えた**ときに出ました。1 件目だけ直して終わりにしない
——**同じ誤りは全部数えてから直す**。

**§25 が名指しした限界が、そのまま当たりました。**§25 の末尾にこう書いています。

> 値は schema 対から作りますが、**作れない値があれば広がりを見逃します。**

監査の反例 2 件は、どちらも証人が `{"x": null}` でした。
**当時の試験は「1 つの key だけが null」の値を 1 件も作れていません**
（実測: 300 種 6,219 候補中 **0 件**）。生成器の側も、
`$ref` に sibling を付けた形を**枝の位置で 1 件も作っていません**（実測 **0 件**）。
**どちらか片方でも 0 なら、判定器を直しても試験は自力で見つけられません。**

補強したうえで、v0.6.21 の判定器に対して回すと**自力で反例を出しました**
（seed 266・枝が `{$ref, description}`・参照先の `type` が広がった形）。

**現行 schema への影響はありません。**`$ref` + sibling は現行 schema に 3 件
（`evidenceGrade` が 3 版すべてでこの形）ありますが、いずれも `properties` の位置で、
そこは前から正しく判定していました（`compare()` が再帰するため）。
実 schema 194 対（現行 25 schema × 直近 8 tag）で**判定は 1 件も変わっていません。**

### 27. **`schemaId` を名乗りながら、その schema を配っていませんでした**

| | |
|---|---|
| 対象 | `release-stage-attestation.v1.json`（最終関門の記録・**配布物**） |
| 症状 | `schemaId: trs-jack-3d-release-stage-attestation.v1` と名乗るが、対応する schema が asset に無い |
| 影響 | **受け手が形を独立検証できない。**`schemaId` が名前だけの飾りになっていた |
| 見つけた人 | 外部監査 |
| 直した版 | 2026-08-15（`v0.6.21` 公開後・次の版に入ります） |

**記録の中身は正しいものでした。**監査も現物は妥当と実測しています。
欠けていたのは**受け手が確かめる手段**です。

検査していたのは `test/stageAttestation.test.ts` の **source text 検査**だけでした
——「`stageRelease.mjs` に `exitCode:` と書いてあるか」は分かりますが、
**生成された実物が契約に合うかは見ていません。**

直した内容:

- `schemas/release-stage-attestation.v1.schema.json` を新設し、**配布一覧へ入れた**
- `stageRelease.mjs` が**書く前に**実 object を検証し、合わなければ
  記録も SHA256SUMS も出さずに止まる（書いてから検証すると、
  落ちたときに「途中まで正しく見える記録」が残ります）
- `testEvidenceCrossBound` を必須欄へ入れた（**それまで必須一覧に無かった**）
- 壊した記録 8 種類＋必須欄を 1 つずつ落とした 17 通りを、schema が拒むことを実測
- **生成器が書く欄と schema の必須欄が同じ**であることを機械照合
  （同じ境界を 2 つの一覧で持つと、片方しか見ない経路ができます）

**記録そのものは索引の外のままです**（自己参照を避けるため。SHA256SUMS が持ちます）。
索引へ入れたのは schema だけです。

### 28. **tag の中の `SECURITY.md` が、恒久的に 1 版古くなっていました**

| | |
|---|---|
| 対象 | `SECURITY.md`（「対象の範囲」） |
| 症状 | 「直近の release 1 本（現時点では vX.Y.Z）」の版数が、**その tag の 1 つ前**を指す |
| 影響 | 受け手が読むのは tag の中身。`main` が正しくても救いになりません |
| 見つけた人 | 外部監査 |
| 直した版 | 2026-08-15（`v0.6.21` 公開後・次の版に入ります） |

```
v0.6.18 の tag → 「現時点では v0.6.17」
v0.6.19 の tag → 「現時点では v0.6.18」
v0.6.20 の tag → 「現時点では v0.6.19」
v0.6.21 の tag → 「現時点では v0.6.20」     4/4 tag で実測
```

**工程上どうやっても直りません。**release を作る commit の時点では、その版はまだ
公開されていないので、書ける最新は 1 つ前です。`check:doc-numbers` は
**手元の控えの最大版数**でこの行を縛っていたので `main` では常に正しく、
**だからこそ誰も気づきませんでした。**

これは「在ると言ったのに無い」（v0.6.15 の検査）でも
「無いと言ったのに在る」（v0.6.21 の検査）でもない **3 つ目の型**です。
**文書が「いま」を名乗った瞬間に、immutable な写しが嘘になる。**

版数を書かず `Latest` の表示を指す形へ変え、
**書き足されたら止まる検査**を入れました（`test/staleWordingAndPaths.test.ts`）。
在ることの検査だけでは、版数を書き足しても誰も止まりません
——**強制は検査に入れる。**証拠に書いても誰も止まりません。

### 29. **索引の `notes` が「4 点」と書いて 5 つ並べていました**

| | |
|---|---|
| 対象 | `trs-jack-3d-release-index.v1.json` の `notes`（**説明文。機械契約ではありません**） |
| 症状 | 「受け手が固定すべき **4 点**」の後ろに、ファイルが **5 つ**並ぶ |
| 影響 | 説明文の食い違いのみ。機械契約は `assets[]` なので分岐には影響しません |
| 見つけた人 | 外部監査 |
| 直した版 | 2026-08-15（`v0.6.21` 公開後・次の版に入ります） |

一覧は `RELEASE_ASSETS` から役割で引いているのに、**数だけ手で書いていました。**
profile が 2 本になった時点でずれています。**数を言わない**形へ変え
（受け手が固定するのは「名指しされた配布物すべて」で、個数ではありません）、
`notes` が件数を手書きしていないことを検査に入れました。

同じ節の「検算ツールの契約（v0.6.16）」も、直後に `toolVersion 20` と書いていても
**「これは v0.6.16 の契約だ」と読めます。**版数は*いつこの形にしたか*であって
契約の版ではないので、そう読める書き方をやめました。

## この正誤表の運用

- **公開済みの release 本文と asset は、いかなる理由でも書き換えない。**
  asset を足すこともしない（受け手が照合する集合が変わるため）。
- 誤りは**次の版の notes 冒頭**でも名指しし、この文書を指す。
- 直った版が出たら「どの版で直したか」を各項目に追記する。**項目は消さない。**
