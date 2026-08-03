# Half-Plug Lab へ渡すもの — adapter 仕様

> この文書の HTML 版（同名 `.html`）は `npm run docs:html` で生成しています。**HTML を直接編集しないでください。**

作成 2026-08-02 ／ 対象 `Half-Plug Topology Profile v2`（2026-08-03 に v1 から更新）

統合オーダー §4 が Half-Plug 側へ求めている `integrations/trs-jack-3d/` の
初期マッピングを、**現在のコード体系で**書き起こしたものです。

このリポジトリは Half-Plug Lab 側を持っていないので、ここに置いた仕様を
向こうで実装してもらう形になります。

---

## 0. 先に — この profile は DSP 係数ではありません

渡しているのは「**どの端子がどの導体につながっているか**」という電気的な接続だけです。
音に関する項目（`acousticAnnotation`）は**参考分類**であって、
フィルタ係数でもゲインでもクロストーク量でもありません。

**やってはいけない変換**（統合オーダー §2 の禁止事項）:

| してはいけないこと | なぜ |
|---|---|
| `topologyClass` を係数へ直接写像する | 分類であって量ではない |
| `quality` を接触抵抗 Ω やゲインへ換算する | 相対スコアで、Ω に換算していない（profile に含めてもいません） |
| 1 機種の `nominalStartMm` を一般的な「挿入深度」として使う | §4-1 を読むこと。`normalized` も万能ではない |
| **`ground-open-differential` を自動的に L−R 係数へ変換する** | §2 を参照 |
| 未実測なのに「実物と同じ」と表示する | 全 profile が `verifiedPhysical: false` |

---

## 1. 渡す profile は 2 つあります

| ファイル | 中身 | 左右差分 |
|---|---|---|
| `half_plug_topology_profile.v2.trs_jack_trs.json` | 3極プラグ × 3極ジャック（Lumberg 実部品） | **現れない** |
| `half_plug_topology_profile.v2.trs_jack_trrs.json` | 3極プラグ × **4極ジャック** | **現れる**（`IV028` / 13.30〜13.52 mm） |

**再現したい音が出るのは後者だけです。**前者は「出ない」ことを
`absentTopologies` に記録した反証として持っています。

```bash
npm run export:half-plug -- --variant "TRS|JACK-TRRS"
```

---

## 2. 初期マッピング

**1 対 1 ではありません。**同じ `topologyClass` でも、`stabilityOverlay` と
`electricalRisk` の組み合わせで扱いが変わります。

| profile の `topologyClass` | Half-Plug の状態 | 備考 |
|---|---|---|
| `all-expected-functions-match` | Normal / seated | 通常再生。**機械的な完全挿入ではない**（下記）。v1 では `fully-seated` |
| `no-path` | Silent | 導通経路が無い |
| `one-sided` | One-sided contact | 片チャンネルのみ |
| **`ground-open-differential`** | **Floating return（本命）** | **§2-1 を必ず読むこと** |
| `ground-open-nondifferential` | Silent 相当 | 帰線が浮くが左右が同一節点。差分は生じない |
| `signal-to-return-short` | Miscontact / protection-dependent | **過渡音を作らないこと**（§2-2） |
| `on-insulator` | Open / fragmented | 絶縁帯上 |
| `wrong-conductor` | Miscontact | 誤った導体 |

`stabilityOverlay: "intermittent"` は**基底トポロジーと直交する重ね合わせ**です。
状態を別物に置き換えるのではなく、その状態の上に不安定性を乗せてください。

### 2-0. `all-expected-functions-match` は「肩が当たった」という意味ではありません

TRS×TRRS profile では `all-expected-functions-match` が **13.52 mm から**始まりますが、
機械的な完全挿入は **14 mm** です。

このクラスが意味するのは `reasonCode` のとおり
**`ALL_EXPECTED_FUNCTIONS_MATCH`**（機器が期待する全機能が正しい導体に届いた）だけで、
**プラグの肩がジャックへ当たったことではありません。**

UI で「物理的に完全に挿さっている」と表示しないでください。
機械的な完了を見たい場合は `nominalEndMm === fullInsertionDepthMm` で判定します。

> **v2 で改名しました。**旧名 `fully-seated` は「プラグ肩が当たった」と読めたためです。
> 差は `mechanicalInsertion.gapMm`（TRS×TRRS で 0.48 mm）として profile にも入っています。

