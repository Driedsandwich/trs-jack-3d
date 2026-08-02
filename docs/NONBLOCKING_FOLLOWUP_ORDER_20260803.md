# trs-jack-3d v0.1.1 非阻害フォローアップ開発オーダー

作成日: 2026-08-03  
対象: `Driedsandwich/trs-jack-3d`  
対象release: `v0.1.1`

## 0. 結論

v0.1.1はHalf-Plug Labのstatic mechanism integrationに使用可能であり、追加修正を統合の停止線にはしない。

以下は、次回の保守releaseまたはSchema v2で対応すると再現性・意味明瞭性が上がる非阻害項目である。v0.1.1 assetは上書きしない。

---

## 1. P1 — sensitivity artifact単体のprovenance

### 現在

両sensitivity assetは次を記録する。

```text
generatedFromCommit = ba2ad6cc7f9287cb5daa38fda153bce0948c57d1
```

release commitは:

```text
eeda5f1c28b9223430606de61dbbb1f9f8f19d2a
```

profile側はvariant別sensitivity assetのSHA-256を`provenance.inputFiles[]`へ入れ、profile input digestでexact bytesを固定している。このため下流importは阻害されない。

一方、sensitivity artifact単体では、何のsource filesから生成したかを再計算できない。

### 推奨対応

sensitivity artifactへprofileと同型の縮小provenanceを追加する。

```text
provenance:
  generatorVersion
  generatedFromCommit
  workingTreeDirty
  artifactKind
  inputDigestAlgorithm
  inputDigest
  inputFiles[]
  command
  artifactDate
```

入力候補:

```text
scripts/sensitivityEvents.ts
src/data/**
src/model/**
package-lock.json
variant-specific settings
```

要件:

- 生成物自身をdigestへ入れない
- variant別input digest
- dirty treeのrelease生成を拒否
- exact release assetとsource input digestを別概念として保持
- profile側の`eventSpreadSource`にsensitivity input digestを保持

これは`generatedFromCommit == release commit`を要求するものではない。自己参照を避け、入力内容で固定する。

---

## 2. P1 — sensitivity artifact専用Schema

### 現在

releaseにはprofile Schemaはあるが、次のasset専用Schemaはない。

```text
sensitivity.trs_jack_trs.json
sensitivity.trs_jack_trrs.json
```

Half-Plug側では、`variantId`、`analysisScope`、`basis`、走査軸、config数、`byKind`、profileの`eventSpreadSource`との一致を独自検査した。

### 推奨対応

追加:

```text
schemas/event-sensitivity.v1.schema.json
```

最低必須:

```text
schemaVersion
variantId
analysisScope
basis
generatedFromCommit
sweptParameters
sweep
byKind
```

意味規則:

- `basis == MODEL_PARAMETER_SWEEP`
- `configurationsUsable > 0`
- `shippedInsideSweptRange == true`
- `minMm <= maxMm`
- profileのvariantと一致
- profileのevent-specific spreadが`byKind`と一致

release assetと`SHA256SUMS`へSchemaを追加する。

---

## 3. P1 — 感度availabilityの分離

### 現在

TRS×TRRS profileは:

```text
sensitivitySummary.available = false
```

だが、7件のevent-specific model-sweep spreadを持つ。

現在の`available`は「TRS固有の総合summaryがあるか」を意味するが、「感度情報が一切無い」と読める。

### 推奨対応

Schema v2または後方互換fieldで分離する。

```text
sensitivitySummary:
  eventSpreadAvailable: true
  globalSummaryAvailable: false
  basis: MODEL_PARAMETER_SWEEP
```

既存`available`を残す場合は、descriptionでglobal summary限定と明記する。

notesの:

```text
感度情報は出していない
```

に相当する表現は、event spreadとの矛盾を避けて次へ変える。

```text
variant固有のglobal summaryは出していない。
event-specific model-sweep spreadはeventSpreadSourceから提供する。
```

---

## 4. P1 — 目標トポロジーの存在・区間幅に対する多軸ロバストネス

### 現在

v0.1.1のevent-specific感度はvariant別になり、TRS×TRRSでは主に次の2軸を走査している。

```text
trrs.jack.contact.sleeve.axialCenter
trrs.jack.contact.narrowPadWidth
```

これはイベント深度の局所感度として有用だが、Half-Plug Labが重視する:

```text
ground-open-differentialが存在するか
その区間幅がどの程度残るか
```

の総合不確実性を表すものではない。とくにTip接点位置、beam offset、他接点位置、plug geometry、break contact条件など、候補トポロジーの存否を反転させうる仮定を同時には走査していない。

