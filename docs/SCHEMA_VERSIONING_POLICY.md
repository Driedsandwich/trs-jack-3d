# schema versioning policy

制定: 2026-08-05（v0.5.0）
`policyVersion`: 1
機械判定: `scripts/schemaLanguageDiff.mjs`
検査: `test/schemaVersioningPolicy.test.ts` / `test/contractMigration.test.ts`

この文書は**条文**である。設計の経緯と実測は `docs/SCHEMA_VERSIONING_DESIGN_V050_20260805.md` にある。

---

## 条文

> ### 第1条（判定の対象）
> 版を上げるかどうかは、**新旧 2 つの schema だけ**で決める。
> その版の artifact が何を含むかは見ない。
>
> ### 第2条（判定式）
> 新 schema が受け入れる値の集合を L(新)、旧 schema のそれを L(旧) とする。
>
> | | | |
> |---|---|---|
> | L(新) ⊆ L(旧) **でない** | `BUMP` | **版を上げる** |
> | L(新) ⊊ L(旧)（真に狭まった） | `HOLD_RECORD` | 据え置いてよい。**ただし `contractMigration` に記録する** |
> | L(新) = L(旧) | `HOLD` | 据え置いてよい。記録も要らない |
>
> ### 第3条（機械判定）
> 第2条は下の対応表で機械的に決める。
> **表に無い変更・包含を決められない変更は「上げる」側へ倒す。**
>
> ### 第4条（項目の追加）
> 本 project の schema は `additionalProperties: false` である。
> したがって **optional な項目の追加も版を上げる。**
> 「optional だから据え置ける」は、この書き方では成り立たない。
>
> ### 第5条（狭める変更）
> 狭める変更は版を据え置けるが、**旧 artifact が新 schema で落ちる。**
> 過去の release を再検証する consumer が止まるので `contractMigration` へ記録する。
>
> ### 第6条（条文の外）
> ファイル名・値の意味・生成手順・数値の妥当性は schema の言語に現れない。
> 第2条の対象外であり、**別に記録する**（`contractMigration.renamedAssets` /
> `changes[].kind = "meaning-changed"`）。
>
> ### 第7条（版と記録の対応）
> 版を上げたら `contractMigration.history` に 1 件足す。
> 据え置いたまま第2条が `BUMP` と言う変更を出したら、それは違反である。
> **次に版を上げるとき、その違反を `history` へ遡って記録する**
> （`versionWasHeld: true` / `schemaVersionShouldHaveBeen` / `recordedRetroactivelyIn`）。

---

## 第3条の対応表

| schema の変更 | 言語 | 判定 |
|---|---|---|
| `properties` に項目を足す（`additionalProperties:false` のとき） | 広がる | **BUMP** |
| `enum` に値を足す | 広がる | **BUMP** |
| `required` から外す | 広がる | **BUMP** |
| `additionalProperties` を `false` → `true` | 広がる | **BUMP** |
| 上限を緩める／下限を外す | 広がる | **BUMP** |
| `type` に型を足す | 広がる | **BUMP** |
| `properties` から項目を消す（`additionalProperties:true` のとき） | 広がる | **BUMP** |
| `pattern` を書き換える | 決められない | **BUMP** |
| `const` の値を変える | 決められない | **BUMP** |
| **`oneOf` が変わる（枝の中身でも）** | 決められない | **BUMP** |
| `anyOf` / `allOf` の枝の数が変わる | 決められない | **BUMP** |
| `$ref` を解決できない・循環する | 決められない | **BUMP** |
| **宣言外の keyword が在る**（変わっていなくても） | 決められない | **BUMP** |
| **`$ref` に sibling がある節が変わった** | 決められない | **BUMP** |
| `required` に足す | 狭まる | HOLD_RECORD |
| `enum` から値を減らす | 狭まる | HOLD_RECORD |
| `properties` から項目を消す（`additionalProperties:false` のとき） | 狭まる | HOLD_RECORD |
| 上限を絞る／下限を上げる／`pattern` を新設 | 狭まる | HOLD_RECORD |
| `type` から型を減らす | 狭まる | HOLD_RECORD |
| `uniqueItems` を付ける | 狭まる | HOLD_RECORD |
| `description` / `title` / `$comment` / `$id` だけ | 同じ | HOLD |

> **`oneOf` だけ扱いが違う理由。**`anyOf` は和、`allOf` は積なので、枝ごとの言語が狭まれば
> 全体も狭まる（単調）。枝ごとに再帰比較して差し支えない。
> **`oneOf` は「ちょうど 1 枝」なので単調でない**——枝を狭めた結果、
> それまで 2 枝に一致して弾かれていた値が 1 枝だけに一致して通るようになる。
> 枝ごとの比較では決められないので、変更があれば無条件で BUMP へ倒す（§限界 2）。

