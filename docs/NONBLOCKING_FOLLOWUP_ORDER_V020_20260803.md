# trs-jack-3d v0.2.0 非阻害フォローアップ開発オーダー

作成日: 2026-08-03

## 0-1. 受領時の検証記録（2026-08-03・trs-jack-3d 側）

**受け取った内容は実測で裏を取りました。**自己申告は使っていません。

| 確認 | 方法 | 結果 |
|---|---|---|
| 配布 zip | `shasum -a 256` | 一致（2,682,383 bytes・CRC OK） |
| production import | **公開物そのもの**を下流の importer へ通した | **PASS**（区間 23/30・event 32/36） |
| 指摘 10.3（非配布 target 2 件） | `validation-results.json` と配布物を突き合わせ | **正しい**（`topology_search_difference_signal` と `real_jack_comparison` は検証対象だが配布していない） |
| 指摘 10.4（窓の終端表現） | robustness と profile を突き合わせ | **正しい**（`toMm` 13.5 は最後の標本位置で、profile の区間終端 13.52 と違う） |
| 数値（区間・event・gap・走査数・`IV028`） | 配布物と 1 件ずつ照合 | 全件一致 |

### こちらの見落としが 1 件ありました — 4 つ目の破壊点

引き継ぎ文では止まる場所を 3 か所と書きましたが、**4 つ目がありました。**

```js
// v0.1.1 の release-verifier.mjs:154-155
if (profile.provenance?.generatedFromCommit !== lock.releaseCommit) errors.push(...)
if (profile.sourceRevision !== lock.releaseCommit) errors.push(...)
```

v0.2.0 は release 工程が 2 段階なので、**tag の commit と artifact の生成 commit が必ず違います。**

```
tag                    8280d12
profile / evidence     0a0e124   ← 第 1 段階
感度 / 頑健性           756943f   ← worktree での生成時点
```

**両方の事実を持っていたのに、繋げませんでした。**2 段階になることは自分でコミットメッセージに書き、
`release-verifier.mjs` も読んでいました。さらに `docs/HALF_PLUG_ADAPTER.md` には
**「`sourceRevision` で固定しないでください。一致の要求はしません」と自分で書いてあります。**
その要求が下流に残っていることを確かめていませんでした。

**`artifactGenerationCommit` は 1 つでは足りません。**上のとおり生成 commit は 2 種類あります。
下流の lock は `profiles[].generatedFromCommit` を variant ごとに持つ形になっており、
感度側は警告（`STAGED_SENSITIVITY_GENERATION_PRECEDES_RELEASE_TAG`）で扱われています。この扱いで整合します。

### 外れた懸念 — 測って否定できたもの

「警告の判定が `topologyClass === 'all-expected-functions-match'` という文字列比較のままなので、
次の改名でまた黙って消えるのでは」と疑いました。**v3 改名を模擬して測ったところ、外れました。**

`release-verifier.mjs:129-134` が「そのクラスの区間がちょうど 1 つあること」と
「`mechanicalInsertion.firstAllFunctionsMatchAtMm` がその区間の境界と一致すること」を
**名前と数値で相互照合**しているため、改名すると

```
Error: Expected exactly one all-expected-functions-match interval, found 0
```

で停止します。沈黙しません。**報告する前に測って良かったものです。**

---
## 0-2. 対応状況（2026-08-03・trs-jack-3d 側）

**項目 1〜5 をすべて実装しました。**tag / release 作成は承認待ちです。

| | 項目 | 状態 |
|---|---|---|
| 1 | Machine-readable release index | **実装** — `artifacts/trs-jack-3d-release-index.v1.json` + schema。**生成 commit を 1 つに潰さない** |
| 2 | Evidence asset 専用 Schema | **実装** — validation-results / source-input-manifest / release index の 3 本。`validate:profiles` は 8 → **9 件** |
| 3 | Validation target の配布区分 | **実装** — 各 target へ `distribution`（`RELEASE_ASSET` / `SOURCE_ONLY`）と件数を追加 |
| 4 | Robustness window の区間表現 | **実装** — `startMm` / `lastSampleMm` / `endExclusiveMm` / `widthMm` へ分離。schemaVersion 1 → **2**（破壊的変更） |
| 5 | Tag source 検証 helper | **実装** — `npm run verify:release-source-inputs`。**v0.2.0 tag に対して 28/28 一致を実測** |

