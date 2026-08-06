# 外部監査（v0.6.0）への対応 — 指摘 7 件はすべて実在した

2026-08-06 ／ 対象 `Driedsandwich/trs-jack-3d` v0.6.0 ／ **tag と release には触れていない**

外部監査（ChatGPT / GPT-5.6）から P0 4 件・P1 3 件の指摘を受け取りました。
**受け取った指摘をそのまま信じず、7 件すべてについて反例をこちらで再現してから**直しています。
**7 件とも実在しました。捏造・誤検知は 0 件です。**

配布パケット（`trs-jack-3d-v0.6.0-audit-packet_20260806.zip`）は
宣言された sha256 `22ed4f11…586f60` と実測が一致しました。中身 9 ファイル、追加取得は不要でした。

---

## 1. 何を測って、何が出たか

| # | 指摘 | 再現したか | 直したか |
|---|---|---|---|
| P0-A | 相反する記録があっても `verified: true`・順序で結果が変わる | **した** | した |
| P0-B | 分解能 1.0 mm が許容 0.29 mm の判定を通る | **した** | した |
| P0-C | `verifiedPhysical` の主張範囲が広すぎる | **した** | した |
| P0-D | `ARCHIVE_INVALID` を配布 schema が表現できない | **した** | **版を上げずに閉じた**（後述） |
| P1-A | 同名 tar entry が後勝ちで黙って通る | **した** | した |
| P1-B | ディレクトリ入力の symlink ループで生の例外 | **した** | した |
| P1-C | 圧縮入力そのものに上限が無い | **した** | した |

さらに、確認の過程で**こちら側で 2 件見つけて**直しました。

- `check:doc-numbers` が**公開済みの release notes を作業ツリーの artifact と照合していた**
  （release 後に profile を作り直すと、公開済み文書を書き換えろと言い続ける）
- **CHANGELOG に v0.6.0 の節が無かった**（公開したのに記録が無い状態）
- **テストが 1 件、負荷時にだけ落ちていた**（`trrs.test.ts` の走査試験。**指摘とは無関係の既存の不安定さ**）

### P0-A — 実測した反例

```
[一致, 矛盾] → verified=true  rejected 0 件
[矛盾, 一致] → verified=true  rejected 1 件
```

**どちらも `true` である**ことと、**同じ台帳なのに出力が違う**ことの両方が起きていました。
一致する記録を 1 件見つけた時点で `break` していたためです。

対照として、空の台帳と矛盾のみの台帳は正しく `false` を返しており、判定器自体は動いていました。

### P0-B — 実測した反例

```
tolerance 0.29 mm / resolution 1.0 mm / values 2.0, 2.0, 2.0
  → verified: true
```

`resolutionMm > 0` しか見ていませんでした。1 mm 刻みで「2」と読んだ値は真値が 1.5〜2.5 の
どこでもありうるので、**許容 0.29 mm の一致を名乗ってはいけません。**

### P0-C — 実測した事実

`TRS|JACK-TRRS` profile の必須観測点は 1 点だけで、しかも
**別 variant（`TRRS-CTIA|JACK-TRRS`）の幾何量**です。この 1 点が合っても、
`IV028` の「L/R が別導体」「GND 開放」「短絡なし」は**何も確かめていません。**

### P0-D — ajv で実測

```
status=ARCHIVE_INVALID      → FAIL   （道具は v5 からこれを出す）
status=OK / MISMATCH / …    → PASS   （宣言済み 5 値）
対照 status=NONSENSE        → FAIL
```

### P1-A / P1-B / P1-C — 実測

```
P1-A  root/dup.txt を 2 回 → エラーなし・dup.txt = "SECOND"
P1-B  loop -> . が 1 本   → exit 1 / stdout 0 行 / stderr に ELOOP のスタック
P1-C  120 MB の入力       → 最大 RSS 165.0 MB（1 MB のときは 45.0 MB）
```

---

## 2. 直したもの

### 2-1. `verifiedPhysical` の条文を v2 へ（`docs/VERIFIED_PHYSICAL_GATE.md`）

| 直したこと | 中身 |
|---|---|
| 全候補を評価 | `recordId` で並べ直してから全部見る。**順序に依存しない** |
| 相反の扱い | 一致と矛盾が併存したら `AMBIGUOUS`（= `false`）。第10条を新設 |
| 分解能 | 観測点ごとに**許容の 1/3 以下**を要求（L は 0.05 mm 以下）。生値が目盛に乗っているかも見る |
| 主張の範囲 | `claimScope: geometry-only` を判定器と `physicalVerificationRef` の両方に出す。第9条を新設 |
| 台帳の重複 | `recordId` が重複したら判定ごと拒む（`INVALID_LEDGER`） |

