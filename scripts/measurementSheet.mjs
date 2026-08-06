/**
 * 測ってくださる方へ渡す記入シートを作る／記入済みのシートを判定する。
 *
 *   npm run measure:sheet                    docs/measurements/SHEET_L_POINT.md を作り直す
 *   npm run measure:check -- <file.json>     記入済みの 1 件を判定する
 *
 * **期待値はここで印字する。**シートに先に書いておかないと、
 * 「予測と合っていたか」を測ったあとで人が決められてしまう。
 *
 * **判定は機械が出す。**測る方に渡すのは「測る」と「数字を書き写す」だけにする。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Ajv from 'ajv'
import { OBSERVATIONS, checkRecord, GATE_DOCUMENT } from './measurementGate.mjs'

const ROOT = process.cwd()
const read = (p) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))
const OBS = 'L_FIRST_CONTACT_SHOULDER_GAP_MM'
const SHEET = 'docs/measurements/SHEET_L_POINT.md'

// --------------------------------------------------------------- 判定

function checkFile(path) {
  const rec = read(path)
  const ajv = new Ajv({ allErrors: true, strict: false })
  const schema = read('schemas/measurement-record.v1.schema.json')
  const validate = ajv.compile(schema.properties.records.items)
  const shapeOk = validate(rec)
  const c = checkRecord(rec)
  const obs = OBSERVATIONS[rec.observation]

  console.log(`記入済みシートの判定: ${path}\n`)
  console.log(`  観測点        ${rec.observation}`)
  console.log(`  生値          ${(rec.valuesMm ?? []).join(' / ')} mm`)
  console.log(`  平均          ${c.meanMm ?? '—'} mm`)
  console.log(`  ばらつき      ${c.rangeMm ?? '—'} mm（許容 ${obs ? obs.toleranceMm : '—'} mm）`)
  console.log()
  if (!shapeOk) {
    console.log('  形が合っていません:')
    for (const e of validate.errors ?? []) console.log(`    - ${e.instancePath || '/'} ${e.message}`)
  }
  if (!c.valid) {
    console.log('  受け取れません:')
    for (const r of c.reasons) console.log(`    - ${r}`)
  }
  if (!shapeOk || !c.valid) {
    console.log('\n**不合格。**直してから送ってください。')
    process.exit(1)
  }
  console.log('  **受け取れます。**この 1 件を台帳へ入れられます。')
  console.log(`  一致するかどうかは、台帳へ入れて profile を作り直したときに機械が判定します（${GATE_DOCUMENT} 第4条）。`)
}

// --------------------------------------------------------------- 生成

function buildSheet() {
  const rj = read('artifacts/real_jack_comparison.json')
  const tp = rj.testerPredictions
  const obs = OBSERVATIONS[OBS]
  const model = tp.assumed.L.shoulderGapMm
  const drawing = tp.drawing.L.shoulderGapMm
  const diff = +Math.abs(model - drawing).toFixed(2)

  const md = `# 記入シート — \`L\` の 1 点（4極ジャックの接点位置）

> **このファイルは \`npm run measure:sheet\` が作っています。手で編集しないでください。**
> 期待値は \`artifacts/real_jack_comparison.json\` から取っているので、モデルが動けばここも動きます。

作成方法 \`npm run measure:sheet\` ／ 判定 \`npm run measure:check -- <記入したファイル>\`

## この 1 点だけで決まること

**${obs.why}**

手順は [VERIFICATION_PLAN.md](../VERIFICATION_PLAN.md) §2-2 にあります。
測るのは **${obs.label}** です。

## 期待値（**測る前に印字してあります**）

| | 肩とジャック前面のすき間 |
|---|---:|
| 本モデルの予測 | **${model} mm** |
| 実在部品 PS000001 由来の予測 | **${drawing} mm** |
| その差 | **${diff} mm** |
| デジタルノギスの分解能に対して | **${Math.round(diff / 0.01)} 倍** |

**どちらに転んでも価値があります。**どちらでもない値が出たら、それが一番おもしろい結果です。

**後から結論に合わせることはできません。**この表は測る前から公開されています。

## 記入するもの

**平均を書かないでください。生値を 3 つとも残してください。**
ばらつきが **${obs.toleranceMm} mm** を超えると、このシートは不合格を出します
（許容の決め方は [${GATE_DOCUMENT}](../${GATE_DOCUMENT.replace('docs/', '')}) 第5条）。

\`\`\`json
{
  "recordId": "MR0001",
  "observation": "${OBS}",
  "variantId": "${obs.variantId}",
  "measuredBy": "（ハンドル名か Issue 番号。氏名でなくて構いません）",
  "measuredOn": "YYYY-MM-DD",
  "instrument": { "kind": "digital-caliper", "resolutionMm": 0.01, "model": "（型番。分かれば）" },
  "parts": { "jack": "（ジャックの型番）", "jackLot": "", "plug": "（プラグの型番）", "plugLot": "" },
  "valuesMm": [0.00, 0.00, 0.00],
  "note": "（気づいたこと。うまく測れなかった点も書いてください）",
  "sourceUrl": ""
}
\`\`\`

上を丸ごとコピーして \`.json\` として保存し、数字を入れてください。

\`\`\`bash
npm run measure:check -- my-measurement.json
\`\`\`

**合否はこのコマンドが出します。**「合っていたか」を判断する必要はありません。

## 分からなくなったら

- **端子番号は推測しないでください。**完全挿入した状態で、プラグ先端と導通する端子を探して決めます。
- **行き過ぎたら抜いてやり直してください。**戻して合わせると値が変わります（挿入方向だけ測ります）。
- **うまくいかなかったこと自体が情報です。**測れなかった理由を \`note\` に書いて送ってください。
`
  writeFileSync(resolve(ROOT, SHEET), md)
  console.log(`  ${SHEET} を書き出した（期待値 ${model} / ${drawing} mm・差 ${diff} mm）`)
}

const idx = process.argv.indexOf('--check')
if (idx >= 0) {
  const f = process.argv[idx + 1]
  if (!f) { console.error('--check には記入したファイルを渡してください'); process.exit(2) }
  checkFile(f)
} else {
  buildSheet()
}
