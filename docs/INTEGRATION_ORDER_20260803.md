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
| ✅ | **P0-1** artifact provenance | **完了**（受入試験 7 項目・→ §1） |
| ✅ | **P0-2** TRRS の basis / limitations | **完了** |
| ✅ | **P0-3** `events[].spreadMm` を event 固有に | **完了** |
| ✅ | **P0-4** 電気トポロジー分類の一本化 | **完了**（→ §1） |
| ✅ | **P0-5** 探索結果の表現を弱める | **完了**（→ §1） |
| ✅ | **P0-7** 文書と公開表現の整合 | **完了** |
| ⏸ | **P0-6** Draft-07 の完全検証（Ajv） | **依存追加の承認待ち**（→ §3） |
| ⏸ | **P0-8** immutable release | **tag / push の承認待ち**（→ §3） |

**着手できる P0 は出揃いました。**残る 2 件はどちらも承認事項です。
ただし、**リポジトリにコミットされている profile は `artifactKind: "local"` /
`workingTreeDirty: true`** です（開発中に生成しているため）。
Half-Plug Lab 側が正本にできるのは、clean な入力から `--release` で作った
release asset だけです。それは P0-8（承認待ち）で作ります。

---

## 1. 完了した項目

### P0-1 — artifact provenance

**指摘の核心は「revision では固定できない」ことでした。**
監査時の HEAD は `ba58b4c`、コミット済み profile は `sourceRevision: 5adf454` で、
その間にモデルデータが変わっていました。

かといって `sourceRevision === HEAD` を要求してはいけない、ともオーダーは書いています。
**artifact を含めてコミットすると HEAD が変わるので、自己参照になります。**
生成した瞬間に正しかった値が、コミットした瞬間に「古い」と判定されてしまいます。

#### 入力そのものを指紋にした

`provenance.inputDigest` は**入力ファイルの中身だけ**から作る sha256 です。

| したこと | `generatedFromCommit` | `inputDigest` |
|---|---|---|
| 寸法を 1 文字直した（未コミット） | 変わらない | **変わる** |
| artifact だけ作り直してコミットした | **変わる** | 変わらない |
| 文書だけ直してコミットした | **変わる** | 変わらない |

digest の対象は **21 ファイル**です。

| role | 件数 | 中身 |
|---|---:|---|
| `schema` | 1 | profile の schema |
| `generator` | 2 | exporter と provenance |
| `model-data` | 9 | `src/data/**` |
| `model-code` | 7 | `src/model/**` |
| `lockfile` | 1 | `package-lock.json` |
| `sensitivity-input` | 1 | `artifacts/sensitivity.json`（`spreadMm` の元データ。**入力として読んでいる**） |

**生成物自身は入りません。**入れると自己参照に戻ります。

#### `profileId` も digest から作るようにした

旧 `trs-jack-3d:<variant>:<revision 12桁>` → 新 `trs-jack-3d:<variant>:<inputDigest 12桁>`。

revision 版は、**中身が同じでもコミットのたびに ID が変わり**、
逆に**寸法を直しても未コミットなら ID が変わりません**でした。どちらも誤りです。

#### `SOURCE_REVISION` の素通しを廃止した

2026-08-03 まで、環境変数があれば無条件でそれを書いていました。
古い値を渡したまま「その改訂から作った」と名乗れます。
実際の HEAD と食い違っていて `--unsafe-revision-override` も無ければ、**止めます。**

#### 受入試験 7 項目

| | 受入条件 | どこ | 変異試験 |
|---|---|---|---|
| 1 | clean checkout から生成 | `npm run verify:provenance`（実走）＋ 規則は単体テスト | ✅ |
| 2 | 入力 1 文字変更で `inputDigest` が変わる | `test/provenance.test.ts` | ✅ |
| 3 | artifact だけの再コミットでは変わらない | 同上 | ✅ |
| 4 | dirty tree で release モードが失敗 | 同上 | ✅ |
| 5 | 同一入力・同一日で byte-identical | 同上（実際に 2 回生成して比較） | ✅ |
| 6 | 根拠件数と生成元データの件数が一致 | 同上 | ✅ |
| 7 | stale な `SOURCE_REVISION` で失敗 | 同上 | ✅ |

**7 項目すべて、検査を壊すと落ちることを変異試験で確かめました**
（生成物を入力に混ぜる／digest が中身を見ないようにする／release 判定を骨抜きにする／
出力へ現在時刻を混ぜる／台帳の区分を 1 件変える／食い違う revision を素通しにする）。

> **項目 1 だけスイートに入れていません。**
> 開発中は入力を直している最中なので作業ツリーが汚れており、
> 「clean なら dirty=false」を実物で確かめられるのはコミット後だけです。
> **作業ツリーの状態で成否が変わるテストをスイートに入れると、
> 「落ちていても気にしない」テストが 1 つ生まれます。**
> それは空振りと同じくらい悪いので（→ CONTRIBUTING §7）、別コマンドにしました。

#### 項目 1 の実走記録（2026-08-03・`aac0084`）

```
  HEAD aac008421ea7 から clean な checkout を作る
  inputDigest: 91a0e62a4eca / dirty: false / release

  ✓ workingTreeDirty が false
  ✓ artifactKind が release
  ✓ generatedFromCommit が HEAD と一致
  ✓ revisionOverride が false
  ✓ inputDigest が 64 桁の hex
  ✓ inputFiles が 10 件以上
  ✓ 生成物自身が入力に入っていない

  手元の artifact: dirty=true / local / digest 91a0e62a4eca
  clean checkout : dirty=false / release / digest 91a0e62a4eca
  → digest が一致。手元の artifact は clean な入力から作られている
```

