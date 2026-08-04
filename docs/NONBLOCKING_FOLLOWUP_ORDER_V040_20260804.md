# trs-jack-3d v0.4.0 フォローアップ開発オーダー

作成日: 2026-08-04  
対象: `Driedsandwich/trs-jack-3d`

## 0-1. 受領時の検証記録（2026-08-04・trs-jack-3d 側）

**受け取った内容は実測で裏を取りました。**自己申告は使っていません。

| 確認 | 方法 | 結果 |
|---|---|---|
| 配布 zip | `shasum -c` | **一致**（2,915,564 bytes・CRC OK・469 ファイル） |
| このオーダー本体 | zip 内から直接読み出し | sha256 `26a9ef573612fa96…` |
| 数値・構造の主張 | 配布 24 件と 1 件ずつ照合 | **25 項目すべて一致・食い違い 0** |
| 指摘 P0-1（`allPassed: false`） | 公開 tag の artifact を確認 | **正しい**（こちらも公開前に自分で気づき、作業指示 §0 に訂正を書いていた） |
| 指摘 P0-3（README 陳腐化） | 全 tag の README を走査 | **正しい。しかも指摘より深刻**（下の 0-3） |
| 指摘 P1-1（schema hash 変更） | v0.3.0 と v0.4.0 の実ファイルを hash | **4 件すべて一致。向きも正しい** |

照合した主な値（すべて一致）:

```
SHA256SUMS 登録 23 / bundle 24 ファイル / 欠落 0 / 余剰 0
profileId  TRS  trs-jack-3d:TRS|JACK-TRS:f925561fead8
           TRRS trs-jack-3d:TRS|JACK-TRRS:4923277389e6
releaseCommit  ab803e6b99356f4c73f789e31bc2b90e74f5ce3f
生成 commit    e396af761e41(感度2・頑健性1) / d6ed1b2b6dce(profile 2) / 42a16bcd062a(evidence 3)
TRS  intervals 23 / events 32 / ground-open-differential 0
TRRS intervals 30 / events 36 / ground-open-differential 1   合計 53 / 68
IV028  13.30–13.52mm  normalized 0.95–0.965714  ASSUMPTION
       RETURN_OPEN_L_AND_R_ON_DISTINCT_CONDUCTORS
mechanicalInsertion  TRS 12.34 → 14.00（gap 1.66）
入力 29 件 / required 9 / allowedGenerated 3 / excludedOutputs artifacts / notCovered 5
```

`SHA256SUMS` の「23」を最初 46 と読み違えたのは**こちらの数え間違い**です。
このファイルはコメント行を 23 行持ちます（データ行 23・コメント/空行 23・計 46）。

### 0-2. schema hash の指摘は、向きも含めて正しい

**変わっていないという疑いを持って測り直しましたが、4 件とも申告どおりでした。**

| schema | v0.3.0 | v0.4.0 |
|---|---|---|
| `half-plug-topology-profile.v2` | `6b13f5…` | `ecc48e…` |
| `event-sensitivity.v1` | `8d4b87…` | `b859a1…` |
| `topology-robustness.v2` | `9c2e3c…` | `13a30e…` |
| `source-input-manifest.v1` | `b5b1ab…` | `15a905…` |

「同じ schemaId / version のままファイルが変わっている」という指摘はそのとおりです。
こちらは「追加のみで沈黙して壊れない」と書きましたが、
**旧 schema を pin した consumer が拒否する時点で実質的に破壊変更**という読みのほうが正確です。

### 0-3. README の陳腐化は、指摘より 3 版ぶん古い

指摘は v0.4.0 の README を見たものですが、全 tag を走査すると**一度も正しかったことがありません。**

| tag | README が案内する配布物 |
|---|---|
| v0.1.1 | **v0.1.0** |
| v0.2.0 | **v0.1.1** |
| v0.3.0 | **v0.1.1** |
| v0.4.0 | **v0.1.1** |

