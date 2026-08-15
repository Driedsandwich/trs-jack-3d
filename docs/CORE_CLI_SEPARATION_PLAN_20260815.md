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

## 次にできるようになったこと

`SOURCE_ARCHIVE_MISSING` を実経路として踏むには、`io` へ filesystem を足して
「`existsSync` は通るが `readFileSync` が ENOENT」を注入します。
**この版ではやりません**（`io` に filesystem を足すのは接点の追加であって、
抽出ではないため）。次の作業として分けます。