### 2-1. `ground-open-differential` を自動で L−R 係数にしないでください

この状態は「帰線が浮き、L と R が別々の導体に届いている」という**電気的な接続の記述**です。
そこから何 dB 落ちて、どういう周波数特性になるかは、**このモデルは一切計算していません**。

- ドライバのインピーダンス、アンプの出力段、保護回路のどれもモデル化していません
- `audibleHypothesis`（「音量が落ち、左右の差分成分が残る」）は
  **回路構成からの定性的な推測**であって、実測ではありません
- `confidence: "low"` が付いています

3 帯域行列や 4 経路 FIR は、**実測 profile ID を介して別管理**してください
（統合オーダー §4）。トポロジーはどの実測 profile を選ぶかの**索引**であって、
係数そのものではありません。

### 2-2. `signal-to-return-short` で過渡音を作らないでください

電気的には出力短絡に近い状態で、実機の挙動はアンプの保護動作に依存します。
`electricalRisk: "short-circuit"` が付いており、`audibleHypothesis` は **`null`** です
（断定できないので空にしてあります）。

安全な DSP 表現（減衰・mono 化・mute など）へ写像し、
**クラックルやポップのような過渡音を生成しないでください。**

---

## 3. 本命の区間

`half_plug_topology_profile.v2.trs_jack_trrs.json` の `IV028`:

```
nominalStartMm  13.30      normalizedStart  0.9500
nominalEndMm    13.52      normalizedEnd    0.9657
topologyClass   ground-open-differential
evidenceGrade   ASSUMPTION
safetyFlags     shortsSignalToReturn: false / shortsSignalToSignal: false
```

端子の状態:

| 端子 | 届いている導体 |
|---|---|
| L | Tip |
| R | Ring |
| **GND** | **なし（浮いている）** |

4極ジャックの帰線接点が、3極プラグの絶縁帯にちょうど落ちるためです。

### この区間の根拠 — 2026-08-02 に土台が変わりました

**4極ジャックを Lumberg 1503 28（JEITA RC-5325A 準拠）ベースへ組み直しました。**
それまでは接点位置 4 件が完全な架空値でしたが、いまは:

| | 区分 |
|---|---|
| 端子 6 本の軸位置 | **FACT**（図面の基板レイアウト記載） |
| 端子番号 ↔ 機能の対応 | **DERIVED**（成立する割り当てが 1 通りしか無い） |
| ブレーク接点 2 個 | **FACT**（本文と回路記号の両方に記載） |
| **接点そのものの軸位置** | **ASSUMPTION**（図面に断面図が無い） |

**「実在部品ベースになった」は「実測された」ではありません。**
[UNKNOWNS.md](../UNKNOWNS.md) §5-2 は閉じていません。

残った仮定は **1 つだけ**です — 接点が端子より何 mm 手前にあるか
（`trrs.jack.contact.beamOffset`、採用値 0、成立範囲 0〜1.3 mm）。

- **現象が起きること**は、この仮定の全域で成立します（0〜1.3 のどこでも区間が出る）
- **深さ**は仮定と**ほぼ 1:1 で動きます**

| beamOffset | 区間 |
|---:|---|
| **0（採用）** | **13.30〜13.52 mm** |
| 0.65 | 12.6 mm 付近 |
| 1.3 | 11.98〜12.20 mm |

つまり受け取り側にとっては、**「この状態は起きる」は使ってよく、
「13.30 mm で起きる」は ±0.7 mm 程度の幅を持つ**と考えてください。

### ⚠ 実在資料 2 件が逆を指しています

| 根拠 | Tip 接点の軸位置 | 差分区間 |
|---|---:|---|
| **本モデル**（Lumberg 1503 28 の**端子**位置） | 11.30 mm | 13.30〜13.52 mm |
| pro-SIGNAL PS000001（**接点**の寸法記入） | **12.75 mm** | **出ない** |

成否を決めるのは **Tip 接点が 12.6 mm より浅いかどうか**の 1 点です。
2 件は証拠の種類が違い（一方は端子、他方は接点そのもの）、資料だけでは決まりません。

**受け取り側への影響:**

- `IV028` を「実機で必ず起きる状態」として UI に出さないでください。
  `evidenceGrade: ASSUMPTION` と `physicalClaimStatus: "unverified"` は、
  この意味でも落とせません（§4）。
