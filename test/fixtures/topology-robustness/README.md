# 窓の端点の test vector（v0.3.0 フォローアップ P1-4）

`topology-robustness` schema v2 の consumer が、**窓の端点を自分の実装で正しく扱えているか**を
確かめるための 3 件。`test/robustnessWindowFixtures.test.ts` が使い、
下流も同じファイルを取って自分の実装に通せる。

## 何を確かめるためのものか

v1 では `toMm` が「最後に当たった標本の位置」なのに「終わり」と読める名前だった。
profile の区間終端と 1 刻みずれて見え、**同じ語で 2 つの違う量を指していた。**
v2 で `lastSampleMm`（観測の最後の点）と `endExclusiveMm`（区間の終端）に分けた。

| fixture | 何が起きているか | **どの層が弾くか** |
|---|---|---|
| `valid-exclusive-window.json` | 正常 | 弾かれない（両方通る） |
| `invalid-legacy-toMm.json` | 旧 v1 の `fromMm` / `toMm` が残っている | **schema**（`required` と `additionalProperties: false`） |
| `invalid-lastSample-equals-endExclusive.json` | `lastSampleMm == endExclusiveMm` | **意味検査**（schema は通す） |

## 3 番目が要る理由

**draft-07 では項目どうしの大小を書けない。**`lastSampleMm < endExclusiveMm` は schema で表現できず、
実際に流すと schema は通る（2026-08-03 実測）。
つまり「schema を通ったから窓は正しい」は成り立たない。

この条件を見ているのは `scripts/robustnessWindows.mjs` の `checkWindow` だけである。
consumer 側でも、schema 検証とは別に端点の大小を検査すること。

`lastSampleMm == endExclusiveMm` は「区間の外側で観測した」という意味になり、
`windowEndConvention: "EXCLUSIVE"` の約束と矛盾する。

## 使い方

```bash
# schema 検証だけでは 3 番目を通してしまうことを確認する
npx ajv validate -s schemas/topology-robustness.v2.schema.json \
  -d test/fixtures/topology-robustness/invalid-lastSample-equals-endExclusive.json
```

## 中身について

**実データではない。**`artifacts/topology-robustness.trs_jack_trrs.json` を元に、
`counterExamples` を 1 件、`presenceByLevel` を 1 軸 2 水準まで削ってある。
件数の整合（`configurationsTotal` の内訳など）は保っていないので、
**頑健性の主張の根拠には使えない。**窓の端点だけを見るためのもの。

検証の範囲も窓に限る。`validateProfiles.mjs` の `robustness` は
profile との突き合わせなど他の規則も見るので、fixture には通らない（通す意図もない）。
