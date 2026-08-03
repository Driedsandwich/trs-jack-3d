# trs-jack-3d v0.3.0 非阻害フォローアップ開発オーダー

作成日: 2026-08-03

## 0-1. 受領時の検証記録（2026-08-03・trs-jack-3d 側）

**受け取った内容は実測で裏を取りました。**自己申告は使っていません。

| 確認 | 方法 | 結果 |
|---|---|---|
| 配布 zip | `shasum -c` | **一致**（2,777,274 bytes・CRC OK・429 ファイル） |
| このオーダー本体 | zip 内から直接読み出し | sha256 `dbf6dc59b199ffda…` |
| 数値・構造の主張 | 配布物と 1 件ずつ照合 | **23 項目すべて一致・食い違い 0** |
| 指摘 P1-1（version 不一致） | `git show <tag>:package*.json` | **正しい**（下の 0-3 に追加事実あり） |
| 指摘 P1-2（探索範囲） | **manifest を 4 通りに変異させて helper を実走** | **正しい。実際の穴だった**（0-2） |

照合した主な値（すべて一致）:

```
profileId TRS      trs-jack-3d:TRS|JACK-TRS:abca1dfb5b5f
profileId TRRS     trs-jack-3d:TRS|JACK-TRRS:01ac02bdcb7b
releaseCommit      4c5fce8b23147dc03cd5b18ac855cc51e4c7b179  = git rev-parse v0.3.0^{commit}
生成 commit         3966dc6(profile 2) / 5900015(evidence 2) / b66a301(感度・頑健性 3)
索引 assets 17 / SHA256SUMS 18 / 配布ファイル 19
TRS   intervals 23  events 32  ground-open-differential 0
TRRS  intervals 30  events 36  ground-open-differential 1
IV028 13.30–13.52mm  normalized 0.950000–0.965714  ASSUMPTION
頑健性 5184 / 3920 / 2300 / 0.586735
窓     13.30 / 13.50 / 13.52 / 0.22   step 0.02   EXCLUSIVE
移行   interval 53/53  event 68/68（ID 完全一致・profileId は変化）
検証   9 対象 = RELEASE_ASSET 7 + SOURCE_ONLY 2
test   408 / skipped 0
```

§5-1 に挙げられた窓の不変条件 6 件はすべて成立しています
（`lastSampleMm + stepMm == endExclusiveMm`、`endExclusiveMm == profile IV028 nominalEndMm` を含む）。

`SOURCE_UNAVAILABLE` の扱いも設計どおりに読まれました。受領した
`TRS_JACK_3D_V030_SOURCE_INPUT_VERIFICATION_RESULT_20260803.json` は
`status: SOURCE_UNAVAILABLE` / `exitCode: 2` / `notAMismatch: true` / `independentVerification: false`
を分けて記録しており、**「取れなかった」を「合わなかった」に潰していません。**

### 0-2. P1-2 は実際の穴でした（変異で実証）

`verifyReleaseSourceInputs.mjs` の未記録入力検出を、manifest から入力を落として実走した結果:

| 落とした入力 | status | exit |
|---|---|---:|
| `src/model/` 8 件 | MISMATCH | 1 |
| `scripts/` 4 件（generator 本体） | **OK** | **0** |
| `schemas/` 3 件 | **OK** | **0** |
| `package-lock.json` | **OK** | **0** |

**入力 28 件のうち、記録漏れを検出できるのは 8 件だけです。**残り 20 件は落としても「全件一致」を返します。

**なぜ自分で見つけられなかったか。**この機能には変異試験を 7 件書いて全部落としていましたが、
**変異がすべて `INPUT_DIRS` の内側（`src/model/`）だった**からです。
探索範囲そのものが仮定なので、内側から叩いても仮定は揺れません。
**変異が全部落ちること自体は、範囲が正しいことの証拠になりません。**

→ 恒久化済み（メモリ `feedback-mutate-outside-detector-scope`）。P1-2 の受入条件に反映します。

### 0-3. P1-1 について、オーダーに無い追加事実