- ただし **DSP エミュレーションとしての価値は変わりません。**
  再現したいのは音であって、特定の実機の深さではありません。
  「この電気的状態がどう聞こえるか」は独立に有用です。

詳細 → [REAL_JACK_COMPARISON.md](REAL_JACK_COMPARISON.md)

---

## 4. プリセットへ持たせるメタデータ

統合オーダー §4 のとおり、Half-Plug 側のプリセットには次を持たせてください。

```
mechanismProfileRef      どの profile ファイルか
topologyIntervalId       IV028 など（**単独では意味を持たない。下の警告を読むこと**）
geometryInputDigest      profile の provenance.inputDigest ← **固定はこれで行う**
generatedFromCommit      profile の provenance.generatedFromCommit（参考値）
calibrationProfileId     実測した音響 profile（別管理）
evidenceGrade            profile の interval から引き継ぐ
physicalClaimStatus      未実測なら "unverified"
```

### ⚠ `sourceRevision` で固定しないでください（2026-08-03）

`sourceRevision` は残していますが、意味を**「生成元 source commit」**と定義し直し、
**一致の要求はしません。**

理由は自己参照です。**artifact を含めてコミットすると HEAD が変わります。**
生成した瞬間に正しかった `sourceRevision` が、コミットした瞬間に「古い」と判定されます。
監査（2026-08-03）で指摘された `sourceRevision: 5adf454` と HEAD `ba58b4c` の食い違いも、
半分はこれが原因でした。

代わりに **`provenance.inputDigest`** を使ってください。
**入力ファイルの中身だけ**から作った sha256 で、生成物自身は含みません。

| したこと | `generatedFromCommit` | `inputDigest` |
|---|---|---|
| 寸法を 1 文字直した | 変わらない（未コミットなら） | **変わる** |
| artifact だけ作り直してコミットした | **変わる** | 変わらない |
| 文書だけ直してコミットした | **変わる** | 変わらない |

`provenance.inputFiles[]` に path と sha256 が入っているので、
**受け取り側で digest を再計算して検算できます**（作り方は `inputDigestScope` にあります）。

### 4-1. `normalized` は profile 内の相対座標です

**「機種横断では normalized を使う」と書いていましたが、これは強すぎました。**

`normalized` は `depthMm / fullInsertionDepthMm` にすぎません。
**profile が違えば、同じ `normalized` が同じ電気状態を指す保証はありません。**
接点位置が変われば、同じ 0.95 でも別のトポロジーになります。

使ってよいのは次の 2 つです。

| ✅ | 同一 profile 内での UI 位置 |
| ✅ | profile 更新時に、`topologyClass` と併用して候補区間を引き直すとき |
| ❌ | 別 profile の `normalized` と直接比べて「同じ状態」とみなす |

### `workingTreeDirty` と `artifactKind` を見てください

| `artifactKind` | 意味 |
|---|---|
| `local` | 手元で生成したもの。**リポジトリにコミットされている profile はこちらです** |
| `release` | clean な入力から `--release` で生成した配布物 |

**`workingTreeDirty: true` の artifact を正本として取り込まないでください。**
入力に未コミットの変更がある状態で作られたもので、その入力は他の誰も再現できません。
`--release` は dirty な入力からの生成を拒否します。

**`evidenceGrade` と `physicalClaimStatus` を落とさないでください。**
落とすと、UI で「実物と同じ」と読める表示になってしまいます。

### ⚠ `intervalId` を単独の鍵として保存しないでください

`IV001`, `IV002`, … は**区間の並び順から機械的に振った番号**で、
**モデルが変わると同じ番号が別の状態を指します。**

2026-08-02 の 4極ジャック組み直しで、実際にこれが起きました。

| | 旧 | 新 |
|---|---|---|
| 本命の区間 | `IV019` / 12.90〜13.12 mm | **`IV028`** / 13.30〜13.52 mm |
| 区間の総数 | 21 | **30** |

**`schemaVersion` は 1 のままです。**項目も型も意味も変えていないためで、
変わったのは**データ**です。版で守るのではなく、次のように参照してください。

| | |
|---|---|
| ✅ 保存する | `profileId`（`trs-jack-3d:<variant>:<inputDigest 12桁>` の形）と `intervalId` を**セットで** |
| ✅ 再解決する | `profileId` が違ったら、`electricalTopology.topologyClass` と `normalizedStart/End` で引き直す |
| ❌ しない | `intervalId` だけを保存して、新しい profile へそのまま当てる |

