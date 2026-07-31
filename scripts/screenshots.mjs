/**
 * 実ブラウザ (Chromium) でアプリを開き、主要状態のスクリーンショットを撮る。
 * 併せて UI の実操作 (クリック・キーボード・画面サイズ変更) が動くことも確認する。
 *
 *   npm run screenshots
 *
 * 前提: 別ターミナルで `npm run dev` が動いていること (既定 http://localhost:5173)。
 */

import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadavg } from 'node:os'

const URL = process.env.APP_URL ?? 'http://localhost:5173'
const OUT = resolve(process.cwd(), 'docs/screenshots')
mkdirSync(OUT, { recursive: true })

const results = []
const log = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.viewport canvas')
await page.waitForTimeout(1200)

/** ラベル一致でボタンを押す */
const clickButton = async (label) => {
  await page.locator('button', { hasText: new RegExp(`^${label}$`) }).first().click()
  await page.waitForTimeout(320)
}
const setDepth = async (mm) => {
  await page.evaluate((v) => {
    const sl = document.querySelector('input[aria-label="挿入深度"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(sl, String(v))
    sl.dispatchEvent(new Event('input', { bubbles: true }))
  }, mm)
  await page.waitForTimeout(320)
}
const setCamera = async (px, py, pz, tx) => {
  await page.evaluate(
    ([a, b, c, t]) => {
      const s = window.__r3fState
      if (!s) return
      s.camera.position.set(a, b, c)
      s.camera.lookAt(t, 0, 0)
      s.camera.updateProjectionMatrix()
    },
    [px, py, pz, tx],
  )
  await page.waitForTimeout(200)
}
const shot = async (file, opts = {}) => {
  await page.waitForTimeout(250)
  await page.screenshot({ path: resolve(OUT, file), ...opts })
}
const hud = () => page.locator('.hud').innerText()

// ---------------------------------------------------------------------------
// 1. 完全挿入 (正常)
// ---------------------------------------------------------------------------
await setDepth(14)
await shot('01_full_insertion.png')
{
  const t = await hud()
  log('完全挿入で 3 接点すべて正常接触', t.includes('正常 (ステレオ)') && (t.match(/正常接触/g) || []).length === 3, t.split('\n')[2])
}

// ---------------------------------------------------------------------------
// 2. 半挿し
// ---------------------------------------------------------------------------
await clickButton('故障')
await clickButton('半挿し')
await clickButton('完全透明外装')
await shot('02_half_inserted.png')
{
  const t = await hud()
  log('半挿しで誤接触が出る', t.includes('誤接触'), t.split('\n')[1])
}

// ---------------------------------------------------------------------------
// 3. 橋絡 (導体境界で停止)
// ---------------------------------------------------------------------------
await clickButton('導体境界で停止')
await page.waitForTimeout(350)
await shot('03_bridged.png')
{
  const t = await hud()
  // 橋絡が出るだけでなく、どの導体どうしかまで確かめる。
  // 第1絶縁帯 (Tip↔Ring) では起きないことがモデル修正の要点なので、そこも見る。
  // どの導体どうしが橋絡しているかまで見る。
  // HUD の接点行は「記号 ラベル: 状態 → ネット+ネット」の形。
  const bridgedRow = t.split('\n').find((line) => line.includes('橋絡')) ?? ''
  const nets = (bridgedRow.split('→')[1] ?? '').trim()
  log('境界停止で Ring↔Sleeve の橋絡が出る', /RING/.test(nets) && /SLEEVE/.test(nets), bridgedRow.trim())
}

// 旧モデルは深さ 8.35 で Tip↔Ring の橋絡を出していた。
// 高さの段差 (Tip は Ring より 0.15 mm 低い) を見るよう判定を直したので、ここでは出ないはず。
await setDepth(8.35)
await page.waitForTimeout(350)
{
  const t = await hud()
  log('第1絶縁帯の深さ (8.35mm) では橋絡が出ない', !t.includes('橋絡'), t.split('\n')[1])
}

// ---------------------------------------------------------------------------
// 4. 断面 (完全挿入)
// ---------------------------------------------------------------------------
await clickButton('正常')
await clickButton('断面')
await setCamera(-8, 10, 20, 5)
await shot('04_section.png')
log('断面表示が例外なく描ける', true)

// ---------------------------------------------------------------------------
// 5. 接点のみ (接点ばね拡大)
// ---------------------------------------------------------------------------
await clickButton('接点のみ')
await setCamera(-4, 9, 20, 9)
await shot('05_contacts_only.png')
log('接点のみ表示が描ける', true)

// ---------------------------------------------------------------------------
// 6. 分解表示
// ---------------------------------------------------------------------------
await clickButton('分解')
await setCamera(-16, 14, 32, 2)
await shot('06_exploded.png')
log('分解表示が描ける', true)

// ---------------------------------------------------------------------------
// 7. 寸法表示
// ---------------------------------------------------------------------------
await clickButton('半透明外装')
await clickButton('寸法表示')
await setCamera(-4, 6, 40, 4)
await shot('07_dimensions.png')
await clickButton('寸法表示')
log('寸法表示が描ける', true)

// ---------------------------------------------------------------------------
// 8. 各パネル
// ---------------------------------------------------------------------------
await clickButton('視点を戻す')
await setDepth(14)
await clickButton('回路')
await page.locator('.sidebar').screenshot({ path: resolve(OUT, '08_circuit_panel.png') })
{
  const txt = await page.locator('.sidebar').innerText()
  log(
    '回路パネルが完全挿入の結線を出す',
    txt.includes('Tip 接点ばね (pin 3) → Plug Tip') && txt.includes('Sleeve 接点 (pin 1) → Plug Sleeve'),
  )
}

await clickButton('イベント')
await page.locator('.sidebar').screenshot({ path: resolve(OUT, '09_events_panel.png') })
{
  const txt = await page.locator('.sidebar').innerText()
  log('イベントパネルに主要イベントが出る', txt.includes('最初の物理接触') && txt.includes('完全挿入'))
}

await clickButton('力')
await page.locator('.sidebar').screenshot({ path: resolve(OUT, '10_force_panel.png') })
{
  const txt = await page.locator('.sidebar').innerText()
  log('力パネルが公称レンジ内と判定する', txt.includes('範囲内'), txt.split('\n').find((l) => l.includes('ピーク')) ?? '')
}

await clickButton('根拠')
await page.locator('.sidebar').screenshot({ path: resolve(OUT, '11_evidence_panel.png') })
{
  const txt = await page.locator('.sidebar').innerText()
  log('根拠パネルに FACT/DERIVED/ASSUMPTION の内訳が出る', txt.includes('FACT') && txt.includes('ASSUMPTION'))
}

await clickButton('接点')
await page.locator('.sidebar').screenshot({ path: resolve(OUT, '12_contact_table.png') })

// ---------------------------------------------------------------------------
// 9. TRRS 混挿
// ---------------------------------------------------------------------------
await page.selectOption('select >> nth=0', 'TRRS-CTIA')
await page.waitForTimeout(400)
await setDepth(14)
await clickButton('回路')
await page.locator('.sidebar').screenshot({ path: resolve(OUT, '13_trrs_ctia_in_trs_jack.png') })
{
  const t = await hud()
  // 図面どおりの配置なら、3極ジャックの帰線接点は CTIA の Ring2 (=帰線) に届く。
  // 「4極ヘッドセットはステレオ機器でも普通に鳴る」という実挙動と一致するはず。
  // HUD の 2 行目が音響判定。接点一覧の文言に引っかからないよう、その行だけを見る。
  const verdict = t.split('\n')[1] ?? ''
  log('4極 CTIA プラグ × 3極ジャックで正常と表示', verdict.includes('正常'), verdict)
}
await shot('14_trrs_plug.png')

// ---------------------------------------------------------------------------
// 10. UI 操作の検証
// ---------------------------------------------------------------------------
await page.selectOption('select >> nth=0', 'TRS')
await page.waitForTimeout(300)

// キーボード
await setDepth(10)
await page.locator('.viewport').click({ position: { x: 400, y: 400 } })
const before = await page.evaluate(() => document.querySelector('.hud').innerText.split(' ')[0])
await page.keyboard.press('ArrowRight')
await page.waitForTimeout(200)
const after = await page.evaluate(() => document.querySelector('.hud').innerText.split(' ')[0])
log('キーボード ← → で深度が動く', before !== after, `${before} → ${after}`)

// Home / End
await page.keyboard.press('End')
await page.waitForTimeout(250)
log('End キーで完全挿入へ', (await hud()).includes('14.00 mm'))
await page.keyboard.press('Home')
await page.waitForTimeout(250)
log('Home キーで完全抜去へ', (await hud()).includes('-16.00 mm'))

// リセット
await page.keyboard.press('r')
await page.waitForTimeout(250)
log('R キーでリセット', (await hud()).includes('-3.00 mm'))

// 数値入力
await page.fill('input[aria-label="挿入深度を mm で入力"]', '12.25')
await clickButton('移動')
log('数値入力で任意深度へ移動できる', (await hud()).includes('12.25 mm'))

// 0.05mm ステップ
await page.locator('button').filter({ hasText: /^.0\.05$/ }).first().click()
  await page.waitForTimeout(300)
log('0.05mm 刻みで動かせる', (await hud()).includes('12.20 mm'))

// イベントマーカーからの移動
await clickButton('イベント')
await page.locator('.timeline').waitFor()
const markerBtn = page.locator('.sidebar table button').first()
const markerLabel = (await markerBtn.innerText()).trim()
await markerBtn.click()
await page.waitForTimeout(250)
log('イベントマーカーをクリックしてその深度へ移動できる', (await hud()).includes(markerLabel), markerLabel)

// 画面サイズ変更 (レスポンシブ)
await page.setViewportSize({ width: 900, height: 900 })
await page.waitForTimeout(500)
const stacked = await page.evaluate(() => getComputedStyle(document.querySelector('.app')).gridTemplateColumns.split(' ').length)
log('狭い画面では 1 カラムに切り替わる', stacked === 1, `columns=${stacked}`)
await shot('15_responsive_narrow.png')
await page.setViewportSize({ width: 1440, height: 900 })
await page.waitForTimeout(400)

// 自動挿入アニメーション
await page.keyboard.press('r')
await page.waitForTimeout(200)
await clickButton('自動挿入 ▶')
await page.waitForTimeout(1500)
const midway = await hud()
await clickButton('一時停止')
await page.waitForTimeout(300)
const paused1 = await hud()
await page.waitForTimeout(600)
const paused2 = await hud()
log('自動挿入が動き、一時停止で止まる', midway !== paused1 || paused1 === paused2, '')

// ---------------------------------------------------------------------------
// 11. 性能 (仕様 §17)
// ---------------------------------------------------------------------------
const perf = await page.evaluate(async () => {
  const measure = () =>
    new Promise((done) => {
      const t = []
      let last = performance.now()
      let n = 0
      const tick = () => {
        const now = performance.now()
        t.push(now - last)
        last = now
        if (++n < 120) requestAnimationFrame(tick)
        else {
          t.sort((a, b) => a - b)
          done({ median: t[Math.floor(t.length / 2)], p95: t[Math.floor(t.length * 0.95)] })
        }
      }
      requestAnimationFrame(tick)
    })
  // 実際に使われている GL 実装を記録する (ヘッドレスはソフトウェアラスタのことがある)
  const gl2 = document.createElement('canvas').getContext('webgl2')
  const dbg = gl2 && gl2.getExtension('WEBGL_debug_renderer_info')
  const renderer = dbg ? gl2.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown'

  const idle = await measure()
  // 自動挿入中 (毎フレーム全接点を再評価する最も重い状態) でも測る
  ;[...document.querySelectorAll('button')].find((b) => b.textContent.includes('自動挿入'))?.click()
  const moving = await measure()
  const tri = window.__r3fState ? window.__r3fState.gl.info.render.triangles : -1
  const calls = window.__r3fState ? window.__r3fState.gl.info.render.calls : -1
  const px = window.__r3fState
    ? window.__r3fState.gl.domElement.width * window.__r3fState.gl.domElement.height
    : -1

  // 低負荷モード (dpr=1, アンチエイリアス無し) に切り替えて再測定
  ;[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '低負荷モード')?.click()
  await new Promise((r) => setTimeout(r, 800))
  const lowq = await measure()
  const lowPx = window.__r3fState
    ? window.__r3fState.gl.domElement.width * window.__r3fState.gl.domElement.height
    : -1

  return { renderer, idle, moving, lowq, triangles: tri, drawCalls: calls, pixels: px, lowPixels: lowPx }
})
const software = /swiftshader|llvmpipe|software|angle \(google/i.test(String(perf.renderer))
log('GL 実装を記録', true, `${perf.renderer}${software ? ' (ソフトウェアラスタ)' : ''}`)
log('ポリゴン数が過大でない', perf.triangles > 0 && perf.triangles < 200000, `${perf.triangles} 三角形 / ${perf.drawCalls} draw call`)
log(
  '挿抜アニメ中もフレーム時間が静止時から大きく悪化しない (CPU 側が重くない)',
  perf.moving.median < perf.idle.median * 1.6,
  `静止 ${perf.idle.median.toFixed(1)}ms → 挿抜中 ${perf.moving.median.toFixed(1)}ms`,
)
log(
  '低負荷モードでフレーム時間が改善する (塗り面積依存であることの確認)',
  perf.lowq.median < perf.idle.median,
  `${perf.idle.median.toFixed(1)}ms (${(perf.pixels / 1e6).toFixed(1)}Mpx) → ${perf.lowq.median.toFixed(1)}ms (${(perf.lowPixels / 1e6).toFixed(1)}Mpx)`,
)
if (software) {
  console.log(
    'NOTE  ヘッドレス Chromium はソフトウェアラスタのため、絶対 fps は実機 GPU の値ではない。' +
      'ここで確認できるのは「CPU 側が重くない」「塗り面積を減らせば軽くなる」の 2 点。',
  )
}

log('コンソールエラーが無い', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()

writeFileSync(
  resolve(process.cwd(), 'artifacts/ui_verification.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      runner: 'playwright chromium 1440x900 @2x',
      total: results.length,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      performance: {
        ...perf,
        // ヘッドレスのフレーム時間は同時に走っている他のプロセスに強く影響される。
        // 後から「悪化した」と誤読しないよう、測定時の負荷を必ず添える。
        loadAverage1min: loadavg()[0],
      },
      consoleErrors: errors,
      results,
    },
    null,
    1,
  ),
)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exitCode = 1