**不一致は v0.3.0 で始まったのではなく、v0.2.0 から続いています。**

```
v0.1.0   package.json 0.1.0 / lock 0.1.0
v0.1.1   package.json 0.1.0 / lock 0.1.0
v0.2.0   package.json 0.2.0 / lock 0.1.0   ← 起点（commit 756943f）
v0.3.0   package.json 0.3.0 / lock 0.1.0
```

`756943f` で `package.json` だけを上げたのが起点です。

影響範囲の実測:

- `package-lock.json` は **5 つの生成物すべての入力**（`consumedBy`: profile 2 / 感度 2 / 頑健性 1）
- `profileId` は `provenance.inputDigest.slice(0, 12)` なので、**直せば profileId まで変わる**
- `npm ci --dry-run --offline` は **rc=0**。止まらないという判定は正しい
- `artifacts/*.json` に version の記載は無く、**成果物へ染み出していない**

**さらに、こちらには既に検査があるのに素通りしていました。**
`test/schemaContractV2.test.ts:230`「package.json の version が配布版と揃っている」は、
実際には `stageRelease.mjs` の既定値しか見ておらず、`package-lock.json` を一切参照していません。
**テスト名のほうが検査範囲より広く、その名前で「守られている」と判断していました。**
P1-1 ではこのテストの名前か assertion のどちらかを直します。

### 0-4. こちらの作業指示の欠陥

**「やること 4（`verify:release-source-inputs` で入力 28 件を自分で検算する）」は、
添付 19 件だけでは実行できませんでした。**`verifyReleaseSourceInputs.mjs` も tag source も bundle にありません。
受け取った `SOURCE_UNAVAILABLE` は**正しい報告**で、欠陥は指示側にあります。
P1-3 と併せて、配布に足すか clone 経路を明記するかを決めます。

### 0-5. 対応状況（2026-08-03・trs-jack-3d 側）

| | 状態 |
|---|---|
| **P1-2** source input scope の機械可読化 | **実装済み**（下の 0-6） |
| **P1-4** 窓の test vector 3 件 | **実装済み**（下の 0-7） |
| **P1-1** version parity | **実装済み・再生成済み**（下の 0-9） |
| **P1-3** source verification evidence | **実装済み**（下の 0-10） |

4 件とも入っている。**release はまだ作っていない**（採番と公開は承認待ち）。

**P1-1 を最後にした理由。**`package-lock.json` は 5 つの生成物すべての入力なので、
version を直すと感度・頑健性・profile を作り直すことになる。
P1-2 も `scripts/provenance.ts` と範囲定義を入力に加えるため、同じ再生成が要る。
**先に P1-1 をやると、重い走査（`search:robustness`）を 2 回回すことになる。**
入力の集合を P1-2 で確定させてから、P1-1 でまとめて 1 回作り直す。

そのため現在、artifact は**意図的に古い状態**にある。`npm run check:stale` が 5 件すべてを
名指しで再実行対象に挙げており、これは P1-1 の作業手順そのものである。

**「再生成すれば直る」を主張ではなく実測にした。**リポジトリを複製し、
そこで再生成の全工程（感度 → 頑健性 → profile → evidence）を通しで流した。

```
validation-results.json     10/10 適合 (配布 8 / 非配布 2)
source-input-manifest.json  入力 29 件
release-index               asset 19 件
validate:profiles           10 件すべてが schema と意味規則の両方に適合
```

この予行で **schema の enum 漏れが 1 件見つかった**（下の 0-6）。
静的な検査だけでは出ず、実際に作り直して初めて出た。

現在テストで落ちている 6 件は、すべてこの古さに起因する。

| 落ちているテスト | 理由 |
|---|---|
| `sensitivityProvenance` × 2 | 記録された入力一覧が 28 件（範囲定義が入る前） |
| `releaseIndex` 3 件 | 索引が asset 17 件のまま／manifest に `inputScope` が無い |
| `halfPlugProfile` 1d | 上記をまとめた `validate:profiles` |

**再生成で消えることは予行で確認済み。**リポジトリ側では回していない（P1-1 で 1 回だけ回す）。