---

## なぜ「旧 schema が今の artifact を拒むか」で書かないか

最初に書いた条文はそれだった。実測すると**同じ schema 変更でも artifact 次第で反転する。**

```
v0.3.0 schema × 現物（role に input-scope を使う）            → 拒む   → 「上げる」
v0.3.0 schema × role を input-scope から戻した同じ artifact   → 受ける → 「据え置き可」
                                              （書き換えたのは 1 項目だけ）
```

`role` の enum に値を足しても、**その版の artifact がまだ使っていなければ据え置きが許され、
使い始めた版で突然止まる。** 破壊的変更の記録が「いつ壊したか」ではなく
「いつ使い始めたか」にずれ、後から原因を辿れなくなる。

---

## 条文自身の検査

条文を機械判定にすると、**判定器が「常に BUMP」と言うだけでも過去の全件に当たってしまう。**
`test/schemaVersioningPolicy.test.ts` が 3 つを検査する。

| | 内容 | 何を防ぐか |
|---|---|---|
| ① 合成 | 答えが分かっている 16 件。**うち 7 件は BUMP 以外** | 判定器が常に BUMP と言うこと |
| ② 遡及 | 過去 7 件へ当てて `BUMP` になること | 条文が過去を誤判定すること |
| ③ 対照 | 中身が変わらない schema は `HOLD` になること | 条文が何にでも鳴ること |

②で 7/7 が `BUMP` になるのは、**過去 7 件が実際に違反だったから**である
（旧 schema × その版の実物で 9/9 停止することを実測済み）。①の「BUMP 以外 7 件」と
合わせて初めて、条文に判別力があると言える。

---

## 限界

1. **保守的な近似である。**JSON Schema の言語包含は一般には決定不能なので、
   決められない変更はすべて BUMP へ倒す。**「上げなくてよいのに上げる」誤りは残る。**
2. **危険側の誤り（上げるべきなのに据え置く）が「起きない」とは言えない。**

   v0.5.0 の判定器はそう書いていたが、**外部監査が `oneOf` の反例を出した**（2026-08-05）。

   ```
   旧  oneOf: [{integer}, {number, minimum: 0}]
   新  oneOf: [{integer}, {number, minimum: 1}]

   値 0    旧 invalid（2 枝が一致するので oneOf は落ちる）→ 新 valid   **広がっている**
   値 0.5  旧 valid                                    → 新 invalid  狭まっている
   ```

   どちらも他方を包含しないので正しい判定は BUMP だが、枝を index 同士で比較していた
   実装は「`minimum` が上がった = NARROW」とだけ見て **HOLD_RECORD** を返していた。
   v0.5.1 で `oneOf` は無条件 UNDEC へ倒した（回帰試験
   `test/schemaVersioningPolicy.test.ts` の「①-b」が、**v0.5.0 tag の実物を読み込んで
   修正前の挙動も実測**している）。

   **同じ形の穴が他に無いことは示せていない。**この条文で言えるのは
   「いま反例が見つかっている経路は塞いだ」までである。

   **実際、`oneOf` を直した直後に同じ形が 3 つ出た**（2026-08-05・第2回監査）。

   ```
   $ref に sibling があると参照変更を見落とす          → HOLD（差分 0 件）
   schema 型 additionalProperties へ項目を足す        → HOLD_RECORD
   patternProperties があるのに項目を消す              → HOLD_RECORD
   ```

   どれも「判定器が扱いきれない構文の周りで、他の keyword の意味が変わる」型である。
   **1 つずつ塞ぐ形では列挙漏れがそのまま危険側の穴になる**ので、v0.5.2 で
   **allowlist 方式**へ変えた。

   > 判定器が正しく扱えると宣言した keyword の集合（`HANDLED_KEYWORDS`）を決め、
   > **宣言外の keyword が「在る」だけで**（かつその節が新旧で変わっていれば）
   > 無条件に `UNDEC` へ倒す。「変わったら倒す」ではない——
   > **変わっていない keyword が、他の keyword の意味を変える**ためである。

   宣言集合は現行 schema が実際に使う keyword を機械で数えて決めた。
   `test/schemaVersioningPolicy.test.ts` の ①-d が、**宣言外の keyword が schema に
   現れたら落とす**。落ちたら「判定器を直す」か「宣言集合へ足す」かを、その場で決めること。
   **足すだけでは、倒れていたものが倒れなくなるだけである。**
