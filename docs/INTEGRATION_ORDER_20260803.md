# 統合オーダー (2026-08-03) への対応状況

Half-Plug Lab 側から受けた監査オーダーへの対応記録です。
**「コードベースは採用、現在の artifact は保留」**という判断を受けています。

| | |
|---|---|
| オーダー作成日 | 2026-08-03 |
| 監査対象 revision | `ba58b4c`（当時の HEAD `dd05267` より **3 commit 手前**） |
| このページの更新 | 2026-08-03 |

> **監査対象が HEAD より手前だったので、8 件すべてを現在の木で引き直しました。**
> 「もう直っている」で済ませられた項目は **0 件**で、8 件とも当時のまま残っていました。
> 間の 3 commit は CONTRIBUTING と検査の追加で、profile や exporter に触れていません。

---

## 0. 現在の状態

| | P0 | 状態 |
|---|---|---|
| ✅ | **P0-2** TRRS の basis / limitations | **完了** |
| ✅ | **P0-3** `events[].spreadMm` を event 固有に | **完了** |
| ✅ | **P0-7**（一部）`DERIVED 39` の是正・adapter 文書の更新 | **完了** |
| ⬜ | **P0-1** artifact provenance | 未着手（→ §2） |
| ⬜ | **P0-4** 電気トポロジー分類の一本化 | 未着手（→ §2） |
| ⬜ | **P0-5** 探索結果の表現を弱める | 未着手（→ §2） |
| ⏸ | **P0-6** Draft-07 の完全検証（Ajv） | **依存追加の承認待ち**（→ §3） |
| ⏸ | **P0-8** immutable release | **tag / push の承認待ち**（→ §3） |

**この状態で Half-Plug Lab へ artifact を投入しないでください。**
オーダー §8 の最優先 3 件のうち P0-1 が残っています。

---

## 1. 完了した項目

### P0-2 — TRRS profile の basis が陳腐化していた

**指摘は正しく、しかも指摘より深いものでした。**

問題は「artifact を作り直していない」ことではありません。
**この artifact は 2026-08-02 に作り直されており**（`sourceRevision: 1f26460`）、
それでも旧説明が残っていました。原因は exporter 側の**直書き文字列**です。

```
source: '一次資料なし'
note:   '**4極ジャックは接点位置を含めて全て仮定である。** 図面もデータシートも入手できていない。'
```

4極ジャックを Lumberg 1503 28 ベースへ組み直したとき（08-02）、
`dimensions.json` と `jackContacts.trrs.json` は直したのに、
**exporter の文字列だけが取り残されました。**

さらに悪いことに、`test/halfPlugProfile.test.ts` が

```ts
expect(trrsProfile.jackBasis.note).toMatch(/接点位置を含めて全て仮定/)
```

と書いており、**テストが古い主張を守る側に回っていました。**

#### 直し方

直書きをやめ、**台帳の区分から組み立てる**ようにしました。台帳を直せば artifact が追随します。

| 項目 | 現在 | 根拠 |
|---|---|---|
| `partIdentityBasis` | 構成 profile。実在の単一品ではない | — |
| `externalGeometryBasis` | **ASSUMPTION** | 外形は 3極 1503 09 からの流用（1503 28 の外形図は未入手） |
| `terminalLayoutBasis` | **FACT** | 1503 28 基板レイアウト図 |
| `breakContactBasis` | **FACT** | 1503 28 回路記号に 2 個記載 |
| `internalContactGeometryBasis` | **ASSUMPTION** | 端子位置に拘束された仮定 |
| `electricalContinuityValidation` | 未実施 | |
| `acousticValidation` | 未実施 | |

`modelLimitations` も variant ごとに書き分けました
（従来はどの variant でも「Lumberg 1532 10 × 1503 09 の 1 組」と書いていました）。

**反対証拠は残しています。**`jackBasis.note` に
「PS000001 の断面図（Tip 12.75）を入れると左右差分の区間は消える。実在資料 2 件は逆を指している」
を残し、テストで固定しました。

#### 受入試験

| オーダーの受入条件 | 結果 |
|---|---|
| artifact 内に「一次資料なし」「全て仮定」が残らない | ✅ 両 profile とも 0 件 |
| 1503 28 の FACT と接点位置 ASSUMPTION が分離される | ✅ `detail` 7 項目 |
| `verifiedPhysical` は false のまま | ✅ |
| 実在品と constructed profile を同じ ID にしない | ✅ `constructedProfile: true` |
| 反対証拠の PS000001 比較を失わない | ✅ テストで固定 |

---

### P0-3 — `spreadMm` が event 固有でなかった

**指摘のとおりでした。**36 件の event のうち **29 件が `STATE_CHANGE`** で、
その 29 件すべてに同じ値が付いていました。

```
minMm: -0.88, maxMm: 14      ← 挿入ストローク全域。事実上「不明」と同じ
sweptParameters: [jack.contact.sleeve.axialCenter, jack.contact.sleeve.padWidth]
```