**認定できないことと、矛盾を見逃すことを分けました。**
粗い測定器でも「予測より 1.45 mm ずれている」は言えます。それを「使えない記録」として
捨てると、**測ってもらったのにモデルの誤りを見逃します。**
食い違いの判定には測定器の不確かさ（分解能/2）を足し、**認定側には足しません**——
足すと粗い道具ほど通りやすくなるためです。

**`supersedes` は入れていません。**新しい記録が古い記録を黙って上書きできる仕組みを作らないためで、
決着は「モデルを直す」か「`retracted` を付ける」かの 2 つだけです。
`retracted` は既に台帳 schema にあるので、**`measurement-record.v1` の版も上がりません。**

### 2-2. 検算ツールを v6 へ（`scripts/verifyReleaseSourceInputs.mjs`）

| 直したこと | 実測した効果 |
|---|---|
| 同名 entry | `ARCHIVE_INVALID` で止まる。中身が同一でも拒む |
| symlink | `lstat` で見て追わない。fs エラーは構造化 status へ（**stdout 220 行の JSON・stderr 0 行**） |
| 圧縮入力の上限 | `maxCompressedBytes` 64 MB。**最大 RSS 165.0 MB → 43.6 MB** |

network は `Content-Length` を補助として見たうえで、**受け取りながら**打ち切ります
（`arrayBuffer()` は読み終えてからしか返さないので使いません）。

**塞ぎすぎていないことも同じテストで見ています。**26 個・6 種類の壊れた tar は v5 と同じ結末で、
正常な tar・gzip・実物の GitHub tarball（v0.5.2・246 ファイル）は今までどおり読めます。

### 2-3. `ARCHIVE_INVALID` の契約 — **版を上げずに閉じた**

判定器（`scripts/schemaLanguageDiff.mjs`）で実測しました。

| 案 | 判定 |
|---|---|
| `enum` へ `ARCHIVE_INVALID` を足す | **`BUMP`**（schema v2・**下流の lock が止まる**） |
| `description` にずれを書く | **`HOLD`**（版据え置き） |
| 対照: 何も変えない | `HOLD` |
| 対照: `enum` から 1 つ削る | `HOLD_RECORD` |

版を上げずに次の 3 つで閉じました。

1. schema 自身が「この v1 では `ARCHIVE_INVALID` を表現できない」と名指しで書く
2. 生成器が、表現できない status を**近い値へ丸めずに止まる**（`process.exit(1)`）
3. ずれが `ARCHIVE_INVALID` **1 個だけ**であることをテストで固定（7 個目が増えたら落ちる）

**丸めないことが要点です。**「archive が壊れていた」を「取れなかった」に化けさせると、
受け手が通信の問題と改竄を読み分けられなくなります。

### 2-4. こちらで見つけた 2 件

**公開済み notes の凍結。**`check:doc-numbers` が v0.6.0 の notes を現在の artifact と
突き合わせていました。release 後に profile を作り直すと ID が変わるので、この検査は
**公開済み文書を書き換えろと言い続けます。**公開本文は編集しない方針なので、手元の控えを凍結しました。
**凍結できるのは tag が実在する release notes だけ**にしてあります
（未公開文書が照合から静かに逃げないように）。

**CHANGELOG に v0.6.0 の節を追加。**公開したのに記録が無い状態でした。

**テスト 1 件の時間枠を広げました（判定条件は変えていません）。**
`trrs.test.ts` の走査試験が、全 25 ファイルを並列で回したときだけ 30 秒を超えて落ちていました
（実測 6 回中 2 回。どちらも他の処理と競合した回）。
単独では **2.4〜5.6 秒**で、**この変更を入れる前（2434 ms）とも同じ範囲**なので、
今回の修正が原因ではありません。**落ちた理由は結論ではなく wall-clock** なので、
枠を 30 秒 → 120 秒にしました。分割数や刻みを減らせば速くなりますが、
それは**この検査が見ている範囲を狭める**ので、時間のほうを譲っています。

---

## 3. 直していないもの（理由つき）

### P1-D 物理検証 evidence asset ／ P1-E `evidenceSources`