### 0-6. P1-2 でやったこと

**範囲定義を 1 か所に置き、生成側と検証側の両方がそれを読むようにした。**

```
source-input-scope.v1.json          範囲定義（**これ自身も入力**）
schemas/source-input-scope.v1.schema.json
```

| 読む側 | 何に使うか |
|---|---|
| `scripts/provenance.ts` | 生成器ごとの入力一覧を組み立てる |
| `scripts/verifyReleaseSourceInputs.mjs` | 記録漏れの探索範囲 |
| `scripts/buildReleaseEvidence.mjs` | manifest へ範囲を書き込む |

`INPUT_DIRS = ['src/data','src/model']` の直書きは消した。

**回帰試験は範囲の外側から入れた。**今日素通りした 4 件をそのまま入れてある。

| 落とした入力 | 以前 | 現在 |
|---|---|---|
| `src/model/` 8 件 | MISMATCH / 1 | MISMATCH / 1 |
| `scripts/` 4 件 | **OK / 0** | **MISMATCH / 1** |
| `schemas/` 3 件 | **OK / 0** | **MISMATCH / 1** |
| `package-lock.json` | **OK / 0** | **MISMATCH / 1** |

`rc` だけで判定していない。落としたパスが `unrecordedInputCandidates` に
名指しで、しかも**その件数ちょうど**出ることまで見ている。
偽陽性が無いこと（変異なしなら `OK` / 0）と、
**範囲を狭めると検出されなくなること**（範囲定義が判定を動かしている証拠）も入れた。

**生成側も黙らせない。**`requiredExactFiles` のファイルが読めないとき、以前は
黙って飛ばして**その入力抜きの digest** を作っていた。値だけ変わって理由が残らないので追えない。
今は落ちる。範囲外（`recursiveDirectories` 配下・生成物）は従来どおり無くても影響させない。

**検出できないものは黙らない。**

- 範囲定義が無い source では `unrecordedInputDetection.performed: false` と理由を出す。
  **既定の狭い範囲へ戻すことは意図的にしていない**——それが今回塞いだ穴そのものだから
- `notCovered` に **digest が覆えないもの**（Node のバージョン・ロケール・環境変数・
  `src/` のうち UI 側・`test/`）を書き、検証側の出力にも載せた。
  「一致した」を「全部同じだった」と読ませないため

**実装中に自分で同じ形の誤りをもう 1 回やった（再生成の予行で発覚）。**

範囲定義が入力に加わったことで `input-scope` という role が増えたが、
**artifact schema の `role` の enum に足し忘れていた。**
着手前に「role に enum があるか」を調べたとき、検出コードの条件を

```
o.get('type') == 'string' and 'model-code' in o['enum']
```

と書いていた。実際の schema には `enum` だけ書かれていて `type` が無く、
**取りこぼした結果「role に enum は無い（自由文字列）」と誤って読んだ。**
検出条件が狭いと、無いのか見えていないのかが区別できない——今日 3 回目の同じ形である。

対策として、**実際に生成される role を全部集めて現役 schema 3 件の enum に載っているかを機械照合する**
テストを足した（enum から 1 語抜くと落ちることを変異で確認済み）。
`role` が `other` に落ちる入力があれば、それも同じテストが落とす。

enum には `input-scope` を**追加**した。改名ではないので、role で絞り込む実装が沈黙して壊れることはない。
v0.3.0 の schema を pin して新しい artifact を検証すると enum で落ちるが、**それは明示的に落ちる。**
両 artifact の `contractMigration.addedFields` に記録した。
**v1 schema（過去の release の契約）には触っていない。**

入力は **28 件 → 29 件**（範囲定義自身が加わる）。
`validate:profiles` の対象は **9 件 → 10 件**で、増えたのは範囲定義。
そこでは「範囲から導いた集合と、実際に記録された入力がちょうど一致するか」を突き合わせている。

### 0-7. P1-4 でやったこと

`test/fixtures/topology-robustness/` に 3 件。**どの層が弾くかまで実走で確かめた。**

