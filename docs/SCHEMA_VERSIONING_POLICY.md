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
| `oneOf` / `anyOf` / `allOf` の枝の数が変わる | 決められない | **BUMP** |
| `$ref` を解決できない・循環する | 決められない | **BUMP** |
| 未対応キーワードが変わった | 決められない | **BUMP** |
| `required` に足す | 狭まる | HOLD_RECORD |
| `enum` から値を減らす | 狭まる | HOLD_RECORD |
| `properties` から項目を消す（`additionalProperties:false` のとき） | 狭まる | HOLD_RECORD |
| 上限を絞る／下限を上げる／`pattern` を新設 | 狭まる | HOLD_RECORD |
| `type` から型を減らす | 狭まる | HOLD_RECORD |
| `uniqueItems` を付ける | 狭まる | HOLD_RECORD |
| `description` / `title` / `$comment` / `$id` だけ | 同じ | HOLD |

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
2. **`meaning-changed`（値の意味だけ変わる）は機械判定できない。**
   型も enum も同じまま意味だけ変わる変更（v0.1.1 の `spreadStatus` がこれ）は、
   人間が気づいて `contractMigration` に書く以外にない。条文はここを守れない。
3. **ファイル名は条文の外である**（第6条）。配布名で引く下流は
   schema 検査に到達する前に止まる。