PS000001のTip接点値では候補区間が消える反対証拠も残っているため、event spreadを候補トポロジーの実在確率または頑健性として解釈してはならない。

### 推奨対応

候補トポロジー専用のrobustness artifactを追加する。

```text
artifacts/topology-robustness.trs_jack_trrs.json
schemas/topology-robustness.v1.schema.json
```

最低限の出力:

```text
variantId
targetTopologyClass
basis: MODEL_PARAMETER_SWEEP
sweptParameters[]
parameterRanges
configurationsTotal
configurationsUsable
configurationsWithTarget
presenceFractionWithinConstructedSweep
intervalWidthMm:
  min
  median
  max
counterExamples[]
necessaryConditions[]
sourceEvidenceBoundary
physicalProbabilityClaim: false
```

要件:

- `presenceFractionWithinConstructedSweep`を実物で起こる確率と表現しない
- 探索範囲の根拠・任意性を明示する
- Tip位置、beam offset、主要接点位置を少なくとも含める
- PS000001等の反対証拠を同じartifactへ残す
- targetが0件でも正常な反証結果として保存する
- event depth spreadとtopology existence robustnessを別物として保持する
- 実物導通測定後はmodel sweepとempirical evidenceを別fieldへ保存する

この項目はstatic importの停止線ではない。Half-Plug側では、完了まで`IV028`を:

```text
UNVERIFIED_MECHANISM_MODEL
UNCALIBRATED_REFERENCE_CANDIDATE
```

として維持する。

---

## 5. P1 — Schema契約のversioning

### 現在

v0.1.0→v0.1.1で`spreadStatus` enumが破壊的変更されたが、profileは引き続き:

```text
schemaVersion: 1
```

である。

release asset hashを固定する下流では安全だが、`schemaVersion`だけを見るconsumerは旧profileと新profileを区別できない。

### 推奨対応

次のいずれかを採用する。

```text
A. schemaVersionを2へ上げる
B. contractRevisionを追加する
C. schema URIへversionを含める
```

推奨:

```text
schemaVersion: 2
schemaId: half-plug-topology-profile.v2
```

v1 assetはimmutableに維持する。

---

## 6. P2 — 用語の整理

### 6.1 `fully-seated`

現在のclassは、機械的な肩当たりではなく:

```text
ALL_EXPECTED_FUNCTIONS_MATCH
```

を意味する。

Schema v2候補:

```text
electrically-normal
all-expected-functions-match
```

または別field:

```text
mechanicalInsertionComplete: false
```

### 6.2 normalized

次を明示する。

```text
profile-local model-relative coordinate
not cross-profile physical equivalence
```

---

## 7. P2 — Release evidenceの自己完結性

### 現在

公式v0.1.1 tagの`artifacts/test_counts.json`は258件、現在のmainは260件である。ユーザー報告の260件はcurrent mainに対応する。

### 推奨対応

次回release assetへ次を含める。

```text
test_counts.json
validation-results.json
source-input-manifest.json
```

release notesでは:

```text
exact tag test count
post-release main test count
```

を混ぜない。

### package version

v0.1.1 tagの`package.json`は`0.1.0`である。private packageのため阻害しないが、release tooling用にtagと合わせるか、package versionを配布versionとして使わないことを明記する。

---

## 8. P2 — Source provenanceの下流検算

Half-Plug側のproduction importはrelease asset exact bytes、profile input digestの**記録値再計算**、Schemaを検証できる。

ただし、`provenance.inputFiles[].sha256`がtag sourceの実ファイルと一致するかを完全に独立検算するには、tag source treeが必要である。

次回releaseで任意に追加するもの:

```text
source-input-manifest.json
source archive SHA-256
```

またはGitHub tag source archiveを正本として、CIで全input file hashを再計算する。

---

## 9. 変更禁止

- v0.1.1 assetの差し替え
- `verifiedPhysical`の昇格
- event model sweepを物理公差と表現
- 反対証拠PS000001の削除
- topologyからDSP係数を生成
- mm/normalizedの普遍化
- 実測なしの音響一致主張
- 承認なしのpush/tag/release

---

## 10. 優先順位

```text
次回maintenance:
1. sensitivity artifact provenance
2. sensitivity artifact Schema
3. availability分離
4. target topology robustness
5. release test evidence

Schema v2:
6. spread contract versioning
7. fully-seated rename
8. normalized semantics
```

## 11. Half-Plug側の状態

```text
v0.1.1 production import: PASS
TRS negative control: imported
TRRS mechanism candidate: imported
v0.1.0 references: migrated
model-sweep event spreads: enabled with nonphysical label
physical/audio validation: pending
```