**`workingTreeDirty` と `inputDigest` は別の種類の事実です。**
前者は「生成した瞬間の作業ツリーの状態」、後者は「何から作ったか」です。
上の実走では、手元の artifact が `dirty: true` を記録しているのに
digest は clean checkout と一致しました。生成後に同じ入力をコミットしたためです。
**固定に使うべきなのは digest のほう**である、ということがそのまま出ています。

> **上の digest `91a0e62a4eca` は `aac0084` 時点の値です。**現在の値とは違います。
> そのあと schema に 1 行足したためで、schema は入力なので digest が変わるのが正しい挙動です。
> **この記録は「その時にこう出た」であって、現在の値の表ではありません。**
>
> コミット済みの profile は現在 `workingTreeDirty: false` / `artifactKind: local` です。
> `release` の artifact は P0-8（承認待ち）で作ります。

#### 受入試験 3 の実証

作り直した profile をコミットする前に、作業ツリーで確かめました。

```
$ git status --short
 M artifacts/half_plug_topology_profile.v1.trs_jack_trs.json
 M artifacts/half_plug_topology_profile.v1.trs_jack_trrs.json

$ npm run export:half-plug
  inputDigest: 91a0e62a4eca / dirty: false / local
```

**artifact が 2 件とも変更されているのに `dirty: false`、digest も不変。**
これが「artifact を含めてコミットしても自己参照にならない」ということです。

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

### P0-4 — 電気トポロジー分類が 5 か所に散っていた

**指摘より多く見つかりました。**「帰線が浮き、L と R が別々の導体に届いている」
という同じ判定が、**5 か所**に書かれていました。

| | 場所 |
|---|---|
| 1 | `src/model/circuit.ts` の `predictAcoustic` |
| 2 | `scripts/searchTopology.ts` の `isStrictDifferenceSignal` |
| 3 | `scripts/compareRealJack.ts` の `differenceWindows` |
| 4 | `test/realJackComparison.test.ts` の `differenceWindowCount` |
| 5 | `test/trrs.test.ts` の左右差分カウンタ |

`src/model/topology.ts` の `classifyElectricalTopology()` を唯一の正本にし、
5 か所すべてをそこへ向けました。`isStrictDifferenceSignal` は削除しました。

#### 指摘どおり、説明文が旧実装のまま残っていました

`searchTopology.ts` に「`predictAcoustic` は判定順の都合で、L と R が同じ導体に
落ちていても `GROUND_OPEN` と分類される」と書かれていました。
**その挙動は 2026-08-02 に直っています**（`circuit.ts` が両者を分けた）。
逆向きの陳腐化そのものなので削除し、復活しないようテストで固定しました。

#### 一本化して初めて分かった 2 件

**① 同じ数を 2 つの名前で報告していました。**
`usableWitnesses` と `strictDifferenceSignal` は**どちらも 1,338 件**でした。
目標が「厳密な差分信号」そのものになった時点で、後者は定義上すべて前者に一致します。
独立した裏付けがあるように読めるので、`strictDifferenceSignal` を廃止し、
**廃止したこと自体を `removedMeasures` として artifact に残しました。**

**② 短絡の種類を取り違えていました。**
`safetyFlags.shortsSignalToSignal` を
**「`TIP` と `RING` に同時接触」という導体名**で判定していました。
導体名は位置であって機能ではありません（OMTP では Ring2 と Sleeve の機能が入れ替わります）。
`shortsSignalToReturn` も実体は「どれかの接点が 2 本に触れている」＝橋絡でした。
分類器の出力へ差し替えた結果、profile に
**`signal-to-signal-short` と `on-insulator` が現れるようになりました**
（従来はどちらも `signal-to-return-short` に丸められていました）。

#### 層を分けました

`topologyClass` を `acousticAnnotation` から `electricalTopology` へ移しました。
電気的な事実（`topologyClass` / `reasonCode` / `openSignals` / `confidenceBoundary`）と、
未検証の聴感の仮説（`audibleHypothesis` / `electricalRisk` / `confidence`）を別の入れ物にします。

> **受け手への影響**: `acousticAnnotation.topologyClass` は
> `electricalTopology.topologyClass` へ移動しました（adapter 文書 §4 に記載）。

---

### P0-5 — 「作れる」「市販品のまま」を名乗っていた

| 旧 | 新 |
|---|---|
| `realizablePadWidth` | **`passesPadWidthHeuristic`** |
| `needsNoModification` | **`matchesCurrentNominalParameters`** |

`heuristic: { name: 'minimumPadWidth', thresholdMm: 0.3, source: null, manufacturingVerified: false }`
を添え、**0.3 mm に出典が無いこと**を機械可読にしました。

README の見出しも
「半挿しにすると、**無改造で**左右差分が残ります」→
「半挿しで左右差分が残る区間は、**モデル上の候補です**」へ直しました。

**反対証拠を同じ可視性で置きました。**README のその表の直下に、
PS000001（Tip 12.75 → 区間 0 件）と Lumberg 1503 28（Tip 11.30 → 区間あり）が
逆を指していることを表で置いています。artifact 側にも
`realizability.counterEvidence` を追加しました。

variant ごとに `variantId` / `basePartOrConstructedProfile` / `sourceBasis` /
`unverifiedAssumptions` / `representativenessDisclaimer` を記録しました
（断り書きが 1 本だと 3極×3極の話に見えてしまうため）。

---

## 2. 未着手（次にやること）

**着手できる P0 は残っていません。**

P1（contact observation manifest）は実物の入手が前提で、
P2（3D 同期 API）は static 統合が安定してからと、オーダー自身が定めています。

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
