/**
 * 文書に載せた深さの数字が、生成物と一致しているかを機械的に確かめる。
 *
 * なぜこれが要るか:
 *   「半挿しで何が起きるか」の表は README.md と docs/REPORT.md の 2 か所にあり、
 *   どちらも出典を artifacts/events.json と明記している。しかし表は人間が書いており、
 *   実際に 2026-08-01 の監査で **artifacts のどこにも存在しない 8.22 mm** が
 *   両方に載っていることが見つかった (正しくは 8.26)。
 *
 *   表そのものは自動生成できない。第2列の「左チャンネルがグランドに落ちる」
 *   「ばねが先端の逆テーパを下るため」といった因果の説明は events.json に無いからだ。
 *   そこで「文言は人間が書く / 数字は生成物と一致していることを機械が保証する」に分けた。
 *
 * 数字の正本は artifacts/events.json であって、どちらの Markdown でもない。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')

interface EventEntry {
  depthMm: number
  label: string
}
const events = JSON.parse(read('artifacts/events.json')) as {
  stepMm: number
  major: EventEntry[]
  stateChanges: EventEntry[]
}
const sensitivity = JSON.parse(read('artifacts/sensitivity.json')) as {
  baseline: { firstBridgeMm: number; bridgeEndMm: number }
}

/** events.json に現れる全ての深さ */
const eventDepths = new Set([...events.major, ...events.stateChanges].map((e) => e.depthMm))
/** 二分法で求めた真値。表では「(真値 X)」として併記している */
const trueValues = new Set([sensitivity.baseline.firstBridgeMm, sensitivity.baseline.bridgeEndMm])

const TABLES = [
  { file: 'README.md', heading: '## 半挿しで何が起きるか' },
  { file: 'docs/REPORT.md', heading: '## 4. 半挿しで何が起きるか' },
]

/**
 * 深さ表の行から深さを抜き出す。
 * 「| 3.92 mm | ... |」と「| 6.32〜7.04 mm | ... |」の 2 形式だけを拾う。
 */
function extractDepths(md: string, heading: string): { depths: number[]; annotated: number[] } {
  const start = md.indexOf(heading)
  if (start < 0) throw new Error(`見出しが見つからない: ${heading}`)
  // 表は見出しの直後にあり、次の "\n---" までで終わる
  const body = md.slice(start, md.indexOf('\n---', start))
  const depths: number[] = []
  const annotated: number[] = []
  for (const line of body.split('\n')) {
    const m = /^\|\s*([\d.]+)(?:〜([\d.]+))?\s*mm\s*\|/.exec(line)
    if (!m) continue
    depths.push(Number(m[1]))
    if (m[2]) depths.push(Number(m[2]))
    // 「(真値 11.760)」形式の併記
    for (const t of line.matchAll(/真値\s*([\d.]+)/g)) annotated.push(Number(t[1]))
  }
  return { depths, annotated }
}

describe('文書の深さ表が生成物と一致している', () => {
  for (const { file, heading } of TABLES) {
    const md = read(file)
    const { depths, annotated } = extractDepths(md, heading)

    it(`${file}: 表から深さを抜き出せる`, () => {
      // 12 行 + 範囲表記 2 行の右端 = 14 個
      expect(depths.length).toBe(14)
    })

    it(`${file}: 表の全ての深さが artifacts/events.json に存在する`, () => {
      const missing = depths.filter((d) => !eventDepths.has(d))
      // 失敗時にどの値が無いかを見せる (8.22 はこれで見つかった)
      expect({ file, missing }).toEqual({ file, missing: [] })
    })

    it(`${file}: 併記された「真値」は感度解析の値である`, () => {
      expect(annotated.length).toBeGreaterThan(0)
      const unknown = annotated.filter((v) => !trueValues.has(v))
      expect({ file, unknown }).toEqual({ file, unknown: [] })
    })
  }

  it('2 つの表の深さが互いに一致している', () => {
    const [a, b] = TABLES.map(({ file, heading }) => extractDepths(read(file), heading).depths)
    expect(a).toEqual(b)
  })

  it('走査値と真値を取り違えていない (11.78 は 0.02 mm 刻みの値)', () => {
    // 走査刻みは events.json 自身が持っている
    expect(events.stepMm).toBe(0.02)
    // 真値は走査値と一致しない。だから表は両方を併記する必要がある
    expect(sensitivity.baseline.firstBridgeMm).not.toBe(11.78)
    expect(eventDepths.has(11.78)).toBe(true)
  })
})