### 項目 5 — network は既定で使わない

オーダーの要件は「network access なし」です。既定は 2 経路とも通信しません。

```
--source <dir>   受け手が展開済みの source
--tag <tag>      手元の git object から git archive
--fetch github   **明示したときだけ**取りに行く
```

v0.2.0 tag に対して両経路で走らせ、**どちらも 28/28 一致**しました（GitHub 経路も一致するので、
手元の tag と GitHub の source が同じであることも同時に確かめられます）。

**結末を 5 つに分けています。**「取れなかった」と「合わなかった」を潰しません。

| status | exit | 意味 |
|---|---:|---|
| `OK` | 0 | 全件一致 |
| `MISMATCH` | 1 | 不一致・欠落・**記録漏れの入力**がある |
| `SOURCE_UNAVAILABLE` | 2 | source を取れなかった。**検証していないだけで、不一致ではない** |
| `MANIFEST_UNAVAILABLE` | 2 | manifest を読めなかった |
| `NOTHING_TO_VERIFY` | 2 | 入力 0 件。**何も見ていないのに OK と言わない** |

**read-only を機械で固定しています。**書き込み API を 1 つも使わず（tar は展開せずメモリ上で読む）、
外部コマンドは `git archive` / `git rev-parse` / `gh api` だけです。
テストが API 名と許可コマンドの両方を検査し、**実行前後で作業ツリーが変わらないこと**も見ます。

`unrecordedInputCandidates` も出します。`src/data` / `src/model` にあるのに manifest に無いファイルで、
**digest が覆っていない入力**を意味します（モデルのファイルを足して入力一覧へ入れ忘れた場合に出る）。

### 項目 5 で見つけたテストの弱さ

変異検査で 1 件素通りしました。`independentVerification.checked` を
`results.length` から `manifest.inputFilesTotal` の**写し**に差し替えても落ちなかったのです。
正しい manifest では両者が同値なので区別できません。

**自己申告だけを嘘にした manifest**（`inputFilesTotal: 999`）で測る試験を足し、
独立検証がそれに引きずられないことを確かめるようにしました。等価変異ではなく、テストの弱さでした。

### 項目 1 — `artifactGenerationCommit` を 1 つにしなかった

オーダーは `artifactGenerationCommit`（単数）を必須項目に挙げていますが、**1 つでは足りません。**
release 工程が 2 段階なので、profile と 感度・頑健性 は別の commit で生成されます。

そこで 3 つに分けました。

| 項目 | 意味 |
|---|---|
| `artifactGenerationCommit` | **profile の**生成 commit。下流の lock が既定で照合する値 |
| `artifactGenerationCommits[]` | `{ commit, assets[] }` の配列。**これが完全な事実** |
| `assets[].generatedFromCommit` | asset ごとの生成 commit |

「索引に載る全 asset が `artifactGenerationCommits` のどれかに現れること」を機械で守っています。

### 項目 1 — `releaseTag` / `releaseCommit` は既定で `null`

**索引を作る時点では tag は存在しません。**evidence をコミットしてから tag を打つためです。
分からないものを埋めると「この索引は tag を指している」という嘘になるので、`null` のままにします。

release 時は `RELEASE_TAG` / `RELEASE_COMMIT` を渡して作り直します。
**`npm run release:stage` は `null` のままの索引を拒みます**（版が食い違う場合も拒みます）。

### 項目 4 — 版を上げた

項目名を変えるのは破壊的変更です。`schemaVersion` を据え置いたまま名前を変えると、
読む側は `undefined` を受け取り、**エラーも警告も出ないまま壊れます**。
v0.1.0 → v0.1.1 の `spreadStatus` で実際に起きた型なので、同じことを別 artifact で繰り返しませんでした。