`half_plug_topology_profile.v1.*.json` と「Half-Plug Topology Profile v1」も残っています。
**release のたびに直す手順が無い**のが原因で、P0-3 は文言修正ではなく機械照合が要ります。

### 0-4. こちら側で新たに見つけたこと（オーダーに無い）

**1. 同梱した検証ツールの network 経路が `gh` に依存している。**

受領した `SOURCE_INPUT_VERIFICATION_RESULT` は、こちらのツールの出力そのままでした。

```
status  SOURCE_UNAVAILABLE
reason  GitHub から取得できなかった: spawnSync gh ENOENT
```

**判定は正しい**（取れなかったことを不一致に潰していない）。
だが `--fetch github` は `gh` を呼ぶので、`gh` の無い環境では使えません。
Node 18 以降には `fetch` が入っているので、外部コマンドなしで取得できます。
`--source` 経路は動くはずですが、**道具を配った意味を半分にしています。**

**2. `toolVersion` が早期終了の出力に入っていない。**

成功・不一致の出口にしか入れておらず、
`SOURCE_UNAVAILABLE` / `MANIFEST_UNAVAILABLE` / `NOTHING_TO_VERIFY` の 3 経路には
入っていません（受領した JSON にも無い）。
**記録を受け取った側が、どの版の道具の出力かを判別できません。**

---

## 0. 結論

Half-Plug Labへのv0.4.0 static integrationを止める問題はない。

一方、リポジトリ本体を外部利用者へ安定して提示するには、次の2段階を推奨する。

```text
v0.4.1: release evidenceとREADMEの修正（互換patch）
v0.5.0: Schema versioningの是正（破壊release）
```

v0.4.0のassetは上書きしない。

## 1. P0 — v0.4.1

### P0-1. `test_counts.json`を最終テスト実行と原子的に結合する

現在のv0.4.0 release asset:

```text
total 467
skipped 0
allPassed false
```

原因は、失敗状態でcount artifactを作り、その後テストを直してもartifactを再生成しなかったこと。

#### 必須対応

`test_counts.json`へ次を追加するか、別のtest-run evidenceを導入する。

```text
passed
failed
skipped
total
allPassed
testCommand
exitCode
runner
runnerVersion
nodeVersion
startedAt
finishedAt
generatedFromCommit
testOutputSha256
```

release stagingを次の一連操作にする。

```text
1. final testを実行
2. exit codeとmachine-readable resultを取得
3. 同じresultからtest_countsを生成
4. allPassed == true / failed == 0を確認
5. test artifactの生成commitとrelease入力を固定
6. release stageへ進む
```

禁止:

- test countを先に生成して後からテストだけ直す
- `total`だけでstalenessを判定する
- release notesでartifactのfalseをtrueに読み替える
- v0.4.0 assetを置換する

#### 回帰試験

1. 2件FAIL状態でartifact生成→release stage拒否
2. FAILを修正したがartifact未更新→拒否
3. totalが同じでもallPassed/failed/exitCodeが古ければ拒否
4. test file追加・削除でstale検出
5. test runner version変更を記録
6. `validation-results`がtest resultと矛盾すれば拒否

### P0-2. release validationをtest evidenceとcross-checkする

現在、`validation-results.json`は11/11 PASSでも、`test_counts.json.allPassed=false`を許容する。

release readiness用の意味規則を追加する。

```text
releaseReady =
  validationResults.allPassed
  && testCounts.allPassed
  && testCounts.failed == 0
  && testCounts.exitCode == 0
  && testCounts.generatedFromCommit is expected
```

Schema validationとrelease readinessを別名で出す。

```text
artifactValidationStatus
releaseReadinessStatus
```

### P0-3. READMEのHalf-Plug節を最新化する

v0.4.0 tagのREADMEは次を案内している。

```text
release v0.1.1
Half-Plug Topology Profile v1
half_plug_topology_profile.v1.*.json
```

次へ更新する。

