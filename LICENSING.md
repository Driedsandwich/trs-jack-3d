# どのファイルがどのライセンスか

このリポジトリは1つのライセンスで覆われていません。**コード・データ・同梱フォントで分かれています。**
この文書はその対応表です。ライセンス本文はそれぞれのファイルにあります。

> `LICENSE` にこの説明を書かないのは、GitHub のライセンス判定器が
> ライセンス本文だけのファイルを期待していて、説明文を足すと「Other」になってしまうためです。

---

## 対応表

| 対象 | ライセンス | 本文 |
|---|---|---|
| `src/`（`src/data/*.json` を除く）・`scripts/`・`test/`<br>`index.html`・`vite.config.ts`・`vitest.config.ts`・`tsconfig*.json`<br>`.oxlintrc.json`・`.gitignore`・`package.json`・`package-lock.json`・`.claude/launch.json` | **MIT** | [LICENSE](LICENSE) |
| `public/` （`public/fonts/` を除く） | **MIT** | [LICENSE](LICENSE) |
| `src/data/*.json`・`artifacts/`・`docs/`・ルートの `*.md` | **CC BY 4.0** | [LICENSE-ASSETS.md](LICENSE-ASSETS.md) |
| `public/fonts/` | **SIL Open Font License 1.1** | [public/fonts/OFL.txt](public/fonts/OFL.txt) |
| メーカーのデータシート・CAD・図面 | **本リポジトリに含まれていません** | [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |

`src/data/index.ts` は JSON を読んで型付きモデルを組み立てる実装コードなので、
データ（CC BY 4.0）ではなく**コード（MIT）**の扱いです。

## 迷いやすいところ

**「寸法の数値そのものは誰のものか」** — 数値は事実であって著作物ではありません。
CC BY 4.0 で提供しているのは数値そのものではなく、どこから採ったかという編集・注釈、
記載値から導出した値、資料が無い箇所に置いた仮定の部分です（[LICENSE-ASSETS.md](LICENSE-ASSETS.md) §3）。

**「3D 形状はメーカー CAD の派生物か」** — 違います。メーカーの CAD も図面画像も
一切含んでおらず、形状は公開寸法から自前で生成しています（[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）。

**「同梱フォントは自由に使えるか」** — Noto Sans JP のサブセットで、SIL OFL 1.1 に従います。
再配布するときは `public/fonts/OFL.txt` を一緒に配ってください
（[public/fonts/README.md](public/fonts/README.md)）。

## 商標

「Lumberg」は Lumberg Holding GmbH & Co. KG の商標です。
本プロジェクトは同社と関係がなく、承認も受けていません。
部品番号の記載は、どの実在部品を参照したかを示す目的のみで使用しています。

## 免責

寸法の正確性を保証しません。**設計・製造・調達の根拠に使わないでください。**
ジャック内部の接点寸法は 37 件の仮定を含み、実物と突き合わせた検証は済んでいません
（[UNKNOWNS.md](UNKNOWNS.md)・[docs/VERIFICATION_PLAN.md](docs/VERIFICATION_PLAN.md)）。
必要な数値は必ずメーカーの一次資料で確認してください。