| fixture | schema | 意味検査 | 捕まえた層 |
|---|---|---|---|
| `valid-exclusive-window.json` | PASS | PASS | （通す） |
| `invalid-legacy-toMm.json` | **FAIL** | — | **schema** |
| `invalid-lastSample-equals-endExclusive.json` | **PASS** | **FAIL** | **意味検査** |

**3 番目は schema を通る。**draft-07 に項目どうしの大小を書く方法が無いので、
`lastSampleMm < endExclusiveMm` は schema では表現できない。
つまり「schema を通ったから窓は正しい」は成り立たない——これを実演するための fixture である。

窓の規則は `scripts/robustnessWindows.mjs` へ切り出し、
**本番の検証（`validateProfiles.mjs`）と fixture のテストが同じ関数を呼ぶ**ようにした
（二重に書くと、fixture が落ちても本番が落ちるとは限らなくなる）。

実装中に見つけたこと: **`counterExamples` 側の窓は実データに 1 件も無い**（9 件中 0 件）。
目標が現れない構成には窓ができないので当然だが、**一度も通らない枝は壊れていても気づけない**ので、
テストでは合成した反対証拠を通して枝が生きていることを確かめている。

### 0-8. `test/schemaContractV2.test.ts` の名前を狭めた

「package.json の version が配布版と揃っている」→
**「stageRelease の既定 version が package.json と揃っている」**。
実際に見ているのは `stageRelease.mjs` の既定値だけで、`package-lock.json` を参照していない。

そのうえで、**既知の不一致を主張するテストを 1 件足した。**
P1-1 で lockfile を直した瞬間に落ちるので、そこで parity 検査へ反転させる。
黙って放置するより、落ちて気づくほうがよい。

### 0-9. P1-1 でやったこと

`package-lock.json` の version を **0.1.0 → 0.3.0**（root と `packages[""]` の 2 か所）。
差分は**2 行だけ**で、`npm ci --dry-run --offline` は rc=0 のまま。

そのうえで感度 → 頑健性 → profile → evidence を**1 回だけ**通した。

| | 旧（v0.3.0 公開版） | 新 |
|---|---|---|
| `TRS\|JACK-TRS` | `…:abca1dfb5b5f` | **`…:b604122db23d`** |
| `TRS\|JACK-TRRS` | `…:01ac02bdcb7b` | **`…:50e9c5aaab4c`** |

**parity の判定は `check:stale` ではなく release validation へ入れた。実測して決めた。**

複製したリポジトリで `package.json` の version だけを 0.3.0 → 0.9.9 に変え、両方を回した。

```
check:stale        「重い成果物は現在のモデルと整合しています。再実行は不要です。」 rc=0
validate:profiles  11 件すべて適合
```

**`check:stale` は一言も出ない。**見ているのは `inputDigest` で、`package.json` は入力ではないからである。
v0.2.0 で不一致が生まれ v0.3.0 まで気づかなかったのは、まさにこの経路だった。
（`package-lock.json` を書き換えれば `check:stale` は鳴る。だが**鳴ってほしいのは
package.json だけを上げたときで、そこでは鳴らない。**）

`package.json` を入力に加える案は採らなかった。scripts や依存の範囲指定を直すたびに
全 artifact の digest が動き、**「中身が変わっていないのに ID が変わる」**を自分から作ることになる。

`test/schemaContractV2.test.ts` の「まだ揃っていない」テストは**parity 検査へ反転済み**
（直した瞬間に落ちる形にしてあったので、忘れずに反転できた）。
判定の本体がテスト側だけに無いことも、別のテストで押さえた。

検証対象は **10 件 → 11 件**（`package.json` が加わる。配布はしないので `SOURCE_ONLY`）。

### 0-10. P1-3 でやったこと

`artifacts/source-verification-result.json` を新設し、bundle へ入れた。

```
isSelfReport                    true   （固定。schema で const にしてある）
replacesRecipientVerification   false  （固定）
sourceOrigin                    directory:.  ← **tag の source ではない**
releaseCommit                   null   （artifact は自分を含む commit の hash を持てない）
status / exitCode               OK / 0
counts.checked                  29
unrecordedInputDetection.performed  true
```