**どちらも「最初の実測記録が入る前に」という条件つきの指摘で、その条件はまだ来ていません。**

実測しました。

```
台帳の記録数                        0
profile 中の MR#### の出現           0   （実測由来の FACT）
gradeCounts                         FACT 53 / DERIVED 28 / ASSUMPTION 54
profile の evidenceGrade entry      152（DERIVED 1 / ASSUMPTION 151）
```

`evidenceSources` を profile schema へ足すと **`BUMP`** です（実測。当該 node が
`additionalProperties: false` のため）。**中身が空のうちに下流を止めると、止める理由を実物で説明できません。**
これは v0.6.0 で `evidenceGrade` の案 A を見送ったときと同じ判断です。

**実測記録が 1 件入った時点で、この 2 件は前提が変わります。**そのときに実施します。

### 監査が挙げたその他

| | なぜいま入れないか |
|---|---|
| annotated tag の署名 | 判定の意味を変えない。次の release の作業として分ける |
| CI failure-path テスト | 同上（非阻害と監査自身も分類） |
| dangling GNU `L` の strict mode | 現状 `ARCHIVE_INVALID` になる。挙動は既に安全側 |

---

## 4. 検証したこと

すべて実行し、出力を確認しています。

```
npm run typecheck          exit=0
npm run test               exit=0   706 件 / 25 ファイル / 失敗 0
npm run validate:profiles  exit=0   14/14 適合
npm run check:vacuity      exit=0   空振り 0 件（記録 706 = 実行 706）
npm run check:doc-numbers  exit=0   宣言 15 一致 / 凍結 4 / 未点検 0 件
npm run lint               exit=0
npm run release:evidence   exit=0   artifactValidation PASS / releaseReadiness READY
```

**新しい検査は、変異を実際に入れて鳴ることを確かめています**（変異が入ったことを sha256 の変化で先に確認）。

| 変異 | 結果 |
|---|---|
| notes の profileId を 1 文字変える | `check:doc-numbers` exit=1・凍結 4 → 3 |
| 実在しない tag で凍結する | exit=1「tag v9.9.9 が実在しない」 |
| 道具に 7 個目の status を足す | テスト 3 件が落ちる |
| 生成器の「止まる」経路を外す | 該当テスト 1 件が落ちる |
| 変異を戻す（対照） | すべて緑に復帰 |

**全体を 3 回続けて回し、3 回とも 706/706 でした**（`Duration` 16.5s / 16.1s / 16.4s）。

### tag と release に触れていないこと

```
tag v0.6.0     → 7bfed3c（変わらず）
release v0.6.0 → draft=false / asset 28 件 / latest=true / published 2026-08-06T04:23:18Z
```

**過去 release の asset は 1 つも触っていません。**この作業はすべてローカルです。

---

## 5. 判断が要ること（2 件）

### (1) `source-verification-result` を v2 へ上げるか

いま `ARCHIVE_INVALID` は**表現できないまま**で、生成器が止まる形にしてあります。
v2 へ上げれば表現できますが、**下流の lock が止まります。**

- **上げない（現状・推奨）** … 受け手が道具を直接回せば `ARCHIVE_INVALID` は stdout に出ます。
  詰まるのは「こちらの自己申告 artifact がその状態を書けない」場面だけで、
  そのときは生成器が止まるので黙って間違った値が出ることはありません。
- 上げる … 次の release で下流に lock 再生成を求めることになります。
  profileId は毎 release 変わるので lock 再生成自体は元々必要ですが、
  **`schemaId` が変わるのは下流のコード変更**を伴います。

**推奨は「上げない」です。**実際に `ARCHIVE_INVALID` を自己申告する必要が出た日に上げれば、
そのとき理由を実物で示せます（`evidenceGrade` 案 A と同じ考え方です）。

### (2) v0.6.1 として release を出すか

検算ツールの v6 は**受け手が使う道具**なので、出さないと手元にしかありません。
一方、いま出すと profileId が再び変わります（`fddf3c173ac6` / `027f5e2fff6a`）。

- **いま出す（推奨）** … 直したのは受け手が回す道具の欠陥です。手元に置いたままにする理由が弱い。
- ためる … P1-D / P1-E を実測記録と一緒に出す v0.7.0 まで待つ。ただし**実測はいつ来るか分かりません**。

**推奨は「いま出す」です。**待つ理由が「まだ来ていない実測」に依存しています。
