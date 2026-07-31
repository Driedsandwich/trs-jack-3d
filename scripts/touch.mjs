/**
 * タッチ操作の検証。
 *
 *   npm run touch
 *
 * 前提: 別ターミナルで `npm run dev` が動いていること。
 *
 * 実行環境について:
 *   物理的な iPhone / iPad は自動操作できないため、ここでは
 *   「iPhone 相当のビューポート + hasTouch を有効にした Chromium」に対し、
 *   CDP の Input.dispatchTouchEvent で本物のタッチ入力を注入している。
 *   これにより OS が生成するのと同じ pointerdown/pointermove/pointerup が発火し、
 *   アプリのドラッグ処理と OrbitControls のピンチ処理を実際に通せる。
 *
 *   ただしこれは Chromium であって Safari ではない。実機 Safari での確認は別途必要。
 */

import { chromium, devices } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const URL = process.env.APP_URL ?? 'http://localhost:5173'
const OUT = resolve(process.cwd(), 'docs/screenshots')
mkdirSync(OUT, { recursive: true })

const results = []
const log = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const browser = await chromium.launch()

for (const deviceName of ['iPhone 15 Pro', 'iPad Pro 11']) {
  const device = devices[deviceName] ?? devices['iPhone 15 Pro']
  const ctx = await browser.newContext({ ...device, hasTouch: true, isMobile: true })
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)

  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.viewport canvas')
  await page.waitForFunction(() => !!window.__r3fState, null, { timeout: 20000 })
  await page.waitForTimeout(1500)

  console.log(`\n=== ${deviceName} (${device.viewport.width}x${device.viewport.height}) ===`)

  // --- レイアウト ---
  const cols = await page.evaluate(
    () => getComputedStyle(document.querySelector('.app')).gridTemplateColumns.split(' ').length,
  )
  log(`${deviceName}: 1 カラムレイアウトになる`, cols === 1, `columns=${cols}`)

  const canvasBox = await page.locator('.viewport canvas').boundingBox()
  log(
    `${deviceName}: 3D ビューが画面内に描かれている`,
    canvasBox.width > 100 && canvasBox.height > 100,
    `${Math.round(canvasBox.width)}x${Math.round(canvasBox.height)}`,
  )

  // --- 深度を設定し、プラグ指部の画面座標を求める ---
  const setDepth = async (mm) => {
    await page.evaluate((v) => {
      const sl = document.querySelector('input[aria-label="挿入深度"]')
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      set.call(sl, String(v))
      sl.dispatchEvent(new Event('input', { bubbles: true }))
    }, mm)
    await page.waitForTimeout(300)
  }
  const depthNow = () =>
    page.evaluate(() => parseFloat(document.querySelector('.hud').innerText.split(' ')[0]))

  await setDepth(8)

  /** プラグ指部の中ほどの世界座標を画面座標へ投影する */
  const plugScreen = await page.evaluate(() => {
    const s = window.__r3fState
    const el = s.gl.domElement
    const r = el.getBoundingClientRect()
    // プラグ先端は x=depth。少し手前 (指部の中ほど) を掴む
    const v = new (Object.getPrototypeOf(s.camera.position).constructor)(8 - 4, 0, 0)
    v.project(s.camera)
    return {
      x: r.left + ((v.x + 1) / 2) * r.width,
      y: r.top + ((1 - v.y) / 2) * r.height,
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    }
  })

  // --- 1 本指ドラッグ (プラグの抜き差し) ---
  const before = await depthNow()
  const touch = async (type, points) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points })

  const startX = plugScreen.x
  const startY = plugScreen.y
  await touch('touchStart', [{ x: startX, y: startY, id: 1 }])
  for (let i = 1; i <= 12; i++) {
    await touch('touchMove', [{ x: startX + i * 6, y: startY, id: 1 }])
    await page.waitForTimeout(16)
  }
  await touch('touchEnd', [])
  await page.waitForTimeout(300)
  const after = await depthNow()

  log(
    `${deviceName}: 1 本指でプラグをドラッグして深度が変わる`,
    Math.abs(after - before) > 0.05,
    `${before.toFixed(2)}mm → ${after.toFixed(2)}mm`,
  )

  // --- 2 本指ピンチ (拡大縮小) ---
  // OrbitControls の注視点からの距離で測る (原点からの距離ではズーム量が正しく出ない)
  const camDist = () =>
    page.evaluate(() => {
      const s = window.__r3fState
      const t = s.controls ? s.controls.target : { x: 0, y: 0, z: 0 }
      return Math.hypot(s.camera.position.x - t.x, s.camera.position.y - t.y, s.camera.position.z - t.z)
    })
  const controlsState = () =>
    page.evaluate(() => {
      const c = window.__r3fState.controls
      return c ? { enabled: c.enabled, minDistance: c.minDistance, maxDistance: c.maxDistance } : null
    })

  /** 指定座標を中心に 2 本指を広げる */
  const pinchAt = async (px, py) => {
    // 前のジェスチャの影響を消すため、毎回視点を既定へ戻す
    await page.locator('button').filter({ hasText: /^視点を戻す$/ }).first().tap()
    await page.waitForTimeout(400)
    const d0 = await camDist()
    await touch('touchStart', [
      { x: px - 40, y: py, id: 1 },
      { x: px + 40, y: py, id: 2 },
    ])
    for (let i = 1; i <= 14; i++) {
      const d = 40 + i * 8
      await touch('touchMove', [
        { x: px - d, y: py, id: 1 },
        { x: px + d, y: py, id: 2 },
      ])
      await page.waitForTimeout(16)
    }
    await touch('touchEnd', [])
    await page.waitForTimeout(500)
    return { before: d0, after: await camDist() }
  }

  console.log('   OrbitControls:', JSON.stringify(await controlsState()))

  // (a) 何も無い背景から始めるピンチ
  const bgPinch = await pinchAt(
    plugScreen.rect.left + plugScreen.rect.width * 0.15,
    plugScreen.rect.top + plugScreen.rect.height * 0.18,
  )
  log(
    `${deviceName}: 背景から始める 2 本指ピンチでカメラ距離が変わる`,
    Math.abs(bgPinch.after - bgPinch.before) > 0.5,
    `${bgPinch.before.toFixed(1)} → ${bgPinch.after.toFixed(1)}`,
  )

  // (b) プラグの上から始めるピンチ (1 本目がモデルに当たるケース)
  const onPlugPinch = await pinchAt(
    plugScreen.rect.left + plugScreen.rect.width / 2,
    plugScreen.rect.top + plugScreen.rect.height / 2,
  )
  log(
    `${deviceName}: プラグの上から始める 2 本指ピンチでもカメラ距離が変わる`,
    Math.abs(onPlugPinch.after - onPlugPinch.before) > 0.5,
    `${onPlugPinch.before.toFixed(1)} → ${onPlugPinch.after.toFixed(1)}`,
  )

  // --- 1 本指スワイプ (視点回転) ---
  // 視点を戻してから、確実に何も無い隅を使う (モデルの上だとプラグのドラッグが優先されるため)
  await page.locator('button').filter({ hasText: /^視点を戻す$/ }).first().tap()
  await page.waitForTimeout(400)
  const camPosBefore = await page.evaluate(() => window.__r3fState.camera.position.toArray())
  const bg = {
    x: plugScreen.rect.left + plugScreen.rect.width * 0.1,
    y: plugScreen.rect.top + plugScreen.rect.height * 0.12,
  }
  await touch('touchStart', [{ x: bg.x, y: bg.y, id: 1 }])
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', [{ x: bg.x + i * 9, y: bg.y + i * 3, id: 1 }])
    await page.waitForTimeout(16)
  }
  await touch('touchEnd', [])
  await page.waitForTimeout(500)
  const camPosAfter = await page.evaluate(() => window.__r3fState.camera.position.toArray())
  const moved = Math.hypot(...camPosAfter.map((v, i) => v - camPosBefore[i]))
  log(`${deviceName}: 何も無い所を 1 本指でなぞると視点が回る`, moved > 0.5, `カメラが ${moved.toFixed(1)} 移動`)

  // プラグの上を 1 本指でなぞったときは、視点ではなくプラグが動く (意図した優先順位)
  await page.locator('button').filter({ hasText: /^視点を戻す$/ }).first().tap()
  await page.waitForTimeout(400)
  await setDepth(8)
  const camBefore2 = await page.evaluate(() => window.__r3fState.camera.position.toArray())
  const d0 = await depthNow()
  await touch('touchStart', [{ x: plugScreen.x, y: plugScreen.y, id: 1 }])
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', [{ x: plugScreen.x + i * 5, y: plugScreen.y, id: 1 }])
    await page.waitForTimeout(16)
  }
  await touch('touchEnd', [])
  await page.waitForTimeout(400)
  const camAfter2 = await page.evaluate(() => window.__r3fState.camera.position.toArray())
  const camMoved2 = Math.hypot(...camAfter2.map((v, i) => v - camBefore2[i]))
  const d1 = await depthNow()
  log(
    `${deviceName}: プラグの上をなぞると視点は動かずプラグだけが動く`,
    Math.abs(d1 - d0) > 0.05 && camMoved2 < 0.5,
    `深度 ${d0.toFixed(2)}→${d1.toFixed(2)}mm / カメラ移動 ${camMoved2.toFixed(2)}`,
  )

  // --- タップでボタンが押せる ---
  await page.locator('button').filter({ hasText: /^故障$/ }).first().tap()
  await page.waitForTimeout(300)
  await page.locator('button').filter({ hasText: /^半挿し$/ }).first().tap()
  await page.waitForTimeout(400)
  const hud = await page.locator('.hud').innerText()
  log(`${deviceName}: タップでプリセットを切り替えられる`, hud.includes('9.80'), hud.split('\n')[0])

  // --- touch-action の確認 (キャンバス上でページがスクロールしない) ---
  const ta = await page.evaluate(() => getComputedStyle(document.querySelector('.viewport canvas')).touchAction)
  log(`${deviceName}: キャンバスに touch-action:none が効いている`, ta === 'none', ta)

  await page.screenshot({
    path: resolve(OUT, deviceName.startsWith('iPad') ? '17_touch_ipad.png' : '16_touch_iphone.png'),
  })

  log(`${deviceName}: JS エラーが無い`, errors.length === 0, errors.slice(0, 2).join(' | '))

  await ctx.close()
}

await browser.close()

writeFileSync(
  resolve(process.cwd(), 'artifacts/touch_verification.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString().slice(0, 10),
      runner: 'Playwright Chromium + iPhone/iPad ビューポート + CDP Input.dispatchTouchEvent',
      caveat:
        '物理的な iPhone / iPad ではない。ブラウザエンジンも Chromium であり Safari ではない。' +
        'タッチ入力は CDP で注入した本物のタッチイベントであり、OS が生成するのと同じ ' +
        'pointerdown/pointermove/pointerup を経てアプリのコードを通っている。',
      total: results.length,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    },
    null,
    1,
  ),
)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exitCode = 1