**突き合わせ先が作業ツリーであることを artifact 自身に書いてある。**
tag は evidence をコミットしてから打つので、この時点では存在せず、原理的にここでは検証できない。
`howToVerifyYourself` に受け手が自分で回すコマンドを入れ、
**「取れなかった(2)」と「合わなかった(1)」を潰さないこと**もそこに書いた。

**「添付だけでは回せない」問題も直した。**

| 足したもの | 理由 |
|---|---|
| `scripts/verifyReleaseSourceInputs.mjs` | **道具が bundle に無かった**。node 標準しか使っていないので単体で動く |
| `artifacts/source-verification-result.json` | 判定の境界を実物で見せる |
| `schemas/source-verification-result.v1.schema.json` | 形を bundle 内で検証できる |

tag source のほうは**新たに配る必要がなかった**。GitHub が release ページへ
"Source code (tar.gz)" を自動で付けており、同じページから取れる（v0.3.0 で実測・9.3 MB）。

ただし展開すると `Driedsandwich-trs-jack-3d-<sha>/` が 1 枚かぶる。
**剥がし忘れると 29 件すべてが `MISSING_IN_SOURCE` になり「壊れている」と読める。**
`--source` がその 1 階層を剥がすようにした（親が複数ある普通の root では何も起きない）。
剥がしを止める変異でテストが落ちることを確認済み。

配布物は **19 件 → 22 件**。

---

## 結論（受領原文）

v0.3.0のHalf-Plug production importはPASS。blocking修正はない。以下は次回maintenance/release向けの非阻害事項である。

## P1-1 package.json / package-lock.json version parity

現状:

```text
package.json      0.3.0
package-lock.json 0.1.0（rootとpackages[""]）
```

対応:

- 次回release前にlockfile root versionをpackage.jsonへ一致させる
- `npm ci`後も一致することをテスト
- `check:stale`またはrelease validationへversion parityを追加
- package-lockはprofile等のinputなので、修正後は感度・頑健性・profileを順に再生成
- 既存v0.3.0 assetは上書きしない

## P1-2 source input candidate scopeを機械可読化

現状のhelperはmanifest記載pathを正確にhash検証するが、未記録候補探索は:

```js
const INPUT_DIRS = ['src/data', 'src/model']
```

に限定される。

改善案:

```text
source-input-scope.v1.json
  requiredExactFiles[]
  recursiveDirectories[]
  allowedGeneratedInputs[]
  excludedOutputs[]
```

最低限候補:

```text
package-lock.json
schemas/**（実際に各artifactが読むschema）
scripts/provenance.ts
各artifact generator
src/data/**
src/model/**
各artifactが読む他artifact
```

要件:

- provenance builderとverifierが同じscope定義を使用
- scope内にある未記録ファイルをMISMATCHにする
- scope外の文書/UIファイルは誤検出しない
- scope definition自身をrelease evidenceに含める
- mutation testでgenerator/schema/lockfileの記録漏れを検出

## P1-3 release source verification evidence

任意だが、release bundleへ次を追加すると受け手がsource取得不能でも判定境界を明確にできる。

```text
source-verification-result.json
  source origin
  tag commit
  checked/matched/mismatched/missing
  tool version
  status
```

これは自己申告であり、受け手の独立検証を置換しないと明記する。

## P1-4 robustness window test vectors

Schema v2のconsumer実装を簡単にするため、次の3fixtureをrelease sourceへ置く。

1. valid exclusive window
2. legacy `toMm`を含むinvalid fixture
3. `lastSampleMm == endExclusiveMm`のinvalid fixture

## 変更禁止

- v0.3.0 assetの上書き
- verifiedPhysicalの昇格
- model sweep fractionの物理確率化
- IV028からの直接DSP係数生成
- source取得不能をMISMATCHと記録
- release前の無承認push/tag/publish

## 完了報告

- 修正commit/tag
- package version parity結果
- input-scope policy
- mutation test結果
- exact tag test count
- 新profile ID/input digest/asset hash（再生成した場合）
