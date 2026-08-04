# v0.5.0 設計 — schema versioning の是正

作成日: 2026-08-05
対象: `docs/NONBLOCKING_FOLLOWUP_ORDER_V041_20260804.md` §1・§2
状態: **設計のみ。実装していない。** schema・artifact・生成器は 1 行も変えていない。

---

## 0. 決めたこと（本人決定・2026-08-05）

1. **版を上げるのは 6 つ。** オーダーの 4 つに、v0.4.1 で拒む変更を据え置いた 2 つを足す。
2. **`additionalProperties: false` は維持する。** したがって条文は「項目の追加はすべて版上げ」と正直に書く。「optional な追加は据え置き可」とは書かない。

| | 現行 | v0.5.0 |
|---|---|---|
| `half-plug-topology-profile` | v2 | **v3** |
| `event-sensitivity` | v1 | **v2** |
| `topology-robustness` | v2 | **v3** |
| `source-input-manifest` | v1 | **v2** |
| `validation-results` | v1 | **v2** ← オーダーに無い。v0.4.1 で壊した |
| `test-counts` | v1 | **v2** ← オーダーに無い。v0.4.1 で壊した |

据え置くもの: `trs-jack-3d-release-index.v1` / `source-input-scope.v1` / `source-verification-result.v1` /
`topology-search.v1` / `real-jack-comparison.v1`（いずれも v0.4.1 から言語が変わらない。§2-5 の対照で実測）

---

## 1. 条文 — schema versioning policy

### 1-1. 「旧 schema が今の artifact を拒むか」で判定してはいけない

最初に書いた条文は「旧 schema を pin した consumer が拒否する変更は版を上げる」だった。
これを ajv で実測すると判定できるように見えるが、**同じ schema 変更でも artifact 次第で答えが反転する。**

実測（`half-plug-topology-profile.v2`・v0.3.0 の schema × v0.4.0 の artifact）:

```
v0.3.0 schema × 現物（role に input-scope を使う）            → 拒む   → 「上げる」
v0.3.0 schema × role を input-scope から戻した同じ artifact   → 受ける → 「据え置き可」
                                                （書き換えたのは 1 項目だけ）
```

つまり `role` の enum に値を足しても、**その版の artifact がその値をまだ使っていなければ据え置きが許され、
使い始めた版で突然止まる。** 判定を artifact の中身に依存させると、破壊的変更の記録が
「いつ壊したか」ではなく「いつ使い始めたか」にずれる。

### 1-2. 条文

> **第1条（判定の対象）**
> 版を上げるかどうかは、**新旧 2 つの schema だけ**で決める。その版の artifact が何を含むかは見ない。
>
> **第2条（判定式）**
> 新 schema が受け入れる値の集合を L(新)、旧 schema のそれを L(旧) とする。
>
> - L(新) ⊆ L(旧) **でない** → **版を上げる**
> - L(新) ⊊ L(旧)（真に狭まった） → **据え置いてよい。ただし `contractMigration` に記録する**
> - L(新) = L(旧) → **据え置いてよい。記録も要らない**
>
> **第3条（機械判定）**
> 第2条は下の対応表で機械的に決める。**表に無い変更・包含を決められない変更は「上げる」側へ倒す。**
>
> **第4条（項目の追加）**
> 本 project の schema は 13 本すべて `additionalProperties: false` である。
> したがって **optional な項目の追加も版を上げる。**
> 「optional だから据え置ける」は、この書き方では成り立たない。
>
> **第5条（狭める変更）**
> 狭める変更は版を据え置けるが、**旧 artifact が新 schema で落ちる。**
> 過去の release を再検証する consumer が止まるので `contractMigration` へ記録する。
>
> **第6条（条文の外）**
> ファイル名・値の意味・生成手順・数値の妥当性は schema の言語に現れない。
> 第2条の対象外であり、**別に記録する**（§3-4）。
>
> **第7条（版と記録の対応）**
> 版を上げたら `contractMigration.history` に 1 件足す。
> 据え置いたまま第2条が「上げる」と言う変更を出したら、それは違反である。
> **次に版を上げるとき、その違反を history へ遡って記録する。**