Ring のブレーク接点にも帰線接点用の幅が付いていました。

#### 直し方

**`kind` が 1 回しか出ない事象にだけ幅を付けます。**

| `spreadStatus` | 件数 | `spreadMm` |
|---|---:|---|
| `MEASURED` | 7 | 値あり（その事象そのものを測ったもの） |
| `NOT_EVENT_SPECIFIC` | 29 | `null`（集計しか無く、配れない） |
| `NOT_MEASURED` | 0 | `null` |

`kind` 単位の集計は捨てず、`sensitivitySummary.aggregateSpreadByKind` へ移しました。

`eventId` も導入しました。`label` の文言からは作りません。

```
STATE_CHANGE:JC_RING:BREAK_CLOSED->BREAK_OPEN#1
```

> **一意性の検査が、書いた直後に前提の誤りを捕まえました。**
> 最初は `kind:subject:from->to` だけで作りましたが、
> 帰線接点は絶縁帯を 2 本またぐので `OPEN->INSULATED` が 2 回起きます。
> 生成時の重複検査に落ちて **7 件の衝突**が分かりました。
> 検査を入れていなければ「一意な ID」を名乗ったまま出荷していました。
> 末尾の `#n` は**位置に依存します**（`intervalId` と同じ性質。adapter 文書 §4 に記載）。

---

### P0-7（一部） — 文書と公開表現

| 指摘 | 対応 |
|---|---|
| `docs/TEST_RESULTS.md` の `DERIVED 39` | ✅ 是正。件数を書かず artifact を正本にし、時点も明記 |
| adapter 文書が旧 `spreadMm` の契約を説明 | ✅ §4 に意味の変更と移行方法を追記 |
| 「無改造で左右差分が残る」等の表現を弱める | ⬜ **P0-5 と同時に行う**（→ §2） |
| generated HTML を MD から再生成 | ✅ `npm run docs:html` |

---

## 2. 未着手（次にやること）

| | 内容 | なぜ今回やらなかったか |
|---|---|---|
| **P0-1** | provenance（`inputDigest` / `workingTreeDirty` / `inputFiles[]`） | **最優先。** 単独で 1 回ぶんの作業量があり、P0-2/P0-3 で profile の中身が変わる前にやると作り直しになる。順序として後 |
| **P0-4** | `classifyElectricalTopology()` を model core へ置き、4 か所を統一 | `searchTopology.ts` の説明文が旧実装のまま（`predictAcoustic` の判定順で L/R が同導体でも `GROUND_OPEN` になる、という記述）。実装は 08-02 に直っており、**説明だけが古い**。分類の重複解消と同時に直す |
| **P0-5** | `realizablePadWidth` → `passesPadWidthHeuristic` 等の改名 | 改名は `searchTopology.ts` の出力キーを変えるので、**`npm run search:topology`（約 10 分）の再実行が要る**。P0-1 の provenance 実装と同じ回に走らせるのが効率的 |

**P0-4 について 1 点補足**: オーダーは「`searchTopology.ts` の説明が旧実装を前提にしている」と
指摘しています。現在の木で確認したところ、そのとおりでした（`scripts/searchTopology.ts:130-140`）。
`src/model/circuit.ts:227` には「2026-08-02 まで、この 2 つを区別せず `GROUND_OPEN` にまとめていた」
とあり、**実装は直っているのに探索側の説明とヘルパが取り残されています。**
これは §1 (c)「逆向きの陳腐化」そのものです。

---

## 3. 承認が要る項目

**この 2 件は着手しません。**

### P0-6 — Ajv（または Python jsonschema）の導入

現在の `test/halfPlugProfile.test.ts` は **自前の部分 validator** を使っています
（`required` / `type` / `enum` / `const` / `additionalProperties` / `$ref` / `minItems` /
`minimum` だけを実装。汎用ではないとファイル冒頭に明記してあります）。

| | |
|---|---|
| 何が要るか | dev dependency として `ajv`（draft-07）を 1 つ追加 |
| 影響 | dev-only。実行時依存には入らない。`package-lock.json` が変わる |
| 代替 | 現在の部分 validator を広げる（`pattern` / `oneOf` 等）。依存は増えないが、**汎用実装ではないという弱点は残る** |
| 戻し方 | `npm uninstall ajv` と `git checkout package.json package-lock.json` |

**新規の依存追加なので、承認をもらってから入れます。**

### P0-8 — immutable release（tag / GitHub Release）

オーダー自身が「このオーダーは tag、release、push の自動実行承認ではない」と書いています。
P0-1〜P0-7 の完了後に、対象・影響・可逆性・削除方法を示して別途確認します。

---

## 4. 採用が見送られた要求はありません

オーダーが「変更しない」と定めた項目
（都合よく差分信号を発生させる形状の追加／反対証拠の削除／`verifiedPhysical` の昇格／
DSP 係数生成／音響録音の保存／メーカー CAD の再配布／自動 push）は、
いずれもこのリポジトリの方針と一致しており、**今回の変更でも触れていません。**
