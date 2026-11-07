# 開発用の依存に出ている脆弱性の切り分け（v0.6.26 の下調べ）

**下調べだけである。版は上げていない。`package.json` も `package-lock.json` も変えていない。**
`npm audit fix` も回していない（前例: `docs/NPM_AUDIT_20260814.md`）。

```
実行日        2026-11-05
基点          main 70b260e（v0.6.25）・下の行番号はこの時点の物
実行          npm audit --json                 （終了コード 1）
              npm audit --omit=dev --json      （dependencies 側だけ）
node / npm    v22.23.4 / 10.9.9
lock          package-lock.json だけ（pnpm-lock.yaml・yarn.lock は無い）
```

## 件数（数え直し）

| | package の数 | 知らせ（GHSA）の数 |
|---|---|---|
| 全体（`npm audit`） | **6**（high 4 ／ moderate 2 ／ critical 0） | 37（重なりを除くと 36） |
| dependencies 側だけ（`--omit=dev`） | **0** | 0 |

- **10/26 の 6 件と同じ数である**（package の数で数えたとき）。知らせの ID を package ごとに足すと 37 件
  （下の表の内訳 5＋1＋2＋10＋1＋18）、`GHSA-82fw-gwwq-j7x9` が vitest と @vitest/mocker の両方に出るので、
  重なりを除くと 36 件である。
  > 取り込むときに数え直した（2026-11-08・`npm audit --json` の `vulnerabilities.<名前>.via`）。
  > 最初の稿は 40 件と書いていたが、表の内訳とも合っていなかった。package の数・深刻度・版は同じだった。
  6 件の深刻度は npm audit が package ごとに付ける「その package の知らせのうち一番重いもの」。
- **6 件とも lock 上 `"dev": true`** で、`dependencies`（three / react / react-dom / @react-three/fiber /
  @react-three/drei / zustand）からは入らない。
- **この repo は Dependabot の知らせを有効にしていない**（2026-11-08・
  `gh api repos/Driedsandwich/trs-jack-3d/dependabot/alerts` が
  `Dependabot alerts are disabled for this repository.` を返す）。
  上の数は `npm audit` だけの数である。有効にするかは repo の設定の変更なので、ここでは触っていない。

## 一覧（1 package ＝ 1 行）

| # | package と版 | 深刻度 | 知らせの ID | 入り口（直の依存 → … ） | どこで読み込まれるか | 配布物に入るか | 踏む経路 | 推奨の手 | 手で門が変わるか |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `vite@8.1.5` | high | GHSA-587h-7wmj-h5pm (high)・GHSA-r825-w8mm-5pxw・GHSA-698v-4r3x-3vcv・GHSA-rq7h-c2jc-7f22 (moderate)・GHSA-9jrq-w75r-8gcw (low) | **直の依存**（devDependencies） | `npm run dev`／`preview`／`build`、vite-node の全台本、vitest の中 | **入らない** | **条件付きで有る**（開発機で `npm run dev` を動かしている間だけ） | `vite@8.1.6` 以上へ（`^8.1.1` の中・lock だけ） | lock が動く → 下の「共通」 |
| 2 | `vitest@4.1.10` | moderate | GHSA-82fw-gwwq-j7x9 (moderate) ＋ #3 経由 | **直の依存**（devDependencies） | `npm run test`（CI の「単体テスト」） | 入らない | 無い | `vitest@4.1.12` へ（#3 と同時に直る・`^4.1.10` の中・lock だけ） | lock が動く ＋ テストの走り手が変わる |
| 3 | `@vitest/mocker@4.1.10` | moderate | GHSA-82fw-gwwq-j7x9・GHSA-qxg6-89mg-rqv8 (moderate) | `vitest` → `@vitest/mocker`（`4.1.10` に完全固定） | vitest の中 | 入らない | 無い | #2 で一緒に上がる（単独では上げない） | #2 と同じ |
| 4 | `fast-uri@3.1.5` | high | GHSA-5jgf-p345-68v8・GHSA-f65p-4m7j-42xc・GHSA-fph4-wmhf-6fwf・GHSA-jqff-g426-hqxp・GHSA-qw65-cvwx-89v3 (high)・GHSA-hrr3-gc8f-f4qj・GHSA-w74x-v6f9-j3xg・GHSA-wjr9-j795-jxcr (moderate)・GHSA-xhq7-xmqj-769h・GHSA-333x-w4r6-6crp (low) | `ajv@8.20.0` → `fast-uri`（`^3.0.1`） | ajv を使う台本 4 本と試験 12 本・CI の「単体テスト」「成果物の検証」 | 入らない | 無い | `fast-uri@3.1.9` へ（`^3.0.1` の中・lock だけ） | lock が動く → 下の「共通」 |
| 5 | `source-map-js@1.2.1` | high | GHSA-68fv-2mgg-jv7q (high) | `vite` → `postcss@8.5.25` → `source-map-js`／`jsdom` → `css-tree@3.2.1` → `source-map-js` | `vite build`・`vite` dev の CSS 処理（postcss）。jsdom 側は読み込まれない | 入らない | 無い | `source-map-js@1.2.2` へ（`^1.2.1` の中・lock だけ） | lock が動く → 下の「共通」 |
| 6 | `undici@8.9.0` | high | GHSA-rfgv-xxqx-mfg5・GHSA-w293-vg96-wgc3・GHSA-xjj6-f33q-929c・GHSA-4w7w-5xrc-9h26・GHSA-2m5v-pch6-74hx・GHSA-qrxm-fqhp-jwvm (high) ほか moderate 9・low 3（計 18） | `jsdom@30.0.1` → `undici`（`^8.9.0`） | **どこでも読み込まれない**（jsdom を使う試験も台本も 0 件） | 入らない | 無い | `undici@8.12.2` 以上へ（`^8.9.0` の中・lock だけ）。**または jsdom を外す**（下を参照） | lock が動く → 下の「共通」 |

