/**
 * 実 GPU 環境でのフレームレート実測。
 *
 *   npm run perf              # 実 GPU (headed Chrome) で測る
 *   PERF_HEADLESS=1 npm run perf   # 比較用にヘッドレスでも測る
 *
 * 前提: 別ターミナルで `npm run dev` が動いていること。
 *
 * ヘッドレス Chromium は既定でソフトウェアラスタ (SwiftShader) を使うため、
 * 絶対 fps は実機の値にならない。実 GPU を使うには headed で起動する必要がある。
 */

import { chromium } from 'playwright'
import os from 'node:os'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const URL = process.env.APP_URL ?? 'http://localhost:5173'
const HEADLESS = process.env.PERF_HEADLESS === '1'
/**
 * 既定 (vsync あり) は「実際に利用者が得るフレームレート」を測る。
 * ディスプレイのリフレッシュレートが上限になるので、上限に張り付いていれば余裕があるということ。
 * PERF_UNTHROTTLED=1 にすると vsync を外し、1 フレームの実コストと低負荷モードの効果を測れる。
 */
const UNTHROTTLED = process.env.PERF_UNTHROTTLED === '1'
const FRAMES = Number(process.env.PERF_FRAMES ?? 180)

mkdirSync(resolve(process.cwd(), 'artifacts'), { recursive: true })

const args = []
if (!HEADLESS) args.push('--use-angle=metal', '--ignore-gpu-blocklist')
if (UNTHROTTLED) args.push('--disable-gpu-vsync', '--disable-frame-rate-limit')

const browser = await chromium.launch({
  headless: HEADLESS,
  channel: HEADLESS ? undefined : 'chrome',
  args,
})

/** 1 条件ぶんの測定 */
async function measureAt(page, label) {
  return await page.evaluate(
    async ([frames, name]) => {
      // 最初の数フレームは捨てる (切替直後の再コンパイル等を除くため)
      const times = []
      await new Promise((done) => {
        let last = performance.now()
        let n = 0
        const tick = () => {
          const now = performance.now()
          if (n > 10) times.push(now - last)
          last = now
          if (++n < frames) requestAnimationFrame(tick)
          else done()
        }
        requestAnimationFrame(tick)
      })
      times.sort((a, b) => a - b)
      const at = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))]
      const s = window.__r3fState
      return {
        label: name,
        samples: times.length,
        medianMs: at(0.5),
        p95Ms: at(0.95),
        p99Ms: at(0.99),
        minMs: times[0],
        // 最大値を記録しないと「フレーム落ちが無かった」を確かめようがない。
        maxMs: times[times.length - 1],
        // 1 vsync (16.7ms) の 2 倍を超えた回数 = 明確なフレーム落ち
        droppedFrames: times.filter((t) => t > 33).length,
        fps: 1000 / at(0.5),
        pixels: s ? s.gl.domElement.width * s.gl.domElement.height : -1,
        triangles: s ? s.gl.info.render.triangles : -1,
        drawCalls: s ? s.gl.info.render.calls : -1,
      }
    },
    [FRAMES, label],
  )
}

/**
 * 1 フレームの実コストを測る。
 *
 * vsync があると rAF 間隔は必ず 16.7ms に張り付くので、そこからは「余裕があるか」しか分からない。
 * ここでは gl.render() の直後に glFinish() を入れて GPU の完了を待ち、
 * 描画そのものにかかる時間を取り出す。低負荷モードの効果はこの値で比べる。
 */
async function measureRenderCost(page, label, iterations = 25) {
  return await page.evaluate(
    async ([n, name]) => {
      const s = window.__r3fState
      const gl = s.gl.getContext()
      // ウォームアップ
      for (let i = 0; i < 10; i++) {
        s.gl.render(s.scene, s.camera)
        gl.finish()
      }
      // performance.now() は 0.1ms 単位に丸められるので、1 回ずつ測ると分解能に埋もれる。
      // BATCH 回まとめて描いてから finish し、合計時間を割って 1 回あたりを出す。
      const BATCH = 40
      const t = []
      for (let i = 0; i < n; i++) {
        const a = performance.now()
        for (let k = 0; k < BATCH; k++) s.gl.render(s.scene, s.camera)
        gl.finish() // GPU の完了を待つ
        t.push((performance.now() - a) / BATCH)
      }
      t.sort((x, y) => x - y)
      return {
        label: name,
        batch: BATCH,
        medianMs: t[Math.floor(t.length / 2)],
        minMs: t[0],
        p95Ms: t[Math.floor(t.length * 0.95)],
        pixels: s.gl.domElement.width * s.gl.domElement.height,
      }
    },
    [iterations, label],
  )
}

const clickButton = async (page, label) => {
  await page.locator('button').filter({ hasText: new RegExp(`^${label}$`) }).first().click()
  await page.waitForTimeout(500)
}

const runs = []