> **`profileId` の作り方が変わりました（2026-08-03）。**
> 旧: `trs-jack-3d:<variant>:<revision 12桁>` ／ 新: `trs-jack-3d:<variant>:<inputDigest 12桁>`
>
> revision を使うと、**artifact を含めてコミットするたびに ID が変わりました。**
> 中身は同じなのに「別の profile」に見えるので、引き直しが繰り返されます。
> 逆に、寸法を直しても commit していなければ ID が変わりませんでした。
> `inputDigest` は「何から作ったか」なので、**変わるべきときにだけ変わります。**

**`events[].eventId` も同じ扱いです。**`eventId` は
`STATE_CHANGE:JC_RING:BREAK_CLOSED->BREAK_OPEN#1` のように、
**何がどの状態からどの状態へ変わったか**で作ってあります（`label` の文言からは作りません。
文言を直しただけで ID が変わらないようにするためです）。
末尾の `#n` は同じ遷移が挿入中に複数回起きるための連番で、
**手前に事象が増えると後ろがずれます。**`profileId` とセットで保存してください。

### ⚠ `events[].spreadMm` の意味が変わりました（2026-08-03）

2026-08-02 版までの `spreadMm` は、**感度解析の `kind` 単位の集計をそのまま各事象へ複製していました。**
`STATE_CHANGE` は 1 回の挿入で 29 件出るので、29 件すべてに同じ `−0.88〜14 mm` が付き、
たとえば Ring のブレーク接点にも帰線接点用の幅が付いていました。**下流では誤情報です。**

現在は `spreadStatus` で 3 つを区別します。

| `spreadStatus` | `spreadMm` | 意味 |
|---|---|---|
| `MODEL_SWEEP_EVENT_SPECIFIC` | 値あり | **その事象そのものを走査で求めた幅** |
| `MODEL_SWEEP_NOT_EVENT_SPECIFIC` | `null` | `kind` 単位の集計しか無く、この事象へは配れない |
| `NOT_ANALYZED` | `null` | 解析していない |

**どれも「動かない」の意味ではありません。**
`kind` 単位の集計は捨てず、`sensitivitySummary.aggregateSpreadByKind` に残してあります。
そちらを個々の事象へ当てはめないでください。

### ⚠ v0.2.0 は `schemaVersion: 2` です（**破壊的変更**）

**読み込む前に版で分岐してください。**`schemaVersion === 1` を期待する実装は、
2 を受け取ったら停止してください。語彙の対応表は profile の `contractMigration` にあります。

| | 旧 | 新 |
|---|---|---|
| `schemaVersion` | 1 | **2** |
| `topologyClass` | `fully-seated` | **`all-expected-functions-match`** |
| ファイル名 | `half_plug_topology_profile.v2.*` | **`half_plug_topology_profile.v2.*`** |

ファイル名も変えたのは、**release lock が `filename` で引く**ためです。
名前が同じまま契約だけ変わると、lock が同じ名前で非互換な内容を指します。

**`fully-seated` を改めた理由**は、「プラグ肩が当たった」と読めるからです。
実体は `reasonCode` のとおり `ALL_EXPECTED_FUNCTIONS_MATCH` でしかありません。
名前だけでは同じ誤読が起きるので、差を数字でも出します。

```
TRS×TRRS  電気的に全機能が揃う  13.52 mm   ← all-expected-functions-match の開始
          機械的な完全挿入      14.00 mm   ← mechanicalInsertion.completeAtMm
          差 (gapMm)             0.48 mm
```

### ⚠ `spreadStatus` の語を変えました（v0.1.1・**破壊的変更**）

| 旧（v0.1.0） | 新（v0.1.1） |
|---|---|
| `MEASURED` | **`MODEL_SWEEP_EVENT_SPECIFIC`** |
| `NOT_EVENT_SPECIFIC` | **`MODEL_SWEEP_NOT_EVENT_SPECIFIC`** |
| `NOT_MEASURED` | **`NOT_ANALYZED`** |

**`MEASURED` は実物の測定と誤認されます。**実際にはモデルのパラメータを振った結果です。
`sensitivitySummary.basis` にも `MODEL_PARAMETER_SWEEP` と書いてあります。