知らせの全 ID と影響する版の範囲は `npm audit --json` の `vulnerabilities.<名前>.via` にある。

## 配布物に入らないことの確かめ

**配布するものは JSON・schema と、検算器 `scripts/verifyReleaseSourceInputs.mjs` の 1 本である**
（`scripts/releaseAssets.mjs:22-120`・検算器は `:118` の `role: 'tool'`）。

- **検算器の import は `node:` の組み込みだけ**（`scripts/verifyReleaseSourceInputs.mjs:42-47`）。
  6 package のどれも読み込まない。
- **検算器の `fetch`（`:603`・`:2915`）は Node に同梱の fetch** で、#6 の npm の `undici@8.9.0` とは別物である。
  Node 同梱の undici の版はこの切り分けの外（Node の版で決まる）。
- **source snapshot は `node_modules` を入れない**（`scripts/buildSourceSnapshot.mjs:156`）。
  入るのは `package-lock.json` の文字列だけ（`:57`）で、実行される部品ではない。
- **ビューアの build 成果物**: `npx vite build` を scratch の出力先へ回し、
  出力（js 1・css 1 ほか）を `launch-editor|source-map-js|undici|fast-uri|__vitest` で grep して **0 件**。
  （ビューアは配布資産の一覧に入っていない。）

## 踏む経路の根拠（1 件ずつ）

### #1 vite — 条件付きで有る（開発機・dev を動かしている間だけ）

- 5 件のうち **2 件は Windows でだけ起きる**（GHSA-698v-4r3x-3vcv・GHSA-587h-7wmj-h5pm、launch-editor の Windows 向け処理）。
  CI は ubuntu と macOS（`.github/workflows/ci.yml:50`）で、開発機は macOS と書かれている
  （`.github/workflows/ci.yml:35`）。**この 2 件は今の使い方では当たらない**（Windows で開発する人が出れば当たる）。
- 残り 3 件（launch-editor の引数の取り違え・`server.fs.allow` の外のファイル・custom middleware 経由の cross origin）は
  **dev server が HTTP を受けている間だけ**の話である。
  - `/__open-in-editor` は dev server を作るとき（`_createServer`）に付く
    （`node_modules/vite/dist/node/chunks/node.js:26028`・`:25775`）。
  - dev server を立てるのは `npm run dev`（`package.json:8`）だけで、
    `screenshots`・`perf`・`touch` はそれを前提に `http://localhost:5173` を開く（`scripts/screenshots.mjs:7,15`）。
  - `vite.config.ts:5-7` に `server.host` は無く、待ち受けは localhost に限られる。
    **外からの入力は「同じ機械のブラウザで開いたページ」か「同じ機械の他のプロセス」に限られる。**
- **CI では踏まない。**CI は `npm run build`（`.github/workflows/ci.yml:128`）だけで、dev server を立てない。
- **vite-node と vitest は HTTP を待ち受けない。**vite-node は `createServer` を呼ぶが `listen` しない
  （`node_modules/vite-node/dist/cli.mjs:61`・同 dist に `.listen(` は 0 件）。
  vitest は `middlewareMode: true`・`ws: false` で作る（`node_modules/vitest/dist/chunks/cli-api.BK8pd4xc.js:10339-10343`）。

### #2・#3 vitest／@vitest/mocker — 無い

- 2 件とも mock の差し替え（redirect mock・mock の登録）の処理である。
  登録を受ける窓口は `@vitest/mocker` の `interceptorPlugin` の ws ハンドラ
  （`node_modules/@vitest/mocker/dist/node.js:186-212`）で、**これを使うのは browser mode（`@vitest/browser`）だけ**。
  `@vitest/browser` は入っていない（`node_modules/@vitest/` は expect・mocker・pretty-format・runner・snapshot・spy・utils）、
  vitest 本体の dist に `interceptorPlugin` の参照は 0 件。
- この repo の試験は `environment: 'node'`（`vitest.config.ts:6`）、
  `vi.mock`／`vi.doMock`／`__mocks__` は `test/`・`src/`・`scripts/` で 0 件。
  `--ui`・`--api`・`browser:` の指定も 0 件（`package.json:12` は `vitest run`）。
- 試験の入力は repo の中のファイルだけ。

### #4 fast-uri — 無い