### 1-3. 機械判定表（第3条）

| schema の変更 | 言語 | 判定 |
|---|---|---|
| `properties` に項目を足す（`additionalProperties:false` のとき） | 広がる | **上げる** |
| `enum` に値を足す | 広がる | **上げる** |
| `required` から外す | 広がる | **上げる** |
| `additionalProperties` を `false` → `true` | 広がる | **上げる** |
| 上限を緩める／下限を外す | 広がる | **上げる** |
| `type` に型を足す | 広がる | **上げる** |
| `pattern` を書き換える | 決められない | **上げる** |
| `const` の値を変える | 決められない | **上げる** |
| 未対応キーワードが変わった | 決められない | **上げる** |
| `required` に足す | 狭まる | 据え置き可・**記録** |
| `enum` から値を減らす | 狭まる | 据え置き可・**記録** |
| `properties` から項目を消す（`additionalProperties:false` のとき） | 狭まる | 据え置き可・**記録** |
| 上限を絞る／下限を上げる／`pattern` を新設 | 狭まる | 据え置き可・**記録** |
| `description` / `title` / `$comment` だけ | 同じ | 据え置き可 |

### 1-4. 条文そのものの検査（判定器が壊れていないこと）

条文を機械判定にすると、**判定器が「常に上げる」と言うだけでも過去 7 件は 7/7 で当たってしまう。**
先に、答えが分かっている合成ペア 16 件で判定器を検査した。

```
自己検査 16/16 一致
  うち BUMP 以外へ落ちた合成例 7 件（= 判別力がある証拠）
  変異ごとに「その経路が鳴ったか」まで確認（rc だけで判定していない）
```

途中 1 件、`pattern` の変異が **BUMP は出たが意図した経路では鳴っていなかった**（同じ変異で enum も
消していたため別の理由で BUMP になっていた）。変異を作り直して 16/16 にした。

### 1-5. 過去への適用

v0.3.0 → v0.4.0 → v0.4.1 の全 schema に条文を当てた。

| 区間 | schema | 版 | 判定 | 変えた内容 |
|---|---|---|---|---|
| v0.3.0→v0.4.0 | `half-plug-topology-profile.v2` | 2→2 据置 | **上げるべき** | `role` の enum に `input-scope` |
| v0.3.0→v0.4.0 | `event-sensitivity.v1` | 1→1 据置 | **上げるべき** | 同上 |
| v0.3.0→v0.4.0 | `topology-robustness.v2` | 2→2 据置 | **上げるべき** | 同上 |
| v0.3.0→v0.4.0 | `source-input-manifest.v1` | 1→1 据置 | **上げるべき** | `inputScope` を追加・`required` へ |
| v0.3.0→v0.4.0 | `validation-results.v1` | 1→1 据置 | **上げるべき** | `results[].schema` の型に `null` |
| v0.4.0→v0.4.1 | `validation-results.v1` | 1→1 据置 | **上げるべき** | 4 項目追加（すべて `required`） |
| v0.4.0→v0.4.1 | `test-counts.v1` | 1→1 据置 | **上げるべき** | 8 項目追加（うち 7 が `required`） |

**7/7 で「上げるべきだった」。実際は 7 件とも据え置いた。7 件すべてが違反である。**

**対照（条文が黙る側）**: 同じ走査で、中身が変わらなかった schema 17 本は「無変更」と判定された。
新設 2 本（`source-input-scope.v1` / `source-verification-result.v1`）は比較対象なしとして分離した。
条文がすべてを「上げるべき」と言っているわけではない。

**この 7 件の「上げるべき」に実害があったか**（机上でなく実際に下流が止まるか）:

```
旧 schema を pin して、その版の実物 artifact を検証   実害 9/9（artifact 単位）
陰性対照（同じ経路で「通ってしまう」が出るか）        7/7 で「通ってしまう」
```

陰性対照が 0 だったら、9/9 は「道具が常に止まると言っていただけ」になる。7/7 出たので、
この検証経路は両方の答えを返せる。**条文の「上げるべき」に空振りは無かった。**

なお対照の中身は、v0.4.0 の schema で v0.4.1 の profile / sensitivity / robustness / manifest を
検証すると 4 件とも通る、というものである。**v0.4.1 release notes の「profile を読む経路は
止まりません」は、この実測で裏が取れている。**

### 1-6. 据え置き可になる実例（合成でないもの）

条文に判別力があることを、repo の実ファイルでも確かめた。

`topology-robustness.v2` には、**`properties` にあるが `required` に無く、しかも全 artifact に
必ず存在する項目が 5 つ**ある（`configurationsBuildFailed` / `configurationsFullInsertionNotOk` /
`generatedAt` / `generatedBy` / `stepMm`）。これを `required` へ入れる変更を実際に作って条文に当てた。

```
判定: 据え置き可・記録あり
  NARROW  $  required: 値が増えた [5 項目]
```

**版を上げずに済む変更は実在する。**（同種の候補は `test-counts.v1` に 1・
`validation-results.v1` に 1・`source-input-manifest.v1` に 1 ある。）

ただし第5条のとおり、これをやると**過去 release の artifact が新 schema で落ちる**。
v0.5.0 で同時にやるかは別判断とし、この設計では**やらない**（版を上げる変更と混ぜると、
下流が「何で止まったか」を切り分けられなくなる）。

### 1-7. 条文が届かない範囲（第6条の中身）

| 範囲外のもの | なぜ届かないか | どう扱うか |
|---|---|---|
| 配布ファイル名 | schema は自分のファイル名を知らない | `contractMigration.renamedAssets` へ（§3-2） |
| 値の意味の変更 | 型も enum も同じまま意味だけ変わる（v0.1.1 の `spreadStatus` がこれ） | `changes[].kind = "meaning-changed"` |
| 生成手順・入力範囲 | `source-input-scope.v1.json` 側の話 | 既存の scope 定義で扱う |
| 数値の妥当性 | schema は「形」しか見ない | `validate:profiles` の semantic 検査 |

---

## 2. `contractMigration` の設計

### 2-1. 今の形の問題

`contractMigration` は**すでに 2 本の schema にある**（`half-plug-topology-profile.v2` と
`topology-robustness.v2`）。残る 4 本（`event-sensitivity` / `source-input-manifest` /
`validation-results` / `test-counts`）には無い。

今の形は **1 つの遷移（v1→v2）を書く単一オブジェクト**である。そこへ、
**版を据え置いたまま入れた変更が後から混ぜ込まれている。**

```json
"addedFields": [
  { "field": "schemaId", "introducedIn": "schemaVersion 2" },
  { "field": "sensitivitySummary.basis", "introducedIn": "v0.1.2 (追加のみ)" },
  { "field": "provenance.inputFiles[].role に \"input-scope\" を追加",
    "introducedIn": "v0.3.0 フォローアップ P1-2 (追加のみ)" }
]
```

問題は 3 つ。

1. **`field` が機械可読でない。** 最後の 1 件は項目名ではなく日本語の文である。
   下流が `field` で引くことも、schema と突き合わせることもできない。
2. **`introducedIn` が自由文。** `"schemaVersion 2"` と `"v0.1.2 (追加のみ)"` と
   `"v0.3.0 フォローアップ P1-2 (追加のみ)"` が同じ列に混在している。
3. **「据え置いたまま変えた」という事実が記録されていない。**
   `addedFields` に並ぶだけで、それが v2 と同時に入ったのか、v2 のあとで版を据え置いたまま
   入れたのかが区別できない。**まさに今回問題になっている情報が落ちている。**

