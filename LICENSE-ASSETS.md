# LICENSE-ASSETS — データ・生成物・文書のライセンス

コード以外（寸法データ・生成成果物・スクリーンショット・文書）は
**[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.ja)** です。
コードは MIT で別扱いです（[LICENSE](LICENSE)）。同梱フォントは SIL OFL 1.1 です。
ファイル単位の対応表は [LICENSING.md](LICENSING.md) にあります。

---

## 1. 対象

| 対象 | 中身 |
|---|---|
| `src/data/` の **`.json`** | 寸法・プラグセグメント・ジャック接点・材料・出典・故障プリセット |
| `artifacts/` 配下すべて | 走査結果・力曲線・イベント・比較行列・検証記録 |
| `docs/` 配下すべて（サブディレクトリを含む） | 検証結果・納品報告・実物突き合わせ計画・公開前監査・スクリーンショット 19 枚・測定記録 |
| ルートの `.md` すべて | `README.md` `SOURCES.md` `ASSUMPTIONS.md` `UNKNOWNS.md` `THIRD_PARTY_NOTICES.md`・本ファイル |

### この文書の対象外

| 対象 | どちらか |
|---|---|
| `src/` のうち **`src/data/*.json` 以外すべて**（`src/data/index.ts` を含む） | MIT → [LICENSE](LICENSE) |
| `scripts/` `test/` `index.html`・各設定ファイル | MIT → [LICENSE](LICENSE) |
| `public/fonts/` | **SIL OFL 1.1**。第三者のフォントなので、どちらのライセンスも及びません |
| `public/` の残り（`favicon.svg`） | MIT → [LICENSE](LICENSE) |

`src/data/index.ts` は JSON を読んで型付きモデルを組み立てる実装コードなので、データではなくコード扱いです。

## 2. 条件

自由に使えます。複製・改変・再配布・商用利用のいずれも可です。条件は**表示**だけです。

```
3.5 mm TRS 接合機構ビューア (Driedsandwich) / CC BY 4.0
https://github.com/Driedsandwich/trs-jack-3d
```

改変した場合はその旨を書いてください。原著者が改変版を推奨しているかのような書き方はしないでください。

---

## 3. これはメーカー資料の派生物ではありません

**ここが本プロジェクトで一番はっきりさせておきたい点です。**

| 項目 | 実際にやったこと |
|---|---|
| メーカーの CAD（STEP・3D PDF） | **ダウンロードしていない。中身も見ていない** |
| メーカーの図面画像 | **リポジトリに一切含まれていない**。線画を複製・トレースしていない |
| 3D 形状 | `src/data/*.json` の数値から実行時に生成。形状データを外部から持ち込んでいない |
| スクリーンショット | 本アプリ自身の画面 |
| テクスチャ・環境マップ | 使用していない |
| フォント | 3D 内テキスト用に **Noto Sans JP のサブセット（SIL OFL 1.1）を同梱**。CC BY 4.0 の対象外で、OFL 1.1 に従う（[public/fonts/README.md](public/fonts/README.md)） |

ページ読み込み時の外部ホストへのリクエストは 0 件です（Playwright で実測確認）。

判断の根拠と各社の規約は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) にまとめてあります。

### 寸法の数値について

データシートに書かれた寸法**値**（φ3.5、14 mm など）は事実であって著作物ではありません。
本プロジェクトはその事実を出典つきで利用しています（[SOURCES.md](SOURCES.md)）。

CC BY 4.0 で提供しているのは、その事実そのものではなく、

- どの数値をどこから採ったかという**編集・注釈**（各項目の note と FACT/DERIVED/ASSUMPTION 区分）
- 記載値から演算・図面実測で**導出した値**
- 資料が無い箇所に**明示的に置いた仮定**（[ASSUMPTIONS.md](ASSUMPTIONS.md)）

の部分です。元の事実そのものに独占的な権利を主張するものではありません。

## 4. このライセンスが与えないもの

- Lumberg の資料・CAD・図面・商標に対する権利は**一切含みません**。
  「Lumberg」は Lumberg Holding GmbH & Co. KG の商標です。
  本プロジェクトは同社と関係がなく、承認も受けていません。
- 寸法の正確性の保証を含みません。**設計・製造・調達の根拠に使わないでください。**
  ジャック内部の接点寸法は 37 件の仮定を含み、実物と突き合わせた検証は済んでいません
  （[UNKNOWNS.md](UNKNOWNS.md)・[docs/VERIFICATION_PLAN.md](docs/VERIFICATION_PLAN.md)）。
  必要な数値は必ずメーカーの一次資料で確認してください。

## 5. ソフトウェア依存

`package.json` の依存パッケージのライセンスは
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) §5 を参照してください。
直接依存はすべて MIT または Apache-2.0 で、本リポジトリには同梱していません（`npm install` で取得）。
