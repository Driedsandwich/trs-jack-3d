# trs-jack-3d v0.4.1 — 非阻害フォローアップ開発オーダー

作成日: 2026-08-04  
対象: `Driedsandwich/trs-jack-3d v0.4.1`

## 0-1. 受領時の検証記録（2026-08-04・trs-jack-3d 側）

**受け取った内容は実測で裏を取りました。**自己申告は使っていません。

| 確認 | 方法 | 結果 |
|---|---|---|
| 配布 zip | `shasum -c` | **一致**（3,067,910 bytes・CRC OK・512 ファイル） |
| このオーダー本体 | zip 内から直接読み出し | sha256 `9205caede85ff659…` |
| 数値・構造の主張 | 配布 24 件と 1 件ずつ照合 | **14 項目すべて一致・食い違い 0** |
| 新しい門「`byFile` 合計 == `total`」 | 配布物で計算 | **476 == 476**（19 ファイル） |
| `testEvidence` の一致 | `validation-results` と `test_counts` を突き合わせ | **一致** |
| ライセンスの内訳 | `LICENSING.md` を実測 | **MIT / CC BY 4.0 / SIL OFL の 3 分割は正しい** |
| メーカー CAD 非収録 | 拡張子で全走査（328 ファイル・対照 `.json` 148 件） | **0 件。正しい** |
| README が現行を案内 | **v0.4.1 tag の実物**を確認 | **正しい**（v0.4.1 / Profile v2 / `.v2.*.json` / 索引） |

照合した主な値（すべて一致）:

```
SHA256SUMS 登録 23 / bundle 24 ファイル / 索引 assets 22
profileId  TRS  trs-jack-3d:TRS|JACK-TRS:796498ebba63
           TRRS trs-jack-3d:TRS|JACK-TRRS:b61bce36516c
TRS  intervals 23 / events 32 / ground-open-differential 0
TRRS intervals 30 / events 36 / ground-open-differential 1   合計 53 / 68
IV028  13.30–13.52mm  normalized 0.95–0.965714  ASSUMPTION
       RETURN_OPEN_L_AND_R_ON_DISTINCT_CONDUCTORS
test  total 476 / failed 0 / failedSuites 0 / skipped 0 / exitCode 0 / allPassed true
      vitest 4.1.10 / node v22.22.3
artifactValidationStatus PASS / releaseReadinessStatus READY / reasons []
検証ツール  外部コマンドは git archive / git rev-parse の 2 つだけ（gh の呼び出し 0 件）
```

### 0-2. v0.4.1 で直した 2 点が、実際に届いていました

受領した `SOURCE_INPUT_VERIFICATION_RESULT` は、こちらのツールの出力そのままです。

```json
{
 "toolVersion": 3,
 "status": "SOURCE_UNAVAILABLE",
 "reason": "GitHub へ接続できなかった (https://api.github.com/…/tarball/v0.4.1): fetch failed"
}
```

**(b) `toolVersion` が入っています。**v0.4.0 の同じ記録には版がありませんでした。

**(a) エラーが `spawnSync gh ENOENT` ではなく `fetch failed` になっています。**
`gh` 依存は外れており、今回止まったのは**受け手の環境にネットワークが無い**ためです。
上流の不具合ではありません（オーダー §2 の認識と一致）。

### 0-3. §2 について — ネットワークが無い環境では、現状どちらの経路も使えない

`--fetch github` も、release ページの "Source code (tar.gz)" を落とす経路も、通信が要ります。
**完全にオフラインの受け手は、いまのところ独立検算に着手できません。**

配れる大きさは実測しました。

| 案 | 実サイズ | 性質 |
|---|---:|---|
| 入力 29 件だけの snapshot を同梱 | **0.45 MB** | **循環に近い**——こちらが渡したファイルを、こちらが記録した hash と突き合わせるだけ |
| tag source tarball を添付物として渡す | **8.9 MB** | **本物の tag source**。循環しない |

**snapshot は「manifest が自分の入力と自己整合しているか」しか言えません。**
それでも `SOURCE_UNAVAILABLE`（何も見ていない）よりは強く、
「記録した hash が、記録した中身と合っているか」は確かめられます。
同梱するなら、**その限界を artifact 自身に書く**こと（`isSelfConsistencyOnly` のような明示）。
`inputDigest` の正本にしないという §2 の条件はそのまま守ります。

**どちらを採るかは v0.5.0 の作業として判断します。**

---


## 0. 結論

Half-Plug Labへのstatic integrationを止める問題はない。v0.4.1は採用可能であり、blocking修正は不要。

以下はv0.5.0以降の契約安定性と外部利用性を上げる非阻害事項である。

## 1. v0.5.0 — Schema migration

予定どおり次をversion bumpする。

```text
half-plug-topology-profile.v3
event-sensitivity.v2
topology-robustness.v3
source-input-manifest.v2
```

必須条件:

- 全artifactに`contractMigration`
- renamed/added/removed fieldsのmachine-readable一覧
- consumerAction
- v0.4.1→v0.5.0 test vector
- v0.4.1のconsumerがv0.5.0を明示的に拒否する試験
- v0.5.0対応consumerがv0.4.1をmigrationまたは明示拒否する試験
- Release indexから契約versionとSchema hashを取得可能にする

## 2. Source verificationの自己完結性

今回の受け手環境ではbuilt-in fetchでもsource archiveを取得できず、`SOURCE_UNAVAILABLE`になった。これは上流不具合ではない。

任意改善:

- Release assetとして29入力だけのread-only source snapshotを同梱
- またはtag source archiveの取得・展開手順をRelease notesへ短く固定
- snapshotを同梱する場合も、producer自己申告とrecipient verificationの区別を維持
- source snapshotをinput digestの正本にしない

## 3. Read-only CI（任意）

現在のlocal release gateは強い。外部貢献を受ける場合に限り、read-only CIを追加する。

```text
npm ci
typecheck
test
build
validate:profiles
check:stale
check:vacuity
release evidence dry-run
```

条件:

- GitHub Actionsはfull commit SHA pin
- permissions read-only
- secret不要
- publish/releaseしない
- generated artifact差分があれば失敗

## 4. SECURITY / support policy（任意）

外部利用者が増えた場合に追加する。

- 対応中Release
- 脆弱性報告経路
- artifact contractのsupport window
- physical modelの非保証
- breaking migration policy

## 5. Reusable model core（需要確認後のみ）

現在は`private: true`のViteアプリで、static JSONが下流統合の正本である。runtime model reuseの実需要が確認された場合のみ分離する。

```text
packages/model-core
```

要件:

- React / Three.js / Zustand非依存
- Browser / Node対応
- versioned exports
- artifact exporterとのgolden parity
- SemVer

## 6. 物理検証

実物入手後に次を行う。

```text
導通測定
→ contact observation manifest
→ fit
→ held-out validation
→ acoustic MIMO measurement
```

実測がモデルと合わない場合、反証または別profileとして保存し、既存反対証拠を削除しない。

## 7. 変更禁止

- v0.4.1 assetの上書き
- `verifiedPhysical`の無根拠な昇格
- topologyからDSP係数を生成
- robustnessを発生確率と表現
- 反対証拠の削除
- 未承認のpush/tag/release