### 2-2. 新しい形

`contractMigration` を、**遷移 1 件のオブジェクトから、変更の履歴を持つオブジェクトへ**変える。

```json
"contractMigration": {
  "schemaId": "half-plug-topology-profile.v3",
  "previousSchemaId": "half-plug-topology-profile.v2",
  "fromSchemaVersion": 2,
  "toSchemaVersion": 3,
  "breaking": true,
  "policy": {
    "document": "docs/SCHEMA_VERSIONING_POLICY.md",
    "policyVersion": 1,
    "decisionRule": "language-subset",
    "note": "判定は新旧 schema だけで行う。artifact の中身は見ない"
  },
  "consumerAction": "schemaVersion で分岐すること。2 を期待する実装は 3 を受け取ったら停止する。",
  "renamedAssets": [
    { "from": "half_plug_topology_profile.v2.trs_jack_trs.json",
      "to":   "half_plug_topology_profile.v3.trs_jack_trs.json" }
  ],
  "history": [
    {
      "shippedIn": "v0.4.0",
      "schemaVersionAtTheTime": 2,
      "schemaVersionShouldHaveBeen": 3,
      "versionWasHeld": true,
      "policyVerdict": "BUMP",
      "recordedRetroactivelyIn": "v0.5.0",
      "changes": [
        {
          "kind": "enum-value-added",
          "effect": "WIDEN",
          "schemaPointer": "/properties/provenance/properties/inputFiles/items/properties/role/enum",
          "instancePath": "provenance.inputFiles[].role",
          "added": ["input-scope"],
          "reason": "入力の範囲定義 source-input-scope.v1.json が入力になった"
        }
      ]
    },
    {
      "shippedIn": "v0.5.0",
      "schemaVersionAtTheTime": 3,
      "versionWasHeld": false,
      "policyVerdict": "BUMP",
      "changes": [
        { "kind": "const-changed", "effect": "UNDECIDABLE",
          "schemaPointer": "/properties/schemaVersion/const", "from": 2, "to": 3 },
        { "kind": "field-reshaped", "effect": "WIDEN",
          "schemaPointer": "/properties/contractMigration",
          "reason": "この履歴そのもの。単一遷移から history 形式へ" }
      ]
    }
  ]
}
```

**要点は 4 つ。**

| | |
|---|---|
| `schemaPointer` | **artifact ではなく schema への JSON Pointer。**機械で schema 実物と突き合わせられる |
| `effect` | `WIDEN` / `NARROW` / `NEUTRAL` / `UNDECIDABLE`。条文の判定器が出す値をそのまま入れる |
| `versionWasHeld` + `schemaVersionShouldHaveBeen` | **据え置いた事実を明示する。**ここが今回足りていなかった |
| `recordedRetroactivelyIn` | いつ遡って書いたか。**記録が事後であることを隠さない** |

`kind` の enum（案）:
`field-added` / `field-removed` / `field-renamed` / `field-reshaped` /
`enum-value-added` / `enum-value-removed` / `enum-value-renamed` /
`type-widened` / `type-narrowed` / `constraint-tightened` / `constraint-loosened` /
`const-changed` / `meaning-changed` / `description-only`

### 2-3. 遡って記録する中身（6 本ぶん・実測から起こしたもの）