```text
latest supported release: v0.4.0またはrelease indexを正本にする手順
profile schema: v2
profile filenames: half_plug_topology_profile.v2.*.json
source input scope: 29 files
release lock: release indexから生成
```

過去releaseのknown issueは履歴節へ分離する。

#### 文書回帰試験

- READMEのlatest supported tagがrelease staging設定と一致
- Profile Schema versionがrelease indexと一致
- artifact filenameがrelease indexに存在
- READMEに旧profile v1を「現行」として記載しない
- release indexから期待値を構築し、手入力のdigestを減らす

### P0-4. v0.4.1 release

添付:

- 修正済みtest evidence
- validation results
- release index
- SHA256SUMS
- known issue/migration note

v0.4.0はimmutableに保つ。

## 2. P1 — v0.5.0 Schema契約

### P1-1. 互換性を壊すSchema変更ではversionを上げる

v0.3.0→v0.4.0で、同じSchema versionのまま次が変更された。

- provenance role enumへ`input-scope`を追加
- source-input-manifestで`inputScope`を必須化

旧Schemaをpinしたconsumerは新artifactを拒否するため、実質的に破壊変更である。

次のいずれかを採用する。

#### 推奨A

```text
half-plug-topology-profile.v3
 event-sensitivity.v2
 topology-robustness.v3
 source-input-manifest.v2
```

`contractMigration`へ旧版からの変更を記録する。

#### 代替B

provenance roleを外部拡張可能な文字列にし、未知roleを保全して読み飛ばせる設計へ変更する。ただし必須field追加は別versionを必要とする。

### P1-2. Schema versioning policyを文書化する

最低限:

```text
同じschemaId/version:
- optional field追加のみ
-既存値の意味を変えない
- enum拡張をconsumerが拒否する場合は破壊変更扱い

version bump必須:
- required field追加
- enum rename/remove/additionで旧consumerが失敗
- field meaning変更
- constraint強化
```

Schema file hashはrelease lockで固定するが、hash固定はversioningの代替ではない。

## 3. P2 — 再現環境

`inputScope.notCovered`にある次をrelease evidenceへ記録する。

```text
node version
npm version
OS/architecture
locale
timezone
relevant environment variables
```

推奨asset:

```text
toolchain-environment.v1.json
```

これはinputDigestへ混ぜるか、少なくとも再現条件として別途固定する。

## 4. P2 — CI

手動release順序の取り違えを減らすため、read-only CIを導入する。

実行:

```text
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
npm run validate:profiles
npm run check:stale
npm run check:vacuity
release evidence dry-run
```

要件:

- Actionはfull commit SHAへ固定
- write permissionなし
- release/publishしない
- secret不要
- generated artifact差分があれば失敗

## 5. P3 — reusable model core（必要時のみ）

現在は`private: true`のViteアプリであり、npm libraryではない。

外部プロジェクトからruntime modelを直接使う需要が確認された場合のみ、次を分離する。

```text
packages/model-core
```

要件:

- React/Three/Zustand非依存
- Node/Browser両対応
- versioned exports
- topology classifierとartifact exporterのgolden parity
- SemVer

Half-Plugの現段階ではstatic JSONで足りるため、先行実装しない。

## 6. P3 — 物理検証

実物を入手後:

```text
導通測定
→ contact observation manifest
→ 1点fit / held-out検証
→ 挿入・抜去方向を分離
→ 同じ状態で音響MIMO測定
```

次が揃うまで`verifiedPhysical`をtrueにしない。

- 反復導通測定
- state boundaryの不確実性
- PS000001反対証拠との比較
- fit残差
- held-out予測

## 7. 完了報告で必要な情報

### v0.4.1

```text
fix commit
release tag
README latest-contract test
test-run evidence fields
stale-test mutation result
release readiness cross-check result
asset SHA-256
```

### v0.5.0

```text
new schema IDs/versions
contract migrations
old consumer rejection tests
new consumer import tests
release index and hashes
```