3. **`meaning-changed`（値の意味だけ変わる）は機械判定できない。**
   型も enum も同じまま意味だけ変わる変更（v0.1.1 の `spreadStatus` がこれ）は、
   人間が気づいて `contractMigration` に書く以外にない。条文はここを守れない。
4. **ファイル名は条文の外である**（第6条）。配布名で引く下流は
   schema 検査に到達する前に止まる。

---

## 第7条 — 互換性には向きが 2 つある（v0.6.16・外部監査 2026-08-14）

これまでこの文書は、**producer-forward** の 1 軸しか見ていなかった。

> 新しい版が出す結果は、古い版の schema でも読めるか。

`HOLD_RECORD`（狭まった＝据え置き可）はこの軸の話である。**狭めても、
新しい出力は古い schema を通る**ので、下流はその場では止まらない。

だが軸はもう 1 つある。

> **保存しておいた古い結果は、新しい版の同じ schema で読めるか。**

**これは通らない。**実測（2026-08-14）:

```
v0.6.14 の出力 → v0.6.14 の schema   適合
v0.6.14 の出力 → v0.6.16 の schema   **不適合**（policyId が必須になったため）
v0.6.16 の出力 → v0.6.16 の schema   適合
v0.6.16 の出力 → v0.6.14 の schema   適合
```

外部監査はここで `source-verifier-cli-result.v2` の新設を勧めた。**採らなかった。**

- v2 にしても、次に狭めたときに同じことが起きる。**軸の問題は版数では解けない。**
- 下流（Half-Plug）は既に `schemaId` で分岐しており、v2 はその分岐を増やすだけである。
- **必要なのは「どの schema で読むか」を結果ごとに固定すること**で、
  それは既に release asset として配っている。名指ししていなかっただけである。

### 決めたこと

**保存した結果は、その結果と一緒に配った schema で検証する。**
`$id` から「最新の v1」を引かない。

release index の `verifierContract` が、その版の

```
toolSha256                       信頼の起点
cliResultSchema.filename/sha256  **保存した結果の突合先はこれ**
policy.policyId/Version/Sha256   自己整合の識別子（真正性の証明ではない）
```

を名指しする。`test/schemaVersioningPolicy.test.ts` が、
**過去 tag の出力がその tag の schema で通ること**と、
**最新 schema では通らないことがある**ことの両方を実測で固定する。

> **`policySha256` を信頼の起点にしないこと。**同じ道具が policy と digest の
> 両方を書くので、両方を書き換えれば一致する。起点は道具そのものの sha256 である。

---

## 第8条 — 母集団は「いま配る schema の全部」（v0.6.17・外部監査 2026-08-15）

条文の判定は、**どの 2 つを比べるか**が決まって初めて意味を持つ。
v0.6.16 まで、その「どれを比べるか」は試験の中の 1 行だった。

```
const LATEST_TAG = 'v0.5.1'
```

コメントには「上げた回はここを新しい tag へ進める」と書いてあった。
**11 版のあいだ進まなかった。**母集団が v0.5.1 に在った 21 本に固定され、
v0.6.11 で新設した `source-verifier-cli-result.v1` は**一度も入らなかった。**

結果、v0.6.16 は版を据え置いたまま enum を 3 か所広げて公開し、
**57/57 全緑**のまま通った（2026-08-15 実測）。
「比較した本数 === 母集団の本数」という空振り検査は付いていたが、
**数えていたのは古いほうの一覧**である。

### 規則

```
直前 release      package.json の版数より小さい、最大の release tag
                  （tag CI でも自分自身は選ばれない）
母集団            現行の schemas/*.schema.json の全部
                  **git add していないものも数える**
                  ——add 忘れのあいだ検査から消えるのは、上と同じ形になる
```

判定は 4 つ。

```
直前に同じ path があり、名乗る版も同じ   → BUMP なら違反
直前に同じ path があり、名乗る版が違う   → migration の history が要る
直前に同じ path が無い（改名）           → migration の renamedAssets が要る
直前に同じ path が無い（新設）           → 直前に同じ $id/schemaId が無いこと
```

### 空振りさせないための固定

`test/schemaVersioningPolicy.test.ts` が、
**v0.6.15 → v0.6.16 の CLI result（版据え置きのまま WIDEN）を、
いまの判定が違反として鳴らすこと**を実物で固定する。
対照として、**同じ組み合わせを変えずに当てると鳴らないこと**も見る。
この反例を捕まえられない検査に差し替えてはいけない。