> **⚠ v0.1.1 ではこの `basis` が実在しませんでした。**
> この文書は v0.1.1 の時点で `sensitivitySummary.basis` を約束していましたが、
> **profile にその項目はありませんでした**（読むと `undefined` になります）。
> 次の release から実在します。**この文書と artifact の食い違いは、
> 文書と artifact を突き合わせる検査が `sensitivitySummary` に無かったために起きました。**

### 目標トポロジーの頑健性は、別の artifact にあります（次の release から）

`artifacts/topology-robustness.trs_jack_trrs.json`。

**`spreadMm` を「この状態が起きる確率」や「頑健性」として読まないでください。**
あちらは「イベントが**何 mm で**起きるか」の幅で、こちらは「**そもそも存在するか**」です。

| | 値 |
|---|---|
| 走査 | 8 軸・5,184 構成（Tip 位置・beam offset・他接点位置・プラグ導体境界・パッド幅・導通閾値） |
| 目標が現れた構成 | 成立 3,920 のうち **2,300**（58.7%） |
| 区間幅 | 最小 0.02 / 中央 0.24 / 最大 0.86 mm |
| 目標が消える単独水準 | **0 件**（他を組み替えれば現れる） |
| PS000001 の図面値 | **目標なし** |

> **58.7% は実物で起きる確率ではありません。**この構成空間の中での割合であり、
> 走査範囲の取り方は任意です（`searchRangeBasis` に根拠と任意性を書いてあります）。
> `physicalProbabilityClaim: false` を artifact 自身が持っています。

「消える単独水準が 0 件」を「どの仮定も効かない」と読まないでください。
効いている軸は `presenceByLevel` に出ます（Tip を +2mm ずらすと 71% → **24%**）。

`IV028` の `evidenceGrade` は **`ASSUMPTION` のまま**です。頑健性を測っても仮定は事実になりません。

### lock は索引から作れます（次の release から）

`trs-jack-3d-release-index.v1.json` を同梱します。**報告文から手で転記しないでください。**

| 項目 | 意味 |
|---|---|
| `releaseTag` / `releaseCommit` | **null なら未 tag。**evidence をコミットしてから tag を打つので、生成時点では知りようがない |
| `evidenceBuiltAtCommit` | 索引を作った時点の HEAD |
| `artifactGenerationCommit` | **profile の生成 commit。**`releaseCommit` とは違う |
| `artifactGenerationCommits` | **生成 commit は 1 つではない。**release 工程が 2 段階なので、profile と感度・頑健性で違う |
| `profiles[variantId]` | `filename` / `profileId` / `inputDigest` / `sha256` / `generatedFromCommit` / `sensitivityAsset` |
| `assets[]` | 配布物の一覧と sha256。**索引自身は含みません**（自己参照になるため。索引の sha256 は `SHA256SUMS` にあります） |

> **`generatedFromCommit` と `releaseCommit` の一致を要求しないでください。**
> artifact をコミットしてから tag を打つ順序なので、artifact は必ず tag より前の commit から作られます。

### 頑健性の窓は端点を 3 つに分けました（`schemaVersion: 2`・**破壊的変更**）

| 旧（v1） | 新（v2） |
|---|---|
| `fromMm` | **`startMm`** |
| `toMm` | **`lastSampleMm`** |
| （無し） | **`endExclusiveMm`** |

**旧 `toMm` は「最後に当たった標本の位置」で、区間の終端ではありませんでした。**
profile の `nominalEndMm`（13.52 mm）と 1 刻みずれて見えます。

```
startMm        13.30   ← profile の nominalStartMm と一致
lastSampleMm   13.50   ← 観測の最後の点。**区間の終端ではない**
endExclusiveMm 13.52   ← profile の nominalEndMm と一致
widthMm         0.22
```

`windowEndConvention: "EXCLUSIVE"` を持たせてあります。UI で最後の標本と区間境界を混同しないでください。

### 感度の「有無」は 2 つに分かれます（次の release から）

`sensitivitySummary.available` は **global summary があるかどうかだけ**を表します。
**これが `false` でも event 単位の幅は存在しえます。**

| 項目 | 意味 |
|---|---|
| `globalSummaryAvailable` | variant 固有の総合解析（プラトー間隔・Tip 橋絡しきい値・挿抜力）があるか。3極のみ `true` |
| `eventSpreadAvailable` | event 単位の model-sweep 幅があるか |
| `available` | `globalSummaryAvailable` の別名（後方互換のために残しています） |