- fast-uri を呼ぶのは ajv の URI 処理（`node_modules/ajv/dist/runtime/uri.js`）で、
  ajv はこれを **schema の `$id`／`$ref` の解決**に使う。
- **schema の `format` は 0 件**（`git grep -c '"format"' -- schemas` が何も返さない）、
  `ajv-formats` も入っていない。だから **データの文字列が fast-uri へ渡る経路は無い**。
- ajv が読む schema は repo の `schemas/` の中だけ：
  `scripts/validateProfiles.mjs:28,41,47`・`scripts/stageRelease.mjs:20,318`・
  `scripts/buildReleaseEvidence.mjs:26`・`scripts/measurementSheet.mjs:14`、試験 12 本（`test/*.test.ts` の `import Ajv`）。
  過去 tag の schema を `git show` で読む試験もあるが、それも repo の履歴である。
- **検算器は ajv を読まない**（上の「配布物」）。外から来る release の中身は検算器が `node:` だけで扱う。

### #5 source-map-js — 無い

- postcss 側: `vite build`／dev の CSS 処理で動く。読む CSS と source map は repo の中のものだけで、
  知らせの条件（細工した indexed source map の section offset）を外から入れる経路は無い。
  `vite.config.ts` は `build.sourcemap` を指定していない。
- css-tree 側: `jsdom` からしか入らず、jsdom は読み込まれない（#6）。

### #6 undici — 無い（読み込まれない）

- 入り口は `jsdom` だけ（lock 上、`undici` を要求するのは `node_modules/jsdom` だけ）。
- **jsdom を使う箇所は 0 件**：`git grep -n "jsdom"` は `package.json:65`・`package-lock.json`・
  `artifacts/source-snapshot.v1.json`（lock の写し）にしか当たらない。
  試験は `environment: 'node'`（`vitest.config.ts:6`）で、ファイル単位の `@vitest-environment` 指定も 0 件。
- `jsdom` は vitest の optional peer で、vitest は指定されない限り読み込まない。
- jsdom が足された経緯は確かめていない（lock に最初に出るのは `718a52d`）。

## 直す手と、そのとき動く門

### 推奨（すべて lock だけで済む）

| package | 今 | 上げ先（最小） | 範囲の中か |
|---|---|---|---|
| vite | 8.1.5 | 8.1.6 | `^8.1.1` の中 |
| vitest（＋@vitest/mocker） | 4.1.10 | 4.1.12 | `^4.1.10` の中 |
| fast-uri | 3.1.5 | 3.1.9 | ajv の `^3.0.1` の中 |
| source-map-js | 1.2.1 | 1.2.2 | `^1.2.1` の中 |
| undici | 8.9.0 | 8.12.2 | jsdom の `^8.9.0` の中 |

**`package.json` を変えずに直せる。**上げ先の版は 2026-11-05 に `npm view` で実在を確かめた。
**手元では 1 つも上げていない**ので、上げて試験が通るかは未確認である。

**別案（#5 の css-tree 経路と #6 をまとめて消す）**: 使われていない `jsdom` を devDependencies から外す。
**`package.json` が変わる**ので lock だけの手より大きい。外すかは持ち主が決めること。

### 共通：lock が動くと何が変わるか

**どの手でも `package-lock.json` が変わり、次の門が反応する。**

- profile の `provenance.inputDigest` の対象に lock が入っている → `npm run check:stale` が「古い」と言う。
  profile の作り直しが要る（`scripts/checkStale.ts:140`・`scripts/provenance.ts:154`）。
- source snapshot は lock の中身を写す（`scripts/buildSourceSnapshot.mjs:57`）→ snapshot の作り直しが要る。
- テスト証拠の入力に lock が入っている（`scripts/measureTests.mjs:138`）→ テスト証拠の取り直しが要る。
- #2 はテストの走り手そのものが変わる。テスト件数は変わらない見込みだが、
  `.vitest-report.json` の形が変わらないかを `check:test-evidence-current` で見る必要がある。
- #1 は `npm run build` の出力が変わりうる（ビューアは配布資産ではない）。

**だから 5 つを 1 回の lock の更新にまとめ、版の頭でやる**のがよい。
release の直前に依存を動かさない、という前例（`docs/NPM_AUDIT_20260814.md` の「方針」）と同じ。

**v0.6.26 では入れなかった（2026-11-08 の決め）。**v0.6.26 は検算器の判定を変える版（tool v21）で、
lock を動かすと上の作り直しが同じ版に重なり、何で記録が変わったのかを分けて追えなくなる。
上げるのは次の版（v0.6.27）の頭にする。それまでの間、条件付きで踏むのは #1 だけで、
**`npm run dev` を開いている間だけ**である（待ち受けは localhost）。

## この調べで回したもの

- `npm audit --json`・`npm audit --omit=dev --json`
- `npm ci --ignore-scripts`（読み込み先を確かめるため。**lock は変わっていない**：`git status` は空のまま）
- `npx vite build --outDir <scratch>`（repo の `dist/` には書いていない）
- `npm view <名前> versions`（上げ先の実在の確認）

**「踏まない」と書いた根拠は、上に挙げたファイルと行・grep の件数だけである。**
各 package の修正の差分そのものは読んでいない。
