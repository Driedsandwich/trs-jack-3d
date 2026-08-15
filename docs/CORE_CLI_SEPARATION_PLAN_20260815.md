# core / CLI 分離の計画と実施記録（**着手済み・2026-08-15**）

外部監査 P2（v0.6.15 / v0.6.16 / v0.6.17 で 3 回続けて指摘）。
v0.6.16 の notes で「次の版で着手します」と書いて、**v0.6.17 でも着手しませんでした。**
監査も「先に契約の versioning を閉じ、その次の独立版で着手するのが妥当」としており、
その判断に従った結果です。

**v0.6.17 の公開後、最初の作業としてこれをやりました。**
以下 §0〜§8 は着手前に書いた計画で、**そのまま残してあります**
（あとから計画のほうを結果へ寄せると、計画に意味が無くなるため）。
実際に何をどう測ったかは末尾の「実施記録」にあります。

---

## 0. 何を解くのか

`scripts/verifyReleaseSourceInputs.mjs` は **3224 行の単一ファイル**で、
判定のロジックと、プロセスとの接点（引数・標準出力・終了コード）が混ざっています。

そのせいで、いま**踏めない経路**があります。

```
SOURCE_ARCHIVE_MISSING   race-defensive と分類したが、実際には踏んでいない
                         （存在を確かめてから開くまでの間に消す必要がある）
```

filesystem を差し替えられれば実経路として踏めます。それには core が
`process` と `console` に直接触らない形になっている必要があります。

## 1. **この版でやること／やらないこと**

```
やる     main(args, io) の抽出だけ。**1 コミット。**
やらない ファイル分割・ディレクトリ移動・API の設計変更
やらない 判定ロジックへの変更（1 行も触らない）
やらない filesystem adapter の注入（次の次）
```

**混ぜません。**出力が 1 バイトでも変わったら、それは分離ではなく変更です。

## 2. 触る場所は 8 か所しかない（実測 2026-08-15）

```
537   const ROOT = process.cwd()
538   const argv = process.argv.slice(2)
619   process.stderr.write(…)          ← 契約違反のときの目印と説明
626   process.exit(INTERNAL_FAILURE_EXIT)
628   console.log(JSON.stringify(out, null, 1))
629   process.exit(code)
2857  typeof process.argv[1] !== 'string'   ← 入口の判定
2859  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
```

2857 / 2859 は**入口の判定**なので、抽出後も CLI 側に残ります。
core が受け取るのは `args` と `io` の 2 つだけです。

## 3. 形

```js
/** 副作用を持たない本体。**戻り値がすべて**（exit も stdout も返り値に含む） */
export function main(args, io) {
  // io = { cwd, readFileSync, existsSync, ... , fetch }
  // return { code, stdout, stderr }
}

/** プロセスとの接点。**ここだけが process と console に触る** */
if (RUN_AS_CLI) {
  const r = main(process.argv.slice(2), defaultIo())
  if (r.stdout) console.log(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  process.exit(r.code)
}
```

`done()` は `process.exit` を呼ばず、結果を返す形にします。
いまは `done()` が出口で `process.exit` を叩いているので、
**そこを「投げる」か「返す」へ変える**のが実質の作業です。

## 4. 着手手順（この順で・各段で止まれること）

```
段 0  分離前の出力を固定する（下の「検証手順」の基準を取る）
段 1  defaultIo() を作る。**まだ誰も使わない**（この時点で出力は変わらない）
段 2  done() を「返す」形へ変える。呼び出し側で受けて、CLI 側で exit する
段 3  ROOT / argv を io と args から取る
段 4  stderr / stdout の書き出しを CLI 側へ寄せる
段 5  基準と byte 一致を確かめる → 1 コミットにまとめる
```

**段 5 で一致しなければ、そこで止めます。**「たぶん同じ」で進めません。

## 5. 検証手順（分離が「何も変えていない」ことの証明）

