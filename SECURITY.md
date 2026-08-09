# セキュリティについて

## 報告のしかた

**GitHub の private vulnerability reporting を使ってください。**

このリポジトリの **Security** タブ →
**Report a vulnerability** から、非公開でやりとりできます。

- **Issue へは書かないでください。**Issue は公開されます。
- メールアドレスはここに載せていません。上の経路なら、
  報告する側も受ける側もアドレスを明かさずに済みます。

返信の目安は **7 日**です。個人が趣味で維持しているリポジトリなので、
それ以上かかることがあります。急ぐ場合はその旨を書いてください。

## 何を報告してほしいか

| | |
|---|---|
| ✅ | **配布物を読む側が害を受けうるもの。**同梱の `verifyReleaseSourceInputs.mjs` に、細工した archive で任意のファイルを書かせる・読ませる・止められる経路があるなど |
| ✅ | ビューア（`npm run dev` / build 成果物）で、開いただけで害があるもの |
| ✅ | リポジトリや release に、意図せず秘密情報が入っているのを見つけたとき |
| ✅ | 依存パッケージの既知脆弱性で、**このプロジェクトの使い方で実際に踏むもの** |

依存の脆弱性は、**踏む経路を添えてください。**`npm audit` の出力だけだと、
この使い方では到達しないものが大半で、切り分けから始めることになります。

## 対象の範囲

**対象**

- `main` の最新
- 直近の release 1 本（現時点では v0.6.5）

**対象外**

- それより古い release。**過去の release asset は上書きしません**（immutable に残します）。
  古い版に問題があった場合は、**新しい版で直して、古い版に問題があることを notes へ書きます。**
- `docs/` の文章の誤り。これは security ではなく、通常の Issue でお願いします。
- 開発時のみ使うもの（`test/` の道具・`scripts/` のうち release に同梱していないもの）。
  ただし**同梱しているもの**（`verifyReleaseSourceInputs.mjs`）は対象です。

## **このプロジェクトが保証しないこと**

ここは security の話より先に、**何を売っていないか**の話です。

### 配布している artifact は「モデルの出力」です

`half_plug_topology_profile.v3.*.json` に入っている区間・event・接点状態は、
**寸法モデルを走査した計算結果**であって、実物を測った値ではありません。

```
modelLimitations.verifiedPhysical   false
```

**この値が `false` である限り、実物との突き合わせは 1 件も済んでいません。**
2026-08-06 時点で `false` です。判定は
[docs/VERIFIED_PHYSICAL_GATE.md](docs/VERIFIED_PHYSICAL_GATE.md) の条文に従って
`docs/measurements/measurement-records.v1.json` の記録から機械で決まります。
**記録は 0 件です。**

- 根拠の区分は `FACT`（一次情報）/ `DERIVED`（演算）/ `ASSUMPTION`（仮定）で、
  **`ASSUMPTION` が 54 件あります**（`artifacts/verification_summary.json`）。
- ジャック内部の接点ばね寸法は**すべて仮定**です（[UNKNOWNS.md](UNKNOWNS.md) §3）。
- **導通・音響の実測はしていません。**

**この artifact を、安全性に関わる判断の根拠にしないでください。**
機器の設計・適合性の判断・事故の原因究明などに使う場合、
**実物で測り直してください。**手順は
[docs/VERIFICATION_PLAN.md](docs/VERIFICATION_PLAN.md) にあります。

### 検算ツールが保証する範囲

同梱の `verifyReleaseSourceInputs.mjs` は、
**「配布物に記録された入力の sha256 が、tag の source と一致するか」**を計算し直すだけです。

- **こちらの自己申告が正しいことは証明しません。**
  同じ人が作った manifest と、同じ人が push した source を比べています。
- **モデルが正しいことも証明しません。**入力が記録どおりであることしか見ていません。
- v0.6.0（`toolVersion` 5）で、信頼できない archive に対して安全に止まるようにしましたが、
  **すべての細工に耐えることは示していません。**26 個・6 種類で試験した範囲までです
  （[docs/release/verify-tool-v5-notes.md](docs/release/verify-tool-v5-notes.md)）。
  **現に、塞いだつもりの穴が繰り返し残っていました。**
  v5 → v6 で 3 つ（同名 entry の後勝ち・ディレクトリ入力の symlink ループ・圧縮入力の上限なし）、
  v6 → v7 で 2 つ（同じ場所を指す別の綴り・読み飛ばす entry との衝突）、
  v7 → v8 で 3 つ（PAX の上書き・読み飛ばす entry の正規化漏れ・パス末尾の空白）、
  v8 → v9 で 3 つ（名前の上書きが 2 つ効く形・展開されるのに数えない entry・不正 UTF-8 の置換）、
  v9 → v10 で 4 つ（ディレクトリか確かめずに先頭階層を剥がす・受理するのに展開できない
  archive・PAX の NUL 切り捨て・閉じていない denylist）、
  v10 → v11 で 3 つ（自分自身を指す hardlink・ディレクトリを指す hardlink・
  値が読めない PAX と中身を持てない型の本体）。
  **どれも外部監査の指摘で、こちらで反例を再現してから直しています。**
  v8 からは**ふつうの tar 展開を oracle にした差分試験**を置き、
  「検算が見た中身」と「展開してできる中身」が食い違ったら落ちるようにしました
  （[verify-tool-v8-notes.md](docs/release/verify-tool-v8-notes.md)）。
  **その差分試験自体に、版ごとに穴がありました。**
  v8 は片方向で「展開されるのに検算が数えない」欠陥を素通りし（v9 で逆向きを追加）、
  v9 は **oracle が 1 実装だけ**だったので、**oracle と同じ癖の欠陥を見つけられません**でした
  （v10 で python tarfile を必須 oracle に追加。
  [verify-tool-v10-notes.md](docs/release/verify-tool-v10-notes.md)）。
- **正当な archive を拒む欠陥が、2 版続けて見つかりました。**
  v9 は独立した 2 つの member がそれぞれ長い名前を使うだけで `ARCHIVE_INVALID` になり、
  v10 は **GNU の長い linkname（`K`）と PAX `linkpath` を拒んで**いました
  （どちらも 4 実装すべてが展開できる形です。v10 / v11 でそれぞれ修正）。
  **塞ぎすぎは「実物が通る」確認では見つかりません**——この repo の実物は
  最長パス 95 文字で、これらの機構を使わないためです。
- **手元で確かめられないことは、確かめられないと書きます。**
  v11 の 2 件（値が読めない PAX・中身を持てない型の本体）は、
  **こちらの 2 実装（bsdtar / python）では再現していません。**
  監査の GNU tar・BusyBox の結果と、構造の理屈にもとづいて直しました
  （[verify-tool-v11-notes.md](docs/release/verify-tool-v11-notes.md) §4）。

### そのほか

- **CI は read-only です**（`.github/workflows/ci.yml`・`permissions: contents: read`）。
  publish する経路を持ちません。action は full commit SHA で固定しています。
- **release asset は上書きしません。**v0.1.0 以降のすべての asset について、
  release のたびに byte 一致を確認しています。
- 依存は `package-lock.json` で固定しています。`npm ci` で入れてください。

## 直したあと

直したものは、**何が起きうる状態だったかを notes に書いて公開します。**
報告してくださった方の名前を載せるかどうかは、そのときに伺います。
**黙って直して黙って出すことはしません。**