| schema | `history` の件数 | 遡って書く内容 |
|---|---:|---|
| `half-plug-topology-profile` v2→**v3** | 3 | ① v0.1.1 据置: `events[].spreadStatus` の値を 3 つ改名（`meaning-changed`・既存記録から移設）② **v0.4.0 据置: `role` に `input-scope`**（enum-value-added / WIDEN）③ v0.5.0 昇格 |
| `event-sensitivity` v1→**v2** | 2 | ① **v0.4.0 据置: `role` に `input-scope`** ② v0.5.0 昇格 |
| `topology-robustness` v2→**v3** | 2 | ① **v0.4.0 据置: `role` に `input-scope`** ② v0.5.0 昇格 |
| `source-input-manifest` v1→**v2** | 2 | ① **v0.4.0 据置: `inputScope` を追加し `required` へ**（field-added / WIDEN ＋ constraint-tightened / NARROW） ② v0.5.0 昇格 |
| `validation-results` v1→**v2** | 3 | ① **v0.4.0 据置: `results[].schema` の型に `null`**（type-widened / WIDEN） ② **v0.4.1 据置: 4 項目追加・すべて `required`** ③ v0.5.0 昇格 |
| `test-counts` v1→**v2** | 2 | ① **v0.4.1 据置: 8 項目追加・うち 7 が `required`** ② v0.5.0 昇格 |

太字が「版を据え置いたまま契約を変えた」記録である。**合計 7 件。**

### 2-4. 記録が実物とずれないための機械検査

`contractMigration` は手で書くと必ず腐る（現に腐っていた）。**記録と schema 実物を突き合わせる
テストを同時に入れる。**

| 検査 | 内容 | 空振りしないか |
|---|---|---|
| ① pointer 実在 | `changes[].schemaPointer` が新旧いずれかの schema に実在する | 存在しない pointer を 1 件入れて落ちることを確認 |
| ② 判定の一致 | 各 `history` 項目について、**その 2 つの tag の schema 実物へ条文の判定器を当て**、`policyVerdict` と `effect` が記録と一致する | `effect` を 1 件書き換えて落ちることを確認 |
| ③ 網羅 | 判定器が出した変更のうち、`history` に無いものがあれば落ちる | 変更を 1 件消して落ちることを確認 |
| ④ 据置きゼロ | v0.5.0 以降、`versionWasHeld: true` の新規追加が出たら落ちる | 据置き記録を 1 件足して落ちることを確認 |

**②が本体である。**これがあると、記録は「そう書いた」ではなく「schema 実物とこう一致した」になる。
判定器（条文の機械判定）は現在 scratchpad にあるので、実装時に `scripts/schemaLanguageDiff.mjs` として
repo へ入れ、この 4 検査から呼ぶ。

**変異は検査の外側から入れる**（メモリ `feedback_mutate_outside_detector_scope.md`）。
①〜④の変異は `contractMigration` 側だけでなく、**schema 側を書き換えて記録が追随しないことを
確かめる**方向でも作る。

---

## 3. 下流の停止回数と順序

### 3-1. 回数 — **6 回**（pin ごと）

v0.4.1 の schema を pin したまま v0.5.0 の artifact を検証した実測。

```
止まった pin      = 6 / 6
止まった artifact = 8 / 8
対照（手を加えない v0.4.1 artifact を同じ pin で検証） = 0 件
```

| pin | 止まる artifact |
|---|---:|
| `half-plug-topology-profile.v2` | 2 |
| `event-sensitivity.v1` | 2 |
| `topology-robustness.v2` | 1 |
| `source-input-manifest.v1` | 1 |
| `validation-results.v1` | 1 |
| `test-counts.v1` | 1 |

**下流が直す分岐の数 = pin の数 = 6。**
v0.2.0 のときは profile だけを上げたので pin 1 つ = **1 回**だった（下流報告の「必ず一度停止する」と整合）。
v0.4.0 は 5 本を据え置いたまま壊したので、**下流は版で分岐できず、不明項目や enum で潰れた**。

### 3-2. 止まり方 — 8 件すべて「版が違う」で止まる

```
half-plug-topology-profile.v2  × 2 件   版で止まる=YES  不明項目でも止まる=YES
event-sensitivity.v1           × 2 件   版で止まる=YES  不明項目でも止まる=YES
topology-robustness.v2         × 1 件   版で止まる=YES  不明項目でも止まる=YES
source-input-manifest.v1       × 1 件   版で止まる=YES  不明項目でも止まる=YES
validation-results.v1          × 1 件   版で止まる=YES  不明項目でも止まる=YES
test-counts.v1                 × 1 件   版で止まる=YES  不明項目でも止まる=YES
```

