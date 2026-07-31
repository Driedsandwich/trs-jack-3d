# 同梱フォントについて

| 項目 | 内容 |
|---|---|
| ファイル | `NotoSansJP-Subset.ttf`（16.1 KB） |
| 元のフォント | **Noto Sans JP**（可変フォント `NotoSansJP[wght].ttf`、9.1 MB） |
| 入手元 | [google/fonts の ofl/notosansjp](https://github.com/google/fonts/tree/main/ofl/notosansjp)（2026-07-31 取得） |
| ライセンス | **SIL Open Font License 1.1** → 全文は同じディレクトリの [OFL.txt](OFL.txt) |
| 加工 | ウェイト 400 で固定 → 3D ラベルに出る **102 字だけ**を残してサブセット |

## なぜ同梱しているのか

`@react-three/drei` の `<Text>` は内部で troika-three-text を使います。
`font` を指定しないと、troika は実行時に `cdn.jsdelivr.net` からフォントを取りに行きます。
日本語ラベルがあるため CJK サブセットまで引かれ、**ページを開くだけで 17 リクエスト**出ていました
（閲覧者の IP と User-Agent が CDN 事業者へ渡ります）。

必要な字だけを切り出して同梱し、`src/three/labelFont.ts` から明示的に渡すことで、
**外部への通信をゼロにしています。**（Playwright で全リクエストを記録して実測確認済み）

副次的に、オフラインでもラベルが出るようになりました。

## 収録している字

```
 ()-./0123456789@ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz
φねばイクブマレー体入全右在完導左帯帰度指挿接深点現第絶線縁部間
```

**ラベルに新しい字を足したら、このフォントを作り直さないとその字は表示されません**
（豆腐にはならず、何も出ません）。下の手順で再生成してください。

## 再生成の手順

`fontTools` が要ります。プロジェクトの依存には入れていません（ビルド時ではなく、
ラベルの文字が増えたときだけ使う道具のため）。

```bash
python3 -m venv /tmp/fontenv && /tmp/fontenv/bin/pip install fonttools brotli
```

1. 必要な字を集める（データファイルとコード内の固定文言から）

```bash
node -e "const fs=require('fs');const s=new Set();const add=t=>{for(const c of String(t))s.add(c)};['指部 mm','完全挿入深度 mm','現在深度 mm','φ mm','@','0123456789.-()/ ','ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_'].forEach(add);for(const f of ['src/data/jackContacts.json','src/data/jackContacts.trrs.json','src/data/plugSegments.json','src/data/plugSegments.trrs.json'])JSON.stringify(JSON.parse(fs.readFileSync(f,'utf8'))).replace(/\"label\":\"([^\"]*)\"/g,(_,v)=>{add(v);return _});fs.writeFileSync('/tmp/charset.txt',[...s].sort().join(''));console.log(s.size+' 字')"
```

2. 元フォントを取得して 400 で固定し、サブセットする

```bash
curl -sL -o /tmp/NotoSansJP.ttf "https://github.com/google/fonts/raw/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf"
/tmp/fontenv/bin/fonttools varLib.instancer /tmp/NotoSansJP.ttf wght=400 -o /tmp/NotoSansJP-400.ttf
/tmp/fontenv/bin/pyftsubset /tmp/NotoSansJP-400.ttf --text-file=/tmp/charset.txt --output-file=public/fonts/NotoSansJP-Subset.ttf --layout-features='' --no-hinting --drop-tables+=DSIG --name-IDs='0,1,2,3,4,5,6,13,14' --notdef-outline
```

3. 通信ゼロを確認する（`npm run build` してから `npm run preview` を別ターミナルで動かす）

```bash
node -e "const{chromium}=require('playwright');(async()=>{const b=await chromium.launch();const p=await b.newPage();const e=[];p.on('request',r=>{const u=r.url();if(!u.startsWith('http://localhost:4173')&&!u.startsWith('data:')&&!u.startsWith('blob:'))e.push(u)});await p.goto('http://localhost:4173');await p.waitForSelector('.viewport canvas');await p.waitForTimeout(8000);console.log('外部リクエスト '+e.length+' 件');e.forEach(u=>console.log('  '+u));await b.close()})()"
```

## OFL の条件

- このフォント（およびサブセット）を再配布するときは `OFL.txt` を一緒に配ること
- フォント単体を販売しないこと
- 元フォントの予約フォント名は `Source` です（`Noto` は予約されていないため、
  サブセットに `Noto Sans JP Subset` と名付けています）