### 5.1 基準を先に取る（段 0）

分離**前**の道具で、全経路の出力と終了コードを固定します。
経路は `test/_cliRoutes.mjs` が既に持っているので、それを母集団にします。

```
node scripts/verifyReleaseSourceInputs.mjs                        引数なし
node … --source .                                                  OK
node … --source . --manifest <壊れた>                              各 status
（+ _cliRoutes.mjs の 7 経路：fetch 失敗 / timeout / 503 / body / git archive / manifest 欠落）
```

各経路について次を記録します。

```
stdout の sha256
stderr の sha256
終了コード
```

**stdout を JSON として比べません。**byte で比べます——キーの順序が変われば
受け手の差分も変わるためです。

### 5.2 分離後に同じものを取る（段 5）

```
基準と byte 一致       全経路で 3 つとも一致すること
対照                   基準を 1 バイト変えると不一致として検出されること
```

対照を必ず取ります。**「一致した」は、比べる仕組みが壊れていても出ます。**

### 5.3 配布した道具そのもので確かめる

分離後の道具を `dist/release/` へ staging し、**その写しを単体で走らせて**
同じ基準と突き合わせます（repo の中でだけ動く形になっていないこと）。

```
node <staging の写し>/verifyReleaseSourceInputs.mjs --source .
```

### 5.4 単一ファイル制約が壊れていないこと

```
import は node: だけ（既存の試験がある）
node_modules の外へ置いても動く
```

**分割したくなっても、この版では分割しません。**配布物は 1 ファイルのままです。

### 5.5 いつもの一式

```
npm run typecheck / test / build / validate:profiles
npm run check:vacuity / check:doc-numbers / check:test-evidence-current / check:cli-schema-sync
npm run release:evidence / release:stage
```

`toolVersion` は**上げません**。判定の意味が変わらないためです。
逆に言えば、**上げたくなったらそれは分離ではありません。**

## 6. 分離が済んで初めてできること（次の次）

```
SOURCE_ARCHIVE_MISSING を実経路として踏む
  io.existsSync を通したあとで io.readFileSync が ENOENT を返す形を注入する
  → race-defensive から cli-route へ移せる
```

そのときは `REACHABILITY_KINDS` の宣言も一緒に動かし、
**両方向の照合が実測と合うこと**を確かめます。

## 7. 失敗したときの戻し方

1 コミットなので `git revert` 1 回で戻ります。
段の途中で止めた場合は、まだコミットしていないので `git checkout -- scripts/` で戻ります。

## 8. やらないと決めたこと（理由つき）

```
ファイル分割          配布物が 1 ファイルであることが受け手への約束なので、
                      分けるなら bundle 手順が要る。それはこの版の範囲を超える
API の設計変更        main(args, io) の形だけ決める。io の中身を最小にする誘惑に乗らない
                      （必要なものが後から分かるので、まずは全部渡す）
判定ロジックの改善     見つけても直さない。**別のコミットにする**
```

---

# 実施記録（2026-08-15）

## 段 0 — 基準を取った

`scripts/cliOutputBaseline.mjs` を新設し、**基準を repo へ入れました**
（`test/fixtures/cli-output-baseline.v1.json`）。作業領域に置くと、
報告した証拠を誰も再現できないためです。

```
9 経路 = _cliRoutes.mjs の 7 経路 ＋ 注入なしの 2 経路（引数なし・OK）

  引数なし                    exit 2 / stdout 2251 B / stderr    0 B
  OK（固定 fixture を検算）     exit 0 / stdout 3834 B / stderr    0 B
  引数不足                    exit 2 / stdout 2251 B / stderr    0 B
  GitHub へ繋がらない          exit 2 / stdout 2334 B / stderr    0 B
  GitHub からの応答が来ない     exit 2 / stdout 2346 B / stderr    0 B
  GitHub が 503 を返す        exit 2 / stdout 2331 B / stderr    0 B
  応答本文を読めない            exit 2 / stdout 2261 B / stderr    0 B
  git archive が失敗する       exit 2 / stdout 2326 B / stderr   36 B
  manifest が無い             exit 2 / stdout 1944 B / stderr    0 B
```