13 本すべてが `schemaVersion` を `const` の `required` として持っている。
**下流は「不明な項目がある」ではなく「版が 2 でなく 3 だ」という読める形で止まる。**
v0.4.0 の壊し方（版が同じまま中身だけ変わる）とは、ここが決定的に違う。

### 3-3. 索引は止まらない — 入口が残る

`trs-jack-3d-release-index.v1` は版を上げない。実測で、profile の版を固定していないことを確認した。

```
profileSchemaVersion : {"type":"integer","minimum":1}   ← const ではない
profileSchemaId      : {"type":"string"}                ← const ではない
```

**したがって索引は 6 本の bump を跨いでも読める。**下流は索引から
「今回どの schema が何版になったか」を先に読み、そのうえで 6 つを順に直せる。

### 3-4. schema 検査では捉えられない停止 — ファイル名が 8 件変わる

**これは ajv では出ない。**索引の `assets[].filename` は自由文字列なので、
名前が変わっても索引自体は通る。しかし `assets[].filename` は
「**配布名。契約の一部である。下流の lock はこれでファイルを引く**」と schema 自身に書いてある。

| 種別 | 件数 | 例 |
|---|---:|---|
| profile 本体 | **2** | `half_plug_topology_profile.v2.trs_jack_trs.json` → `.v3.` |
| schema ファイル | **6** | `event-sensitivity.v1.schema.json` → `.v2.` |

**profile 本体 2 件が効く。**下流の lock がファイル名で引いていると、
schema 検査に到達する前に「ファイルが無い」で止まる。**これが 7 番目の停止**であり、
条文の第6条（範囲外）に当たる。`contractMigration.renamedAssets` に機械可読で書く（§2-2）。

なお `sensitivity` / `topology-robustness` / `source-input-manifest` / `validation-results` /
`test_counts` の artifact 名には版数が入っていないので、**名前は変わらない。**

### 3-5. 直す順序

**下流が「何を信じてよいか」が確定する順に直す。**

| 順 | pin | 理由 |
|---:|---|---|
| 0 | （索引） | **上げない。**ここから「今回何が何版になったか」を読む。入口が壊れていないことが前提 |
| 1 | **`source-input-manifest` v1→v2** | 配布物を信じてよいかを決める検証の入口。ここが通らないと他を直す意味がない |
| 2 | **`half-plug-topology-profile` v2→v3** | 本体。**ファイル名も変わる**（§3-4）ので lock の書き換えを伴う。2 artifact |
| 3 | **`event-sensitivity` v1→v2** | profile の `sensitivitySummary` が指す先。profile を直したあとで整合を見る |
| 4 | **`topology-robustness` v2→v3** | profile とは独立に読める。区間の端点規約を使う実装だけ影響 |
| 5 | **`validation-results` v1→v2** | producer の自己申告。読まなくても profile の取り込みは動く |
| 6 | **`test-counts` v1→v2** | 同上。最も後ろでよい |

1 と 2 が本線、3〜4 が付随、5〜6 は読んでいなければ何もしなくてよい。
**「6 回止まる」は最大値で、profile しか読まない下流は 2 回（manifest と profile）で済む。**
これは release notes の冒頭に書く。

---

## 4. source snapshot — オーダー §2 の選択

### 4-1. 実測

| 案 | 実サイズ | 収録 |
|---|---:|---|
| A. 入力 29 件だけの snapshot | 展開 **0.45 MB** / **tar.gz 0.12 MB** | 入力のみ |
| B. tag source archive を添付 | **8.94 MB** | 全 tree 215 ファイル |
| C.（測って出てきた第3案）入力 + `scripts/` + `schemas/` | **0.21 MB**（66 ファイル） | 入力 + 生成器 + schema |