TRS×TRRS は `available: false` でありながら幅を 7 件持ちます。
v0.1.1 まで 1 つの真偽値に潰していたため、**「感度情報が一切無い」と読まれました。**
`available` を感度情報の有無の判定に使わないでください。

移行は次のとおりです。

```
if (s === 'MEASURED')            -> 'MODEL_SWEEP_EVENT_SPECIFIC'
if (s === 'NOT_EVENT_SPECIFIC')  -> 'MODEL_SWEEP_NOT_EVENT_SPECIFIC'
if (s === 'NOT_MEASURED')        -> 'NOT_ANALYZED'
```

### ⚠ v0.1.0 の TRS×TRRS の感度情報は誤りでした

**v0.1.0 では、TRS×TRRS profile に 3極モデルの感度が入っていました。**

`FIRST_BREAK_OPEN` は名目 8.48 mm なのに、付いていた幅は 8.06〜8.06 mm（3極の値）でした。
**名目値が自分の幅の外にある**という、あり得ない状態です。

v0.1.1 では variant ごとに感度を測り直し、
**`variantId` が profile と一致しない感度 artifact は取り込みません（fail-closed）。**

| | v0.1.0 | v0.1.1 |
|---|---|---|
| TRS×TRRS の `FIRST_BREAK_OPEN` の幅 | 8.06〜8.06（3極の値） | **7.82〜8.64**（4極を測り直した値） |
| 振った寸法 | `jack.contact.sleeve.*`（3極のキー） | **`trrs.jack.contact.*`** |
| `bridgeDepthJointRangeMm` 等 | 3極の値が入っていた | **`null`**（3極の解析なので出さない） |

> **v0.1.0 を取り込み済みの場合、`events[].spreadMm` と `sensitivitySummary` は
> 読み捨てて、v0.1.1 を取り直してください。**区間・`electricalTopology`・provenance には
> 影響していません。

---

## 5. 深さの窓が 0.2 mm しかない件

本命の区間は **0.22 mm 幅**で、挿入ストローク 14 mm の **1.6 %** です。

**これは Half-Plug 側で解くべき課題であって、機構の問題ではありません。**
Half-Plug は音を DSP で再現するものなので、プラグを物理的にその深さで
保持する必要はありません。深さは UI 上のパラメータです。

したがって扱いは次のようになります。

| | |
|---|---|
| ❌ しなくてよい | プラグを 0.2 mm 精度で保持する機構を作る |
| ✅ すべきこと | **区間を直接選べるようにする**（連続スライダーだけにしない） |

連続スライダーだけを置くと、**ストロークの 1.6 % を狙って合わせる操作**になり、
本命の状態にほとんど当たりません。`intervals[]` は区間の列なので、
**区間そのものを選択肢として提示する**のが素直です。

> 物理的に再現しようとする場合は別の話で、0.2 mm を保つのは容易ではありません。
> ただしその場合、4極ジャックの接点位置が仮定である以上、
> **狙うべき深さがそもそも分かりません。**先に実測が要ります
> （[VERIFICATION_PLAN.md](VERIFICATION_PLAN.md)）。

---

## 6. 受け取り側で必ず確認してほしいこと

- [ ] `modelLimitations.verifiedPhysical` が `false` であること（現状すべて false）
- [ ] `dataLicense.attribution` を表示または同梱すること（CC BY 4.0）
- [ ] **`provenance.inputDigest` を固定して参照すること**（`sourceRevision` でも `main` でもない。→ §4）
- [ ] **`provenance.workingTreeDirty` が `false`** の artifact だけを正本にすること
      （リポジトリにコミットされている profile は `true` です。release asset を待ってください）
- [ ] `schemaVersion` が 1 であること。**項目・型・意味の**破壊的変更だけを v2 へ上げます
- [ ] **`intervalId` を単独で保存していないこと**（§4 の警告。数値データの変更で指す先が変わります）
- [ ] `breakStates` を読むこと（4極側は 2026-08-02 から `BRK_TRRS_RING` / `BRK_TRRS_TIP` が入ります）
- [ ] `absentTopologies.absent` を読み、**無い状態を UI に足さないこと**
- [ ] `sensitivitySummary.eventSpreadSource.variantId` が profile の `variantId` と一致すること
      （一致しないものは取り込まない。v0.1.0 ではここが食い違っていました）