for (const size of [
  { name: 'デスクトップ 1440x900 @2x', width: 1440, height: 900, dsf: 2 },
  { name: 'デスクトップ 1920x1080 @2x', width: 1920, height: 1080, dsf: 2 },
]) {
  const page = await browser.newPage({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size.dsf,
  })
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.viewport canvas')
  await page.waitForFunction(() => !!window.__r3fState, null, { timeout: 15000 })
  await page.waitForTimeout(1500)

  const gpu = await page.evaluate(() => {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2') || c.getContext('webgl')
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info')
    return {
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'unknown',
      dpr: window.devicePixelRatio,
    }
  })

  // 完全挿入で静止
  await page.evaluate(() => {
    const sl = document.querySelector('input[aria-label="挿入深度"]')
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(sl, '14')
    sl.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.waitForTimeout(400)
  const idle = await measureAt(page, '静止 (完全挿入)')
  const costNormal = await measureRenderCost(page, '通常品質の描画コスト')

  // 自動挿入アニメ中 = 毎フレーム全接点を再評価する最も重い状態
  await page.locator('button').filter({ hasText: '自動抜去' }).first().click()
  await page.waitForTimeout(300)
  await page.locator('button').filter({ hasText: '自動挿入' }).first().click()
  await page.waitForTimeout(200)
  const animating = await measureAt(page, '挿抜アニメ中')

  // 低負荷モード (dpr=1 / アンチエイリアス無し)
  await clickButton(page, '低負荷モード')
  const lowIdle = await measureAt(page, '低負荷モード (静止)')
  const costLow = await measureRenderCost(page, '低負荷モードの描画コスト')

  runs.push({ viewport: size, gpu, idle, animating, lowIdle, costNormal, costLow })
  await page.close()
}

await browser.close()

const suffix = (HEADLESS ? 'headless' : 'real_gpu') + (UNTHROTTLED ? '_unthrottled' : '')

// 測定環境は実行時に取得する。ここを固定文字列にすると、別のマシンで回した人の
// 成果物に「実際には測っていない環境」が書き込まれてしまう。
const host = [os.type(), os.release(), os.arch(), `${os.cpus()[0]?.model ?? 'unknown CPU'} x${os.cpus().length}`]
  .filter(Boolean)
  .join(' / ')

const doc = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString().slice(0, 10),
  mode: (HEADLESS ? 'headless (比較用)' : 'headed Chrome (実 GPU)') + (UNTHROTTLED ? ' / vsync 解除' : ' / vsync あり'),
  host,
  gpu: runs[0]?.gpu?.renderer ?? 'unknown',
  loadAverage1min: os.loadavg()[0],
  note: HEADLESS
    ? 'ヘッドレス Chromium はソフトウェアラスタを使うため、絶対 fps は実機の値ではない。'
    : '実 GPU を使う headed Chrome での測定。ディスプレイのリフレッシュレートが上限になる (vsync)。',
  runs,
}
writeFileSync(resolve(process.cwd(), `artifacts/perf_${suffix}.json`), JSON.stringify(doc, null, 1))

console.log(`\n=== ${doc.mode} ===`)
for (const r of runs) {
  console.log(`\n--- ${r.viewport.name} (devicePixelRatio=${r.gpu.dpr}) ---`)
  console.log(`GPU : ${r.gpu.renderer}`)
  console.log(`形状: ${r.idle.triangles} 三角形 / ${r.idle.drawCalls} draw call`)
  for (const m of [r.idle, r.animating, r.lowIdle]) {
    console.log(
      `${m.label.padEnd(20)} 中央値 ${m.medianMs.toFixed(2).padStart(6)}ms  ` +
        `(${m.fps.toFixed(0).padStart(3)} fps)  p95 ${m.p95Ms.toFixed(2).padStart(6)}ms  ` +
        `最速 ${m.minMs.toFixed(2)}ms  ${(m.pixels / 1e6).toFixed(2)}Mpx`,
    )
  }
  console.log(`${r.costNormal.label.padEnd(20)} 中央値 ${r.costNormal.medianMs.toFixed(3).padStart(6)}ms  (${(r.costNormal.pixels/1e6).toFixed(2)}Mpx)`)
  console.log(`${r.costLow.label.padEnd(20)} 中央値 ${r.costLow.medianMs.toFixed(3).padStart(6)}ms  (${(r.costLow.pixels/1e6).toFixed(2)}Mpx)`)
  const gain = r.costNormal.medianMs / r.costLow.medianMs
  const pxRatio = r.costNormal.pixels / r.costLow.pixels
  console.log(`低負荷モードの効果: 描画コスト ${gain.toFixed(2)}倍速 (画素数は ${pxRatio.toFixed(2)}分の1)。16.7ms 予算に対する使用率 ${(r.costNormal.medianMs/16.7*100).toFixed(0)}% → ${(r.costLow.medianMs/16.7*100).toFixed(0)}%`)
}