B の内訳を測ると、**8.94 MB のうち大半が入力でも生成器でもない。**

```
1,331,055  artifacts/contact_sweep.json     ← 生成物
  695,699  docs/screenshots/04_section.png
  683,453  docs/screenshots/19_ios_safari_fault_presets.png
  660,368  docs/screenshots/18_ios_safari_half_inserted.png
  640,653  docs/screenshots/14_trrs_plug.png
  599,067  docs/screenshots/02_half_inserted.png
```

GitHub が自動生成する v0.4.1 の tarball を実際に落として 9,372,131 bytes を確認した
（手元の `git archive` 再現 9,377,772 bytes と 0.05% 差）。

### 4-2. 循環の整理 — 論点は循環ではなかった

オーダーは「循環の有無」で比べよと言うが、測ってみると**そこでは差がつかない。**

| | 循環するか |
|---|---|
| A（我々が作った snapshot を我々の hash と照合） | **する** |
| B を**我々が release asset としてアップロードする** | **する**（我々が作ったファイルである点は A と同じ） |
| B を**受け手が GitHub から自分で落とす** | **しない**（GitHub が tag から導出したもの） |

**producer が渡すものは、何であれ producer の申告である。**
B を添付する案は「本物の tag source だから循環しない」のではなく、
「受け手が GitHub から落とすなら循環しない」だけで、それは**今でもできる**（v0.4.1 で `gh` 依存を外し、
`--fetch github` が Node の `fetch` だけで動くようにした）。実際、v0.4.1 で受け手が止まったのは
**ネットワークが無かったから**であって、経路が無かったからではない。

したがって本当の論点は循環ではなく、**完全にオフラインの受け手が何をできるようになるか**である。

### 4-3. 受け手ができること

| | A（0.12 MB） | B（8.94 MB） | C（0.21 MB） |
|---|---|---|---|
| `inputDigest` を自分で再計算して manifest と突き合わせる | **できる** | できる | **できる** |
| 生成器のコードを読んで「その digest が何に使われるか」を確かめる | できない | できる | **できる** |
| schema を読んで artifact の形を検証する | できない | できる | **できる** |
| `npm ci` して artifact を再生成し byte 一致を見る | できない | **できない**（`npm ci` に通信が要る） | できない |
| 画面写真・生成物を見る | できない | できる | できない |

**B の 8.7 MB 増ぶんで増えるのは「画面写真と生成物が見られる」だけ**である。
再生成は B でもできない（`node_modules` が要る）。

### 4-4. 推奨 — **C（入力 + `scripts/` + `schemas/` の 0.21 MB）**

理由:

1. **A ができることを全部でき、B が実際に増やす価値をほぼ全部持つ。**
   受け手が本当にやりたいのは「hash が何を指しているか自分で辿る」ことで、それには生成器と schema が要る。
2. **サイズが A と同じ桁**（0.12 → 0.21 MB）。現行 bundle に足しても増分は誤差。
3. **B の 8.94 MB は、増えるぶんの中身が受け手の検証に使われない。**

条件（オーダー §2 の制約はそのまま守る）:

- **`inputDigest` の正本にしない。**正本は `source-input-manifest.json` のまま。
- artifact 自身に**限界を書く**。`isSelfConsistencyOnly: true` と、
  「これは producer の申告であり、受け手の独立検証を置き換えない」を明文で持たせる。
- **release notes に、GitHub から tag source を落として `--source` に渡す 3 行**を固定で載せる
  （ネットワークがある受け手はそちらが正しい。C はオフライン時の縮退経路である）。

**B を選ぶなら**、「我々がアップロードした tarball」ではなく
「release ページに GitHub が自動生成している Source code (tar.gz) を使え」と notes に書くだけでよい。
**それは asset を増やさずに今すぐできる**ので、C と B は排他ではない。両方やるのが最善で、
追加の配布物としては C を採る。