**`_cliRoutes.mjs` に注入なしの 2 経路を足したのには理由があります。**
あの表は「外部の失敗を注入して踏む経路」の表で、普通の経路は入っていません。
**分離で壊れやすいのはむしろ普通の経路**なので、基準では一緒に測ります。

**基準に検出力があることを、先に実測しました。**

```
対照: 判定を何も変えない見た目の変更（JSON のインデント 1 → 2）を入れると
      → 全経路で stdoutSha256 が不一致・exit 1
```

### **最初の基準には穴がありました（同じ日に直しています）**

`OK` 経路を最初は `--source .`（作業ツリー）で測っていました。
**その出力は `artifacts/source-input-manifest.json` の中身に依ります。**
分離のあと evidence を作り直した時点で、`OK` 経路だけが不一致になりました。

**原因が分離かどうかを、先に切り分けました。**

```
同じ（再生成後の）artifact に対して
  分離前の道具  6deeb0c4090efdbb…
  分離後の道具  6deeb0c4090efdbb…   → 一致。**分離は出力を変えていない**
基準（再生成前の artifact 時点）  c04a4d80d12d7fc8…
  → 差は artifact の再生成によるもので、道具ではない
```

**「一致しなかった」で止めず、何が原因かまで測りました。**
そのうえで、基準そのものを直しています——`OK` 経路を
**固定 fixture**（`test/fixtures/ok-source/`）に対して測る形へ。
artifact を再生成しても動かないので、CI が誤検出しません。

```
固定 fixture   src/model の 2 ファイル ＋ 専用の scope と manifest
               本番の artifacts/ を 1 バイトも読まない
確かめたこと   分離前の道具と分離後の道具が、この fixture に対して同じ digest を出す
               （＝この基準は道具だけを測っている）
基準の取り直し **分離前の道具へ戻してから**取った
               （分離後に取ると「分離前の値」にならない）
```

## 段 1〜4 — 実際に触ったのは 6 行

```
新設   defaultIo()（cwd / argv / stdout / stderr / exit の 5 つ）
差替   ROOT = process.cwd()          → io.cwd()
       argv = process.argv.slice(2)  → io.argv()
       process.stderr.write(…)       → io.stderr(…)
       process.exit(INTERNAL_…)      → io.exit(INTERNAL_…)
       console.log(JSON.stringify…)  → io.stdout(JSON.stringify…)
       process.exit(code)            → io.exit(code)
残す   入口の判定 2 か所（process.argv[1] と import.meta.url の realpath 比較）
```

**各段の直後に基準と突き合わせ、段 1 の時点でも byte 一致でした。**

## 段 5 — 検証

```
全 9 経路が基準と byte 一致（stdout / stderr / 終了コード）
       基準は **分離前の道具**で取った（toolSha256 b208399106bb1d97… ≠ いまの b3f1ae1d74d658ef…）
対照   基準を 1 バイト変えると exit 1・その経路のその欄を名指しで検出
       復元すると exit 0
配布物 node_modules の外へ写して走らせても、代表 2 経路が基準と一致
制約   import は node: だけ（6 本）。node: 以外は 0 件
版数   toolVersion 20 のまま（上げていない）
判定   判定ロジックの差分 0 行
```

## 守ったこと

```
判定ロジックに触らない    差分は defaultIo() の新設と 6 行の差し替えだけ
toolVersion を上げない   20 のまま（分離で判定の意味は変わらない）
1 バイトでも変われば止める 段ごとに基準と突合し、一度も不一致にならなかった
```

## 第2段（2026-08-15）— `SOURCE_ARCHIVE_MISSING` を実経路として踏んだ

