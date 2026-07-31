/**
 * docs/*.md から docs/*.html を生成する。
 *   npm run docs:html
 *
 * HTML は Markdown の派生物であって、手で編集しない。
 * 2026-07-31 まで HTML を手で保守していたため、根拠区分の件数・ピーク挿入力・
 * ポリゴン数がいずれも本文とずれたまま公開されていた。生成物にすることで
 * このずれ方を構造的に潰す。
 *
 * 見出し (## / ###) から目次を自動生成する。目次は本文から導くので、
 * 節を足しても消しても勝手に追随する。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, basename } from 'node:path'

const STYLE = `<style>
  :root{
    --ink:#1c2430; --ink-2:#4a5768; --ink-3:#78859a;
    --line:#e2e6ec; --line-2:#eef1f5;
    --bg:#f6f7f9; --card:#ffffff;
    --accent:#2563eb; --ok:#15803d; --warn:#b45309; --bad:#b91c1c;
  }
  *{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  body{
    margin:0; background:var(--bg); color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Yu Gothic","Noto Sans JP",sans-serif;
    line-height:1.85; font-size:16px;
  }
  .wrap{max-width:840px; margin:0 auto; padding:40px 20px 96px}
  header.doc{margin-bottom:34px; padding-bottom:26px; border-bottom:2px solid var(--line)}
  header.doc h1{font-size:28px; line-height:1.4; margin:0 0 14px; letter-spacing:.01em}
  .meta{display:flex; flex-wrap:wrap; gap:8px 16px; align-items:center; color:var(--ink-3); font-size:13.5px}
  .badge{display:inline-block; padding:3px 11px; border-radius:999px; font-size:12.5px; font-weight:700; letter-spacing:.02em}
  .badge.ok{background:#dcfce7; color:var(--ok)}
  .badge.warn{background:#fef3c7; color:var(--warn)}
  .lead{margin:22px 0 0; font-size:16.5px; color:var(--ink-2)}
  h2{font-size:20.5px; margin:52px 0 16px; padding-left:13px; border-left:4px solid var(--accent); line-height:1.5}
  h3{font-size:16.5px; margin:30px 0 10px; color:var(--ink)}
  p{margin:0 0 15px}
  ul,ol{margin:0 0 16px; padding-left:1.5em}
  li{margin-bottom:7px}
  strong{font-weight:700}
  code{
    background:#eef1f5; padding:2px 6px; border-radius:4px; font-size:.88em;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  }
  pre{
    background:#1e293b; color:#e2e8f0; padding:15px 17px; border-radius:9px;
    overflow-x:auto; font-size:13.5px; line-height:1.6; margin:0 0 16px;
  }
  pre code{background:none; padding:0; color:inherit}
  .tw{overflow-x:auto; margin:0 0 20px; border:1px solid var(--line); border-radius:10px; background:var(--card)}
  table{border-collapse:collapse; width:100%; font-size:14.5px; min-width:440px}
  th,td{padding:10px 14px; text-align:left; border-bottom:1px solid var(--line-2); vertical-align:top}
  th{background:#f2f5f9; font-weight:700; color:var(--ink-2); white-space:nowrap}
  tbody tr:last-child td{border-bottom:none}
  td.num,th.num{text-align:right; font-variant-numeric:tabular-nums}
  .note{
    background:#f0f6ff; border-left:4px solid var(--accent);
    padding:14px 18px; border-radius:0 9px 9px 0; margin:0 0 20px; font-size:14.5px;
  }
  .note.warn{background:#fffbeb; border-left-color:var(--warn)}
  .note.bad{background:#fef2f2; border-left-color:var(--bad)}
  .note.ok{background:#f0fdf4; border-left-color:var(--ok)}
  .note p:last-child{margin-bottom:0}
  .card{background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px 22px; margin:0 0 20px}
  .kpis{display:grid; grid-template-columns:repeat(auto-fit,minmax(158px,1fr)); gap:12px; margin:0 0 22px}
  .kpi{background:var(--card); border:1px solid var(--line); border-radius:11px; padding:15px 17px}
  .kpi .v{font-size:23px; font-weight:750; line-height:1.25; font-variant-numeric:tabular-nums}
  .kpi .k{font-size:12.5px; color:var(--ink-3); margin-top:3px}
  .kpi.ok .v{color:var(--ok)}
  .toc{background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 24px; margin:0 0 34px}
  .toc h2{margin:0 0 10px; font-size:14px; border:none; padding:0; color:var(--ink-3); letter-spacing:.08em}
  .toc ol{margin:0; padding-left:1.35em; font-size:14.5px}
  .toc li{margin-bottom:4px}
  .toc a{color:var(--ink-2); text-decoration:none}
  .toc a:hover{color:var(--accent); text-decoration:underline}
  hr{border:none; border-top:1px solid var(--line); margin:44px 0}
  footer{margin-top:56px; padding-top:22px; border-top:1px solid var(--line); color:var(--ink-3); font-size:13px}
  @media (max-width:600px){
    .wrap{padding:26px 15px 70px}
    header.doc h1{font-size:23px}
    h2{font-size:18.5px; margin:40px 0 13px}
    body{font-size:15.5px}
  }
</style>`

const TARGETS = [
  { md: 'docs/REPORT.md', html: 'docs/REPORT.html', title: '3.5 mm TRS 接合機構ビューア — 納品報告' },
  { md: 'docs/VERIFICATION_PLAN.md', html: 'docs/VERIFICATION_PLAN.html', title: '実物照合の手順' },
  { md: 'docs/TEST_RESULTS.md', html: 'docs/TEST_RESULTS.html', title: '検証結果' },
  { md: 'docs/SENSITIVITY.md', html: 'docs/SENSITIVITY.html', title: '感度解析 — どの結論が揺れないか' },
  { md: 'docs/PUBLISH_AUDIT_20260731.md', html: 'docs/PUBLISH_AUDIT_20260731.html', title: '公開前監査 2026-07-31' },
]

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function inline(s) {
  let t = esc(s)
  t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, a, b) => `<a href="${b}">${a}</a>`)
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  // esc() で潰れた改行タグだけを戻す（表セル内の折り返しに使っている）
  t = t.replace(/&lt;br\s*\/?&gt;/g, '<br>')
  return t
}

function render(mdPath, htmlPath, title) {
  const md = readFileSync(resolve(mdPath), 'utf8')
  const lines = md.split('\n')
const out = []
let i = 0
const flushPara = (buf) => { if (buf.length) out.push(`<p>${inline(buf.join(' '))}</p>`) }
let para = []

while (i < lines.length) {
  const L = lines[i]

  if (/^```/.test(L)) {
    flushPara(para); para = []
    const body = []
    i++
    while (i < lines.length && !/^```/.test(lines[i])) { body.push(lines[i]); i++ }
    i++
    out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`)
    continue
  }

  if (/^---+$/.test(L.trim())) { flushPara(para); para = []; out.push('<hr>'); i++; continue }

  const h = L.match(/^(#{1,4})\s+(.*)$/)
  if (h) {
    flushPara(para); para = []
    const lv = h[1].length
    const id = 's' + out.filter((x) => /^<h2/.test(x)).length
    out.push(lv === 2 ? `<h2 id="${id}">${inline(h[2])}</h2>` : `<h${lv}>${inline(h[2])}</h${lv}>`)
    i++; continue
  }

  if (/^>\s?/.test(L)) {
    flushPara(para); para = []
    const body = []
    while (i < lines.length && /^>\s?/.test(lines[i])) { body.push(lines[i].replace(/^>\s?/, '')); i++ }
    out.push(`<div class="note">${body.filter(Boolean).map((b) => `<p>${inline(b)}</p>`).join('')}</div>`)
    continue
  }

  if (/^\|/.test(L) && /^\|[\s:|-]+\|$/.test(lines[i + 1] ?? '')) {
    flushPara(para); para = []
    const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
    const head = cells(L)
    const align = cells(lines[i + 1]).map((a) => (a.startsWith(':') && a.endsWith(':') ? ' style="text-align:center"' : a.endsWith(':') ? ' class="num"' : ''))
    i += 2
    const rows = []
    while (i < lines.length && /^\|/.test(lines[i])) { rows.push(cells(lines[i])); i++ }
    out.push(
      '<div class="tw"><table><thead><tr>' +
        head.map((c, k) => `<th${align[k] ?? ''}>${inline(c)}</th>`).join('') +
        '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c, k) => `<td${align[k] ?? ''}>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table></div>',
    )
    continue
  }

  if (/^\s*-\s+\[[ x]\]\s/.test(L)) {
    flushPara(para); para = []
    const items = []
    while (i < lines.length && /^\s*-\s+\[[ x]\]\s/.test(lines[i])) {
      const done = /\[x\]/.test(lines[i])
      items.push(`<li><input type="checkbox" disabled${done ? ' checked' : ''}> ${inline(lines[i].replace(/^\s*-\s+\[[ x]\]\s/, ''))}</li>`)
      i++
    }
    out.push(`<ul class="chk">${items.join('')}</ul>`)
    continue
  }

  if (/^\s*[-*]\s+/.test(L)) {
    flushPara(para); para = []
    const items = []
    while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
      if (/^\s*[-*]\s+/.test(lines[i])) items.push(inline(lines[i].replace(/^\s*[-*]\s+/, '')))
      else items[items.length - 1] += ' ' + inline(lines[i].trim())
      i++
    }
    out.push(`<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>`)
    continue
  }

  if (/^\s*\d+\.\s+/.test(L)) {
    flushPara(para); para = []
    const items = []
    while (i < lines.length && (/^\s*\d+\.\s+/.test(lines[i]) || (/^\s{3,}\S/.test(lines[i]) && items.length))) {
      if (/^\s*\d+\.\s+/.test(lines[i])) items.push(inline(lines[i].replace(/^\s*\d+\.\s+/, '')))
      else items[items.length - 1] += ' ' + inline(lines[i].trim())
      i++
    }
    out.push(`<ol>${items.map((x) => `<li>${x}</li>`).join('')}</ol>`)
    continue
  }

  if (L.trim() === '') { flushPara(para); para = []; i++; continue }
  para.push(L.trim()); i++
}
flushPara(para)

  // --- 目次 -----------------------------------------------------------
  // 見出しの id は上の変換で既に振ってある (h2 のみ)。ここは拾うだけ。
  const toc = []
  for (const block of out) {
    const m = /^<h2 id="([^"]+)">([\s\S]*?)<\/h2>$/.exec(block)
    if (m) toc.push({ id: m[1], text: m[2].replace(/<[^>]+>/g, '') })
  }
  const tocHtml = toc.length
    ? `<nav class="toc">\n  <h2>目次</h2>\n  <ol>\n` +
      toc.map((t) => `    <li><a href="#${t.id}">${t.text}</a></li>`).join('\n') +
      `\n  </ol>\n</nav>\n`
    : ''
  const withIds = out

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
${STYLE}
<style>
  ul.chk{list-style:none;padding-left:2px}
  ul.chk li{margin-bottom:7px}
  ul.chk input{margin-right:9px;transform:translateY(1px)}
  h4{font-size:15px;margin:22px 0 8px;color:var(--ink-2)}
  table td{font-size:14px}
</style>
</head>
<body>
<div class="wrap">
${tocHtml}${withIds.join('\n')}
</div>
</body>
</html>
`
  writeFileSync(resolve(htmlPath), html)
  console.log(`  ${htmlPath}  ${html.length} bytes / ブロック ${out.length} / 目次 ${toc.length} 項目`)
}

console.log('docs/*.html を Markdown から生成')
for (const t of TARGETS) render(t.md, t.html, t.title)
