# 正誤表

**公開した release 本文は編集しない。**編集すると、受け手が読んだ文と手元の控えがずれ、
しかも本文のほうが黙って書き換わるので、「いつ何が直ったか」が誰にも分からなくなる。
代わりに、**公開後に見つかった誤りをここへ積む。**

各項目には、**誤りに気づいた方法**と**実測の手順**を書く。
読んだ人が同じ結果を再現できないなら、訂正になっていない。

---

## v0.6.11（2026-08-12 記載）

### 1. **`VERIFICATION_INCOMPLETE` になる tag の範囲が違う**

| | |
|---|---|
| 誤 | 「**v0.3.0 より前の tag** を検算すると、これに当たります」 |
| 正 | 「**v0.4.0 より前の tag** を検算すると、これに当たります」 |
| 場所 | release notes 冒頭「⚠ 先に読むところ」の 1 番目 ／ `verify-tool-v16-notes.md` の同じ節 |

**`v0.3.0` 自身も対象**である。範囲定義（`manifest.inputScope`）が入ったのは **v0.4.0** から。

```
tag ごとに、その tag の source に対して同梱の検算ツール（toolVersion 16）を回した結果
  v0.1.0 / v0.1.1   manifest 自体が無い（MANIFEST_UNAVAILABLE）
  v0.2.0            VERIFICATION_INCOMPLETE   incompletePhases=["unrecorded-input-detection"]
  v0.3.0            VERIFICATION_INCOMPLETE   同上
  v0.4.0            OK                        incompletePhases=[]
  v0.4.1            OK
```

再現手順（21 tag すべてで回せる）:

```sh
T=$(mktemp -d); git archive v0.3.0 | tar -x -C "$T"
node scripts/verifyReleaseSourceInputs.mjs \
  --manifest "$T/artifacts/source-input-manifest.json" --source "$T"
# → status=VERIFICATION_INCOMPLETE / exit 1
```

**なぜ間違えたか。** 境界を実際に走らせずに書いた。`inputScope` を足した版を思い違いしていた。
**「より前」と書く前に、その版そのものを踏むこと。**

> tag ごとの `inputScope` の有無を数えるときは、`"$t:artifacts/..."` と書かないこと。
> zsh は `$t:a` をパス修飾子として解釈するので、**全 tag が同じように「無い」と出る。**
> `${t}:artifacts/...` と書く。これで一度、誤った結論を出しかけた。

### 2. **「通す材料 66 件」は誰も検査していない旗の数だった**

| | |
|---|---|
| 誤 | 「うち『通す』材料が 59 → **66 件**」 |
| 正 | 実際に通る材料は **72 件** |
| 場所 | release notes 「塞ぎすぎていないこと」節 ／ `verify-tool-v16-notes.md` の同じ節 |

corpus が**同じ境界を 2 つの一覧**で持っていた。材料ごとの `ok` 旗と、期待値表である。
**検査されていたのは期待値表だけ**で、旗は 1 か所から `!ok` としてしか読まれておらず、
**`ok: true` が本当に通ることは一度も確かめられていなかった。**両者は 10 件でずれていた。

v0.6.12 で旗を消し、判定を `test/_tarExpectations.mjs` の期待値表へ一本化した。
数は試験が固定する（`通る材料は 72 件`）。

### 3. **同梱 artifact が status を 5 種類と書いていた**

| | |
|---|---|
| 誤 | 配布物 `source-verification-result.json` の `howToVerifyYourself`: 「status は OK(0) / MISMATCH(1) / SOURCE_UNAVAILABLE(2) / MANIFEST_UNAVAILABLE(2) / NOTHING_TO_VERIFY(2)」 |
| 正 | 同梱ツールは **8 種類**返す。`VERIFICATION_INCOMPLETE(1)` / `ARCHIVE_INVALID(2)` / `ARCHIVE_UNSUPPORTED(2)` が抜けていた |
| 場所 | **配布物そのもの**（release notes ではない） |

**これは文書の誤りではなく、配布物の誤りである。**
足りない 3 つは v0.6.10 と v0.6.11 で足したもので、
とくに `VERIFICATION_INCOMPLETE` は **v0.6.11 の目玉**なのに受け手に伝わっていなかった。

**v0.6.11 の配布物を使う場合は、この行を読まないこと。**
`verifyReleaseSourceInputs.mjs` が返す値が正しく、`schemas/source-verifier-cli-result.v1.schema.json`
の `status.enum`（8 種類・同じ配布物に入っている）がその正本である。

v0.6.12 で、この行は道具の定数から生成するようにした。

---

## v0.6.12 以前（2026-08-12 記載・**v0.6.13 で直しました**）

### 4. **検算ツールを別名で走らせると、何も出さずに `exit 0` で終わる**

| | |
|---|---|
| 対象 | v0.6.12 までに配布した `verifyReleaseSourceInputs.mjs` **全部** |
| 症状 | コピーの名前を変える／symlink を張ると、**検算せずに終了コード 0** を返す |
| 影響 | **終了コードだけを見る受け手には、合格と区別が付かない** |
| 直した版 | v0.6.13 |

原因は入口の判定がファイル名の正規表現（`/verifyReleaseSourceInputs\.mjs$/`）だったこと。

```
実測（2026-08-12・v0.6.12 の道具）
  verifyReleaseSourceInputs.mjs   exit 0 / 出力 4,318 バイト
  renamed.mjs                     exit 0 / 出力     0 バイト
  link.mjs（symlink）             exit 0 / 出力     0 バイト
```

再現手順:

```sh
cp verifyReleaseSourceInputs.mjs renamed.mjs
node renamed.mjs --manifest source-input-manifest.json --source <展開した source>
echo "exit=$?"   # → exit=0 だが、標準出力は空
```

**同梱の手順どおり（名前を変えずに）回していれば起きません。**
黙る経路は JSON を 1 バイトも出さないので、**出力を読んでいたなら気づけています。**

**`toolVersion` は上げていません**（16 のまま）。判定は変わらず、
黙る経路は `toolVersion` を出さないので、受け手が「16 なのに挙動が違う」に出会う場面がないためです。
**v0.6.12 と v0.6.13 の道具は版数では見分けられません**——`tool.sha256` で見てください。

**気づいた経緯**: v0.6.12 の release 準備中に、新旧の道具の出力を比べようとして
旧版を別名でコピーしたところ、**旧版が黙って何も出さず**、それを一度「判定が変わった」と読みかけた。
**道具が落ちているときと、根拠が無いときは出力が同じに見える。**

---

## この正誤表の運用

- **公開済みの release 本文と asset は、いかなる理由でも書き換えない。**
  asset を足すこともしない（受け手が照合する集合が変わるため）。
- 誤りは**次の版の notes 冒頭**でも名指しし、この文書を指す。
- 直った版が出たら「どの版で直したか」を各項目に追記する。**項目は消さない。**