`io` へ filesystem（`existsSync` / `readFileSync` / `statSync` / `lstatSync` / `readdirSync`）を足し、
11 か所の call site を `io` 経由にしました（入口の判定 `realpathSync` は CLI 側に残す）。

**踏み方。**道具の並びはこうなっています。

```
loadFromDir      existsSync(abs)  … 通る
                 lstatSync(abs)   … ディレクトリでない → loadFromArchive へ
loadFromArchive  existsSync(abs)  … **ここで消えていれば SOURCE_ARCHIVE_MISSING**
```

**同じ path に対する 2 回目の `existsSync`** だけ false にすれば踏めます。
`node:fs` を差し替えて注入します——**道具は 1 バイトも変えません**
（`globalThis.fetch` の差し替えと同じ形）。

```
catalog  race-defensive → **cli-route**
         82 種類 = corpus 45 / cli-route 34 / defensive-invariant 3
両方向照合  この run で出た 79 種類・到達しないと宣言した 3 種類（実測と一致）
```

### ⚠️ **`io` へ fs を足したことは、この経路には効いていません**

実測（2026-08-15）:

```
同じ注入（node:fs の差し替え）を当てる
  io に fs が無い版（24b3916）  → SOURCE_ARCHIVE_MISSING
  io に fs を足した版           → SOURCE_ARCHIVE_MISSING
```

`node:fs` の差し替えは **ESM の named import にも効く**ので、
`io` を経由してもしなくても同じように踏めます。
つまり**この経路を踏むために `io` へ fs を足す必要はありませんでした。**

残す理由は先の話です——`main(args, io)` を抽出したあとは、
**global を差し替えずに fs を注入できる**ようになります。
いまは「そのための土台」であって、いま効いているわけではありません。
**効いていないものを効いていると書かないでおきます。**

### `toolVersion` は上げていません

判断の根拠（実測）:

```
出力           既存 9 経路すべて byte 一致
出しうる code   82 種類のまま（増減 0）
schemaVersion  2 のまま・配布 schema も不変
出力に出るか    reachability は出力に 0 件（対照: stableReasonCode は 1 件）
```

変わったのは **catalog の宣言だけ**で、受け手が読む値ではありません。
**受け手の分岐が変わらないので上げません。**

### `race-defensive` は語彙表に残しました

唯一の持ち主が `cli-route` へ移ったので**未使用**になりました。
消さずに残し、**未使用であることを試験で明示**しています
——使わない値が黙って残ると、次に誰かが「踏めない」の逃げ道に使うためです。
使いたくなったらその試験が落ちるので、そのとき「本当に踏めないのか」を先に測ります。

### 途中で基準が 1 度動きました

新しい経路の一時ディレクトリ名（`mkdtemp`）が `reason` に出るので、
**実行ごとに出力が変わりました。**基準は動く状態に依存させない方針なので、
置き場を `node_modules/.cache/trs-vanish/` の固定パスへ変えています。

既存 9 経路は**一度も動いていません**（新経路を足す前に byte 一致を確かめてから追加）。

### 固定パスにしたら、今度は並行実行で消し合いました

置き場を固定した直後、テスト一式で 2 件落ちました。**単独では通り、
`injectedRoutes` を使う 3 ファイルを同時に走らせると落ちる**という形です。

```
原因  固定パスを各試験ファイルの afterAll が消していた
      → まだ使っている隣のファイルの足元から消える
直し  この置き場は `keep`（呼び側が消す一覧）へ積まない
      node_modules/.cache の下なので残っても追跡されず、中身は毎回同じ
```

**「決定的にするために固定する」と「共有物になる」は同時に来ます。**
固定した瞬間、それは他の実行と共有されるものになります。

---

# 第3段の実施記録（2026-08-15）— `main(args, io)` の抽出

## **§3 の 2 択のうち、「返す」は選べませんでした**