---

## 5. 影響範囲

| | |
|---|---|
| 版を上げる schema | **6 本**（+ 旧版ファイルは残置。過去 release の検証用） |
| 新規ファイル | `schemas/*.v{N+1}.schema.json` 6 本 / `docs/SCHEMA_VERSIONING_POLICY.md` / `scripts/schemaLanguageDiff.mjs` / `test/schemaVersioningPolicy.test.ts` / `test/contractMigration.test.ts` |
| 名前が変わる配布物 | **8 件**（profile 本体 2・schema 6） |
| `contractMigration` を新設する schema | **4 本**（event-sensitivity / source-input-manifest / validation-results / test-counts） |
| `contractMigration` を作り直す schema | **2 本**（profile / topology-robustness） |
| 遡って記録する違反 | **7 件** |
| 下流の停止 | **最大 6 回**（profile しか読まない下流は 2 回） |
| artifact 再生成 | **要る。**schema 変更は `inputDigest` に入る → **`profileId` が変わる** |
| release index | 版は上げない。`assets[].filename` と `profileSchemaVersion` が動く |
| 新しい配布物 | source snapshot（案 C・0.21 MB）1 件 |

**`profileId` はまた変わる。**下流は lock を作り直す必要がある。これは v0.4.0・v0.4.1 と同じ。

---

## 6. 未確認・限界

1. **条文の機械判定は保守的な近似である。**JSON Schema の言語包含は一般には決定不能なので、
   決められない変更（`pattern` の書き換え・`oneOf` の枝数変更・未対応キーワード）は
   すべて「上げる」側へ倒している。**「上げなくてよいのに上げる」方向の誤りは残る。**
   逆方向（上げるべきなのに据え置く）は、対応表に無いキーワードを検出して落とすことで塞いでいる。
2. **判定器は `$ref` を辿るが、循環参照は 50 段で打ち切る。**現在の schema に循環参照は無いが、
   将来入ったときに黙って通る可能性がある。実装時に「打ち切りが起きたら落とす」を入れる。
3. **`contractMigration` の遡及記録は事後の再構成である。**当時の判断記録ではない。
   `recordedRetroactivelyIn` でその旨を機械可読に持たせるが、**当時そう考えていたわけではない。**
4. **`meaning-changed`（値の意味だけ変わる）は機械判定できない。**v0.1.1 の `spreadStatus` の
   ような変更は、人間が気づいて書く以外にない。条文はここを守れない。
5. **停止回数 6 は「schema 検査に到達した場合」の数である。**ファイル名で引く下流は
   その手前で止まる（§3-4）。実際の下流が名前で引いているか URL で引いているかは未確認。
6. **本設計は実装していない。**測定に使ったスクリプトは scratchpad にあり、repo には入れていない。

---

## 7. 実装の可否

**この設計での実装可否を確認したうえで着手する。**

着手した場合の順序（1 回の再生成で済ませる）:

1. `docs/SCHEMA_VERSIONING_POLICY.md`（条文）と `scripts/schemaLanguageDiff.mjs`（判定器）
2. 判定器のテスト（合成 16 件 + 過去 7 件の遡及適用 + 対照）
3. schema 6 本を新版として作成（旧版は残置）
4. `contractMigration` を 6 本に新形式で記述（遡及 7 件を含む）
5. `contractMigration` の機械検査 4 種（§2-4）+ その変異テスト
6. 生成器・`validate:profiles`・`release:stage` を新ファイル名へ追随
7. **感度 → 頑健性 → profile → evidence を 1 回だけ再生成**
8. source snapshot（案 C）の生成と bundle への追加
9. README の機械照合を新版へ追随（`test/docs.test.ts`）
10. release notes に「6 回止まる・直す順序・profile だけなら 2 回」を冒頭へ

commit と tag / release は、これまでどおり別に承認を待つ。
