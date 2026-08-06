# 検算ツール `verifyReleaseSourceInputs.mjs` を v5 にしました（受け手向け）

対象: 配布物に同梱している `verifyReleaseSourceInputs.mjs`
出力の `toolVersion` が **4 → 5** になります。v0.6.0 の release に載ります。

## いちばん大事な変更 — **`ARCHIVE_INVALID` が増えました**

v4 まで、次の 2 つは**どちらも `SOURCE_UNAVAILABLE`** でした。

```
source を取れなかった            （無い・繋がらない・応答しない）
source は取れたが archive が壊れている（checksum 不正・敵対的な entry）
```

**記録を保存しても、通信の問題なのか改竄なのかを読み分けられません。**v5 で分けました。

| status | 意味 | exit |
|---|---|---:|
| `OK` | 全件一致 | 0 |
| `MISMATCH` | 読めたが記録と合わない | 1 |
| **`ARCHIVE_INVALID`** | **取れたが archive が安全に読めない。中身を見ていない** | 2 |
| `SOURCE_UNAVAILABLE` | 取れなかった。検証していない | 2 |
| `MANIFEST_UNAVAILABLE` | manifest を読めなかった | 2 |
| `NOTHING_TO_VERIFY` | 入力 0 件で何も見ていない | 2 |

**`ARCHIVE_INVALID` を「不一致」と読まないでください。**中身を見ていません。

> **status で分岐している実装は直す必要があります。**
> `status === 'SOURCE_UNAVAILABLE'` だけを見ていると、壊れた archive を渡されたときに
> 素通りします。exit code は 2 のままなので、**exit code で見ている実装は影響を受けません。**

## archive の読み方を厳しくしました

信頼できない tar.gz を渡されたときに、安全に止まるようにしました。

| 何 | v4 | v5 |
|---|---|---|
| header checksum | **見ていなかった** | 検算する。合わなければ止まる |
| PAX（`x` / `g`） | **中身をファイルとして拾っていた** | 拾わない。上書き指示にも従わない |
| `..` / 絶対パス / `\` | **そのまま登録していた** | 止まる |
| symlink（`2`）/ hardlink（`1`） | **ファイルとして扱っていた** | 読み飛ばす |
| entry 数・サイズ・パス長・総量 | **上限が無かった** | 上限を超えたら止まる |
| `fetch` | **timeout が無かった** | 60 秒 |

上限は v0.5.2 の実物を測ってから決めました（2026-08-06 実測）。

```
GitHub tarball v0.5.2   gz 9.76 MB → tar 15.09 MB（1.5 倍）
                        entry 268（ファイル 246 / ディレクトリ 21 / pax global 1）
                        最大 entry 1.33 MB ／ 最長パス 95 文字

上限                    entry 5,000 ／ 1 entry 8 MB ／ 総量 256 MB ／ パス 1,024 文字
                        （実測の 6〜20 倍）
```

## あなたの手順は変わりません

**正常な tarball の扱いは同じです。**次の 2 つで確認しています。

```
合成した正常な tar             通る
実物の v0.5.2 tarball          通る（ファイル 246 件・先頭階層の剥がしも同じ）
```

`--source <展開済みディレクトリ>` も `--source src.tar.gz` も `--tag` も、
書き方は変わりません。

> **自分で `tar` を作って渡す場合の注意は v0.5.1 のときと同じです。**
> macOS の `tar` は AppleDouble（`._*`）を混ぜるので `COPYFILE_DISABLE=1` を付けてください。
> GitHub の tarball では起きません。

## 試験の内容

壊れた tar を **26 個・6 種類**作って、1 個ずつ実測しました
（`test/_corruptTar.mjs` / `test/tarHardening.test.ts`。どちらも配布物には入りません）。

```
PAX        4 個 → 4 個とも読めるが、PAX ヘッダをファイルとして拾わない
GNU long   5 個 → 正常 1 個は通る。長すぎ・サイズの嘘・traversal の 3 個は止まる
checksum   4 個 → 4 個とも止まる
traversal  5 個 → 5 個とも止まる
symlink    4 個 → 4 個とも読めるが、リンクをファイルとして拾わない
資源       4 個 → 4 個とも止まる
```

**「1 個作って弾けたから防げた」にしないため、種類ごとに複数個を作っています。**
上限のすぐ内側が通ることも同じテストで見ています（**塞ぎすぎの検出**）。

## まだやっていないこと

- **複数の実物 tarball で試していません。**確認したのは v0.5.2 の 1 本だけです。
- **`ARCHIVE_INVALID` の細かい理由は文字列です。**機械で分岐したい場合は
  `detail` に入る値を使ってください（安定した ID は付けていません）。
- 外部監査の P2（read-only CI・`SECURITY.md`）は**まだ入っていません。**