計画（上の §3）は「`process.exit` を呼ばず、**投げるか返すへ**変える」と書いていました。
2 択のうち **「返す」は選べません。**呼び出し側 6 か所のうち
**5 か所が「その場で終わる」ことに依存**していて、`done()` の後ろに
コードがそのまま続いています（実測: 直後の行が 2997 / 3011 / 3021 / 3067 / 3226）。
返す形にすると、結果を出したあとも処理が進んでしまいます。

**投げる形にしました。**`done()` が `CliResult` を投げ、`main()` が受けます。
例外ですが**異常ではありません**——`done()` が呼ばれた時点で結果は確定していて、
あとは呼び出し元まで戻るだけです。

**上の §3 は書き換えていません。**あとから計画を結果へ寄せると、
「計画どおりだった」ようにしか読めなくなります。

> 最初この実施記録に「計画では返すと書いていた」と書きましたが、
> **計画書の次の行に「投げるか返すか」と書いてありました。**
> 自分の計画を読み違えて「計画と違った」と報告するところでした。

## やったこと

```
done()      io.exit を叩くのをやめ、**CliResult を投げる**
main()      本体を async 関数へ包み、args と io を受け取る
            configure() が引数と io から設定を作り直す
CLI 側      末尾へ移し、CliResult を受けて io.stdout / io.stderr / io.exit を叩くだけ
```

**`done()` を「返す」形にはできませんでした。**呼び出し側 6 か所のうち
**5 か所が「その場で終わる」ことに依存**していて、後続のコードがそのまま続きます。
返す形にすると流れが壊れるので、**投げて `main()` が受ける**形にしました。
例外ですが**異常ではありません**——`done()` が呼ばれた時点で結果は確定しています。

## 途中で 1 回止まりました

`main()` を非 async のまま包んだので、**本体の `await` が構文エラー**になりました。

```
SyntaxError: Unexpected reserved word
  const loaded = await (SOURCE_DIR
```

基準が**全 10 経路で不一致**になったので、そこで止めて中身を見ました
（最初に見た表示は 1 経路ぶんの切り取りで、実際は全件でした）。
`async` にして解消しています。

## 検証

```
全 10 経路が基準と byte 一致（stdout / stderr / 終了コード）
  基準は分離前（dab485c2260c / toolSha256 b208399106bb1d97…）のまま
toolVersion    20 のまま
schemaVersion  2 のまま
catalog        82 種類のまま
判定ロジック    差分 0 行（触ったのは出口の形と設定の作り方だけ）
```

## **`io` の注入だけで踏めるようになりました**

v0.6.18 では「`io` へ fs を足したが、この経路には効いていない」と書きました。
**抽出が済んだいま、効きます。**

```
global を 1 つも差し替えず、io だけを渡して main() を呼ぶ
  → SOURCE_ARCHIVE_MISSING / exit 2
  対象 path の existsSync が呼ばれた回数 = 2（1 回目は通し、2 回目で false）
対照  差し替えなければ、同じ引数で別の code になる
```

`test/mainInjection.test.ts` に 7 件。`main()` が `io` しか見ていないこと
（`cwd` を差し替えると manifest を見失う）、引数を `args` から取ること
（`process.argv` を見ていない）も確かめています。

## `_cliRoutes.mjs` は移しませんでした

**`io` 注入は子プロセスへは効きません。**あの表は `spawnSync` で起動するので、
呼び出し側のオブジェクトは相手に届きません。**片方へ寄せられません。**

```
子プロセスの表   配った 1 ファイルを、受け手と同じ起動のされ方で踏む
                 → 終了コード・stdout の byte・入口の判定まで含めて確かめられる
io 注入          本体が io しか見ていないことを示す
                 → global を差し替えないので「差し替えが効いていただけ」を排除できる
```

**同じ code を別の入口から踏みます。**どちらか一方では足りません。

## 次にできること

`io` に fetch を足せば、`SOURCE_FETCH_*` も global を差し替えずに踏めます。
**この版ではやりません**——接点の追加であって抽出ではないためです。