`contractMigration` も持たせ、**旧項目名が本体に残っていないこと**を機械で確かめています。

なお下流の現行コードは窓の項目を読んでいない（要約項目だけを使っている）ことを、
配布物のコードで確認したうえで変更しました。

### この回の実装で見つけた自分の欠陥 2 件

1. **索引が「一つ前の `validation-results`」を指していた。**索引を validation-results より先に書いていたため、
   sha256 と `generatedFromCommit` が古いままだった。生成順を入れ替えて直した。
2. **知らない値を埋めていた。**`releaseCommit` に HEAD を入れていたが、tag はまだ存在しない。`null` に直した。

どちらも生成物を目視で数えて気づいたもので、**「動いた」だけでは出てこなかった**。

**変異検査**: 意味規則 16 件・テスト 13 件を壊し、狙った検査が鳴ることを確認（等価変異 0 件）。
rc≠0 だけでは別の検査に助けられている可能性があるため、artifact ごとの節とその検査だけが持つ文言で照合しています。

---

## 結論

v0.2.0はHalf-Plug Labへ採用可能であり、blocking修正はない。以下は次回maintenanceまたはv0.2.1以降で検討する非阻害改善である。

## 1. Machine-readable release index

release assetへ次を追加する。

```text
trs-jack-3d-release-index.v1.json
trs-jack-3d-release-index.v1.schema.json
```

必須項目:

```text
releaseTag
releaseCommit
artifactGenerationCommit
profileSchemaVersion
profileSchemaId
profiles[variant].filename/profileId/inputDigest/sha256
sensitivity filename/inputDigest/sha256/generatedFromCommit
other assets
```

目的:

- 下流のlock手入力を廃止
- release commitとartifact generation commitの混同を防止
- filenameを契約として固定

## 2. Evidence asset専用Schema

次へDraft-07 Schemaを追加する。

```text
validation-results.json
source-input-manifest.json
release index
```

現状は内容を独自semantic validatorで確認できるが、形の完全検証がrelease bundleだけで閉じない。

## 3. Validation targetの配布区分

`validation-results.json`の各targetへ次を追加する。

```text
distribution:
  RELEASE_ASSET
  SOURCE_ONLY
```

または次の配列へ分離する。

```text
distributedTargets
sourceOnlyTargets
```

現状、8 target中2 targetはrelease assetに含まれないため、下流が「8件すべてを独立再検証できる」と誤読しうる。

## 4. Robustness windowの区間表現

現状のnominal window例:

```text
fromMm: 13.30
toMm: 13.50
widthMm: 0.22
stepMm: 0.02
```

これは`toMm`が最後に観測したsample、`widthMm`がそのsampleの次のstepまで含む区間幅という表現である。profile intervalのendは13.52mmなので、consumerが`toMm`を区間終端と誤読しうる。

次のいずれかへ変更する。

```text
startMm
lastSampleMm
endExclusiveMm
widthMm
```

または:

```text
startMm
endMm
endConvention: EXCLUSIVE
```

要求:

- profile intervalとrobustness windowの境界意味を一致または明示
- width == endExclusive - startをsemantic ruleで検証
- UIはlast sampleと区間境界を混同しない

## 5. Tag source independent verification helper

`source-input-manifest.json.verificationRecipe`を機械実行するread-only scriptを追加する。

```bash
npm run verify:release-source-inputs -- --source <exact-tag-source-dir> --manifest <manifest>
```

要件:

- network accessなし
- source treeを変更しない
- 28 pathsをexact hash
- missing/extra/mismatchをJSON出力
- release evidenceの自己申告と独立検証結果を分離

## 6. 変更禁止

- v0.2.0 assetの差替え
- `verifiedPhysical`の昇格
- robustness fractionの物理確率表現
- model sweepの製造公差表現
- PS000001反対証拠の削除
- topologyからのDSP係数生成
- 自動push/tag/release

## 7. 完了報告で必要な情報

```text
修正commit
release tag（公開する場合）
release index hash
新Schema hash
source-input verification helper test result
robustness window migration note
全test count
```
