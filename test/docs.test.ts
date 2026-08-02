/**
 * 文書に載せた数字が、生成物と一致しているかを機械的に確かめる。
 *
 * なぜこれが要るか:
 *   2026-08-01 の監査で「文書と生成物のズレ」が 4 件見つかった。いずれも人力で
 *   気づいたもので、放っておけば次も人力頼みになる。
 *     - README / REPORT の看板の表に、どの生成物にも無い 8.22 mm が載っていた
 *     - TEST_RESULTS §5 の描画コスト 4 値が artifact のどの値とも一致しなかった
 *       (fps 表だけが再測定で更新され、コスト表が取り残された部分更新)
 *     - 同 §5 の測定日が artifact の generatedAt と 1 日ずれていた
 *     - 節見出しのテスト件数が、総数だけ直されて放置されていた
 *
 * 設計:
 *   「artifact の全数値を総当たりで文書から探す」はやらない。0 や 14 や 2 は
 *   どの文書にも偶然出てくるので、9 割が誤検出になる (実測して確認した)。
 *   代わりに **転記していると分かっているものだけを明示的に並べる**。
 *   増えないと意味が無いので、追加のコストは 1 行に抑えてある。
 *
 * 3 方向を見る:
 *   A. 深さ表      … 表の全数値が events.json に存在するか
 *   B. 転記値      … CLAIMS に並べた値が、指定した文書に載っているか
 *   C. 逆向き      … artifact にあるのに文書が拾っていない項目が無いか
 *
 * 数字の正本は artifacts/*.json であって、Markdown ではない。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')
const json = (p: string) => JSON.parse(read(p))

const events = json('artifacts/events.json')
const sensitivity = json('artifacts/sensitivity.json')
const verification = json('artifacts/verification_summary.json')
const forceCurve = json('artifacts/force_curve.json')
const perf = json('artifacts/perf_real_gpu.json')
const ui = json('artifacts/ui_verification.json')
const touch = json('artifacts/touch_verification.json')

const DOCS = [
  'docs/HALF_PLUG_ADAPTER.md',
  'README.md',
  'ASSUMPTIONS.md',
  'UNKNOWNS.md',
  'docs/REPORT.md',
  'docs/TEST_RESULTS.md',
  'docs/SENSITIVITY.md',
  'docs/VERIFICATION_PLAN.md',
  'SOURCES.md',
] as const
const text = Object.fromEntries(DOCS.map((f) => [f, read(f)])) as Record<string, string>

// ---------------------------------------------------------------------------
// A. 深さ表 — README と REPORT の「半挿しで何が起きるか」
// ---------------------------------------------------------------------------

const eventDepths = new Set<number>(
  [...events.major, ...events.stateChanges].map((e: { depthMm: number }) => e.depthMm),
)
const trueValues = new Set<number>([sensitivity.baseline.firstBridgeMm, sensitivity.baseline.bridgeEndMm])

const TABLES = [
  { file: 'README.md', heading: '## 半挿しで何が起きるか' },
  { file: 'docs/REPORT.md', heading: '## 4. 半挿しで何が起きるか' },
]

/** 「| 3.92 mm |」と「| 6.32〜7.04 mm |」の 2 形式だけを拾う */
function extractDepths(md: string, heading: string): { depths: number[]; annotated: number[] } {
  const start = md.indexOf(heading)
  if (start < 0) throw new Error(`見出しが見つからない: ${heading}`)
  const body = md.slice(start, md.indexOf('\n---', start))
  const depths: number[] = []
  const annotated: number[] = []
  for (const line of body.split('\n')) {
    const m = /^\|\s*([\d.]+)(?:〜([\d.]+))?\s*mm\s*\|/.exec(line)
    if (!m) continue
    depths.push(Number(m[1]))
    if (m[2]) depths.push(Number(m[2]))
    for (const t of line.matchAll(/真値\s*([\d.]+)/g)) annotated.push(Number(t[1]))
  }
  return { depths, annotated }
}

describe('A. 深さ表が events.json と一致している', () => {
  for (const { file, heading } of TABLES) {
    const { depths, annotated } = extractDepths(text[file], heading)

    it(`${file}: 表から 14 個の深さを抜き出せる`, () => {
      expect(depths.length).toBe(14)
    })

    it(`${file}: 全ての深さが artifacts/events.json に存在する`, () => {
      const missing = depths.filter((d) => !eventDepths.has(d))
      expect({ file, missing }).toEqual({ file, missing: [] })
    })

    it(`${file}: 表の中に走査値以外の精度を混ぜていない`, () => {
      // 2026-08-02 の再読レビューで、6.96〜13.14 の幅を持つ量に 4 桁の「真値」を
      // 併記すると精度の印象が戻る、と 2 人が独立に指摘した。
      // 二分法の値は表の外へ出し、表は走査値だけで揃える。
      const unknown = annotated.filter((v) => !trueValues.has(v))
      expect({ file, unknown }).toEqual({ file, unknown: [] })
    })
  }

  it('2 つの表の深さが互いに一致している', () => {
    const [a, b] = TABLES.map(({ file, heading }) => extractDepths(text[file], heading).depths)
    expect(a).toEqual(b)
  })

  it('二分法の値は表の外に、走査値との違いを添えて置かれている', () => {
    const md = text['README.md']
    // 値そのものは残す (捨てると走査刻みの粒度が読者に分からなくなる)
    expect(md).toContain(String(sensitivity.baseline.firstBridgeMm))
    expect(md).toContain(String(sensitivity.baseline.bridgeEndMm))
    // ただし「実物の値ではない」と明示すること
    expect(md).toContain('モデル内部の値で、実物の値ではありません')
  })

  it('走査値と真値を取り違えていない', () => {
    expect(events.stepMm).toBe(0.02)
    expect(sensitivity.baseline.firstBridgeMm).not.toBe(11.78)
    expect(eventDepths.has(11.78)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// B. 転記値 — artifact の値が、指定した文書に「その表記で」載っているか
// ---------------------------------------------------------------------------

interface Claim {
  /** どの生成物の何か (失敗時に読む人が辿れるように) */
  what: string
  /** 文書に載っているはずの文字列。artifact の値から作る */
  expect: string
  /** この文字列を含んでいなければならない文書 */
  files: readonly string[]
}

const N = (v: number, d = 2) => v.toFixed(d)

const CLAIMS: Claim[] = [
  // --- 根拠区分の内訳 (3 文書に転記している) ---
  {
    what: 'verification_summary.gradeCounts.FACT',
    expect: `| FACT | ${verification.gradeCounts.FACT} |`,
    files: ['README.md', 'docs/REPORT.md'],
  },
  {
    what: 'verification_summary.gradeCounts.DERIVED',
    expect: `| DERIVED | ${verification.gradeCounts.DERIVED} |`,
    files: ['README.md', 'docs/REPORT.md'],
  },
  {
    what: 'verification_summary.gradeCounts.ASSUMPTION',
    expect: `| ASSUMPTION | ${verification.gradeCounts.ASSUMPTION} |`,
    files: ['README.md', 'docs/REPORT.md'],
  },

  // --- 挿抜力 (5.27 は 4 文書に出る看板の数字) ---
  {
    what: 'force_curve.summary.peakInsertionN',
    expect: `${N(forceCurve.summary.peakInsertionN)} N`,
    files: ['docs/REPORT.md', 'docs/TEST_RESULTS.md', 'ASSUMPTIONS.md', 'docs/SENSITIVITY.md'],
  },
  {
    what: 'force_curve.summary.peakWithdrawalN',
    expect: `${N(forceCurve.summary.peakWithdrawalN)} N`,
    files: ['docs/REPORT.md', 'ASSUMPTIONS.md'],
  },

  // --- 完全挿入時の押付力 ---
  {
    what: 'verification_summary.fullyInserted.normalForcesN (3 接点)',
    expect: `${N(verification.fullyInserted.normalForcesN.JC_SLEEVE, 3)} / ${N(
      verification.fullyInserted.normalForcesN.JC_RING,
      3,
    )} / ${N(verification.fullyInserted.normalForcesN.JC_TIP, 3)} N`,
    files: ['docs/REPORT.md', 'docs/TEST_RESULTS.md'],
  },

  // --- 性能 (ここが 2026-08-01 に壊れていた) ---
  {
    what: 'perf_real_gpu.generatedAt',
    expect: perf.generatedAt,
    files: ['docs/TEST_RESULTS.md'],
  },
  {
    what: 'perf_real_gpu.runs[0].idle.triangles (面取り削除前の形状)',
    expect: String(perf.runs[0].idle.triangles),
    files: ['docs/TEST_RESULTS.md'],
  },
  {
    what: 'perf_real_gpu.runs[0].costNormal.medianMs',
    expect: `${N(perf.runs[0].costNormal.medianMs, 4)} ms`,
    files: ['docs/TEST_RESULTS.md'],
  },
  {
    what: 'perf_real_gpu.runs[0].costLow.medianMs',
    expect: `${N(perf.runs[0].costLow.medianMs, 4)} ms`,
    files: ['docs/TEST_RESULTS.md'],
  },
  {
    what: 'perf_real_gpu.runs[1].costNormal.medianMs',
    expect: `${N(perf.runs[1].costNormal.medianMs, 4)} ms`,
    files: ['docs/TEST_RESULTS.md'],
  },
  {
    what: 'perf_real_gpu.runs[1].costLow.medianMs',
    expect: `${N(perf.runs[1].costLow.medianMs, 4)} ms`,
    files: ['docs/TEST_RESULTS.md'],
  },
  {
    what: 'perf_real_gpu.runs[0].idle.fps',
    expect: `fps ${N(perf.runs[0].idle.fps, 1)}`,
    files: ['docs/TEST_RESULTS.md', 'docs/REPORT.md', 'README.md'],
  },

  // --- 検証件数 ---
  {
    what: 'ui_verification.total',
    expect: `${ui.total} 件すべて成功`,
    files: ['docs/TEST_RESULTS.md', 'docs/REPORT.md'],
  },
  {
    what: 'touch_verification.total',
    expect: `${touch.total} 件すべて成功`,
    files: ['docs/TEST_RESULTS.md', 'docs/REPORT.md'],
  },

  // --- 感度解析 (公開している主要値) ---
  {
    what: 'sensitivity.baseline.firstBridgeMm',
    expect: String(sensitivity.baseline.firstBridgeMm),
    files: ['README.md', 'docs/REPORT.md', 'docs/SENSITIVITY.md'],
  },
  {
    what: 'sensitivity.tipBridge.complianceThreshold',
    expect: String(sensitivity.tipBridge.complianceThreshold),
    files: ['docs/SENSITIVITY.md', 'ASSUMPTIONS.md'],
  },
  {
    what: 'sensitivity.tipBridge.toleranceBox.worstCorner (最悪コーナー)',
    expect: String(sensitivity.tipBridge.toleranceBox.worstCorner.tipThreshold),
    files: ['docs/SENSITIVITY.md', 'UNKNOWNS.md', 'ASSUMPTIONS.md', 'docs/VERIFICATION_PLAN.md'],
  },
  {
    what: 'sensitivity.tipBridge.toleranceBox.marginVsAdopted',
    expect: `${N(sensitivity.tipBridge.toleranceBox.marginVsAdopted)} 倍`,
    files: ['docs/SENSITIVITY.md', 'UNKNOWNS.md', 'ASSUMPTIONS.md', 'docs/VERIFICATION_PLAN.md'],
  },
  {
    what: 'sensitivity.tipBridge.toleranceBox.marginVsAdoptedRangeTop',
    expect: `${N(sensitivity.tipBridge.toleranceBox.marginVsAdoptedRangeTop)} 倍`,
    files: ['docs/SENSITIVITY.md', 'UNKNOWNS.md'],
  },
  {
    what: 'sensitivity.tipBridge.toleranceBox.breakEven.atAdopted005 (結論が崩れる線)',
    expect: N(sensitivity.tipBridge.toleranceBox.breakEven.atAdopted005.diameterDiff, 3),
    files: ['docs/VERIFICATION_PLAN.md', 'UNKNOWNS.md', 'docs/SENSITIVITY.md'],
  },
  {
    what: 'sensitivity.bridgeDepthRange.joint (同時振りの幅)',
    expect: `${N(sensitivity.bridgeDepthRange.joint.minMm)}〜${N(
      sensitivity.bridgeDepthRange.joint.maxMm,
    )} mm`,
    files: ['README.md', 'docs/REPORT.md', 'docs/SENSITIVITY.md'],
  },
  {
    what: 'sensitivity.tipBridge.insideStepHeight.tried (内側を埋めた構成数)',
    expect: `${sensitivity.tipBridge.insideStepHeight.tried} 通り`,
    files: ['README.md', 'docs/SENSITIVITY.md'],
  },
  {
    what: 'sensitivity.forceModel.joint (力の幅)',
    expect: `${N(sensitivity.forceModel.joint.minN)} 〜 ${N(sensitivity.forceModel.joint.maxN)} N`,
    files: ['docs/SENSITIVITY.md'],
  },
  {
    what: 'sensitivity.forceModel.joint.belowSpec3N',
    expect: `${sensitivity.forceModel.joint.belowSpec3N} / 256`,
    files: ['docs/SENSITIVITY.md', 'docs/REPORT.md', 'ASSUMPTIONS.md'],
  },
  {
    what: 'sensitivity.forceModel.joint.detentDominated',
    expect: `${sensitivity.forceModel.joint.detentDominated} / 256`,
    files: ['docs/SENSITIVITY.md', 'ASSUMPTIONS.md'],
  },
  {
    what: 'sensitivity.tipBridge.toleranceBox.breakEven.atRangeTop010',
    expect: N(sensitivity.tipBridge.toleranceBox.breakEven.atRangeTop010.diameterDiff, 3),
    files: ['docs/SENSITIVITY.md'],
  },
  {
    what: 'sensitivity.tipBridge.toleranceBox.worstCorner の段差（直径差）',
    expect: `${N(2 * sensitivity.tipBridge.toleranceBox.worstCorner.stepHeight)} mm`,
    files: ['docs/VERIFICATION_PLAN.md', 'UNKNOWNS.md'],
  },
  {
    what: 'SOURCES.md が絶縁帯の実測を「幅」として記録している',
    expect: 'φ3.20〜3.22',
    files: ['SOURCES.md', 'docs/SENSITIVITY.md', 'UNKNOWNS.md'],
  },
]

/** 公差の箱は 15 マスある。文書に載せている 2 文書ぶんを全マス照合する */
for (const cell of sensitivity.tipBridge.toleranceBox.grid as {
  bodyDiameter: number
  insulatorDiameter: number
  tipThreshold: number
}[]) {
  CLAIMS.push({
    what: `公差の箱 φ${cell.bodyDiameter} × 絶縁 φ${cell.insulatorDiameter}`,
    expect: String(cell.tipThreshold),
    files: ['docs/SENSITIVITY.md'],
  })
}

/** 校正係数が純粋な倍率であることを示す 3 点 */
for (const c of sensitivity.forceModel.calibrationScaleIsPureMultiplier as {
  scale: number
  peakN: number
}[]) {
  CLAIMS.push({
    what: `校正係数 ${c.scale} のときのピーク`,
    expect: String(c.peakN),
    files: ['docs/SENSITIVITY.md'],
  })
}

// 力の片振り (OAT) は文字列で照合しない。
// artifact が 3 桁に丸めた値をさらに 2 桁へ丸めると、真値の丸めと食い違うことがある
// (4.2551… → artifact 4.255 → 再度丸めて 4.25。しかし真値からは 4.26)。
// 丸めた浮動小数を文字列比較するのは道具の選択を誤っている。数値で照合する。

/** SENSITIVITY §3-4 の片振り表を読み、artifact と数値で突き合わせる */
function parseOatTable(): { label: string; lo: number; hi: number }[] {
  const md = text['docs/SENSITIVITY.md']
  const start = md.indexOf('**片振り（採用値 5.27 N から）**')
  if (start < 0) throw new Error('片振りの表が見つからない')
  const body = md.slice(start, md.indexOf('**8 件同時', start))
  const rows: { label: string; lo: number; hi: number }[] = []
  for (const line of body.split('\n')) {
    // 強調の ** が付いている行もあるので許容する
    const m = /^\|\s*([^|]+?)\s*\|[^|]*\|\s*\*{0,2}([\d.]+) N\*{0,2}\s*\|\s*\*{0,2}([\d.]+) N\*{0,2}\s*\|/.exec(line)
    if (m) rows.push({ label: m[1], lo: Number(m[2]), hi: Number(m[3]) })
  }
  return rows
}

describe('B. 文書に転記した artifact の値が一致している', () => {
  for (const c of CLAIMS) {
    it(`${c.what} = 「${c.expect}」`, () => {
      const missing = c.files.filter((f) => !text[f].includes(c.expect))
      expect({ what: c.what, expect: c.expect, missing }).toEqual({
        what: c.what,
        expect: c.expect,
        missing: [],
      })
    })
  }

  it('力の片振り表が artifact と数値で一致する (丸め幅 0.01 以内)', () => {
    const rows = parseOatTable()
    const oat = sensitivity.forceModel.oneAtATime as { key: string; peakAtLo: number; peakAtHi: number }[]
    // 表の行数と artifact の項目数が一致していること (行を落としたら気づける)
    expect(rows.length).toBe(oat.length)
    // 表の各値が、artifact のどれかの値と 0.01 以内で対応すること
    const artifactValues = oat.flatMap((o) => [o.peakAtLo, o.peakAtHi])
    const orphan = rows
      .flatMap((r) => [r.lo, r.hi])
      .filter((v) => !artifactValues.some((a) => Math.abs(a - v) <= 0.01))
    expect(orphan).toEqual([])
  })

  it('README の「振れ幅」が感度解析の実測と一致する', () => {
    // 2026-08-02 の再読レビューで、要約が「±3 mm」となっていて実測と合わないことが
    // 見つかった。実際は非対称で最大 4.82 mm。対称な誤差だという誤った印象も与えていた。
    // 要約を書き換えた以上、artifact から再計算して固定する。
    const j = sensitivity.bridgeDepthRange.joint
    const breaks = (sensitivity.previouslyUnswept.ringBreakOpenDeflection as { depth: number | null }[])
      .map((x) => x.depth)
      .filter((d): d is number => d != null)
    const md = text['README.md']
    // 表に出している基準値 (走査値) から見た振れ
    expect(md).toContain(`下へ **−${(11.78 - j.minMm).toFixed(2)}** / 上へ +${(j.maxMm - 11.78).toFixed(2)}`)
    expect(md).toContain(
      `下へ −${(8.06 - Math.min(...breaks)).toFixed(2)} / 上へ **+${(Math.max(...breaks) - 8.06).toFixed(2)}**`,
    )
    const worst = Math.max(11.78 - j.minMm, j.maxMm - 11.78, 8.06 - Math.min(...breaks), Math.max(...breaks) - 8.06)
    expect(md).toContain(`最大 ${worst.toFixed(1)} mm`)
  })

  it('「HTML 版を生成しています」と書いた文書は、実際に生成対象に入っている', () => {
    // 2026-08-02: HALF_PLUG_ADAPTER.md が冒頭でそう書きながら、
    // mdToHtml.mjs の対象に入っておらず HTML が存在しなかった。
    // 文書が自分について嘘をついている状態は、この企画で最も避けたい形。
    const gen = readFileSync(resolve(ROOT, 'scripts/mdToHtml.mjs'), 'utf8')
    const claiming = readdirSync(resolve(ROOT, 'docs'))
      .filter((f) => f.endsWith('.md'))
      .filter((f) => readFileSync(resolve(ROOT, 'docs', f), 'utf8').includes('npm run docs:html'))
    expect(claiming.length).toBeGreaterThan(0)
    for (const f of claiming) {
      expect({ f, inTargets: gen.includes(`docs/${f}`) }).toEqual({ f, inTargets: true })
      expect({ f, htmlExists: existsSync(resolve(ROOT, 'docs', f.replace(/\.md$/, '.html'))) }).toEqual({
        f,
        htmlExists: true,
      })
    }
  })

  it('HALF_PLUG_ADAPTER の本命区間が profile と一致する', () => {
    // 手で書いた区間の数字が、生成物とずれないようにする
    const prof = json('artifacts/half_plug_topology_profile.v1.trs_jack_trrs.json')
    const iv = prof.intervals.find(
      (x: { acousticAnnotation: { topologyClass: string } }) =>
        x.acousticAnnotation.topologyClass === 'ground-open-differential',
    )
    expect(iv).toBeTruthy()
    const md = text['docs/HALF_PLUG_ADAPTER.md']
    expect(md).toContain(iv.intervalId)
    expect(md).toContain(iv.nominalStartMm.toFixed(2))
    expect(md).toContain(iv.nominalEndMm.toFixed(2))
    expect(md).toContain(iv.normalizedStart.toFixed(4))
    expect(md).toContain(iv.normalizedEnd.toFixed(4))
    // 窓の幅とストローク比
    const w = iv.nominalEndMm - iv.nominalStartMm
    expect(md).toContain(`${w.toFixed(2)} mm 幅`)
    expect(md).toContain(`${((100 * w) / prof.fullInsertionDepthMm).toFixed(1)} %`)
  })

  it('README 末尾の仮定件数が台帳と一致する', () => {
    // 2026-08-01 の初見レビューで「41 件」と「37 件」が併存していたのが見つかった。
    // 37 はどの部分集合にも対応しない、単に古い数字だった。
    // 根拠区分を看板にしている文書で、自分の仮定件数が 2 通りあるのは最も安く直せる傷。
    const dims = json('src/data/dimensions.json').entries as Record<string, { grade: string }>
    const assumptions = Object.keys(dims).filter((k) => dims[k].grade === 'ASSUMPTION')
    const jackInternal = assumptions.filter((k) => /^(jack\.|trrs\.jack\.)/.test(k))
    expect(text['README.md']).toContain(`ジャック内部の寸法は ${jackInternal.length} 件の仮定を含み`)
    expect(text['README.md']).toContain(`仮定は全体で ${assumptions.length} 件`)
  })

  it('感度解析の振り幅は台帳から来ている (スクリプト直書きでない)', () => {
    const dims = json('src/data/dimensions.json').entries
    expect(dims['plug.bodyRadius'].tolerance).toBe(0.025)
    expect(dims['plug.insulatorRadius'].sweepRange).toEqual([1.6, 1.61])
    // tolerance は左右対称の意味しか持たない。UI が ±0.01 と誤表示するので使ってはいけない
    expect(dims['plug.insulatorRadius'].tolerance).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// C. 逆向き — artifact にあるのに文書が拾っていないものが無いか
//
// 文書は 27 件 / 20 件を逐語で並べず要約している。全数を逐語で要求すると
// 文書が機械の吐き出しになって読めなくなるので、次の 2 段で見る:
//   1. 件数は必ず一致させる
//   2. 逐語で載せないものは、理由つきで明示的に除外する
//      → 新しい検証項目が増えたとき、除外を書くまでテストが落ちる
// ---------------------------------------------------------------------------

interface Exclusion {
  pattern: RegExp
  reason: string
}

const UI_NOT_QUOTED: Exclusion[] = [
  { pattern: /^(断面|接点のみ|分解|寸法)表示/, reason: '§4「表示」で 4 件まとめて 1 行に要約している' },
  { pattern: /^(キーボード|End|Home|R キー|数値入力|0\.05mm|イベントマーカー)/, reason: '§4「操作」で操作系をまとめて要約している' },
  { pattern: /^狭い画面では/, reason: '§4「表示」のレスポンシブ行に含めている' },
  { pattern: /^(GL 実装を記録|ポリゴン数が過大でない)/, reason: '§5 で実測値そのものを載せているので、合否行は重複' },
  { pattern: /^(挿抜アニメ中も|低負荷モードで)/, reason: '§5 のフレーム時間表と低負荷モード節が実測値で扱っている' },
  { pattern: /^コンソールエラーが無い/, reason: '冒頭表の「コンソールエラー 0」で扱っている' },
  { pattern: /^境界停止で Ring↔Sleeve の橋絡が出る/, reason: '§2 の橋絡の節が深さつきで扱っている' },
  { pattern: /^4極 CTIA プラグ/, reason: '§3 の TRRS 節が扱っている' },
  { pattern: /^根拠パネルに FACT/, reason: '根拠区分の内訳表そのものを載せている' },
]

const TOUCH_NOT_QUOTED: Exclusion[] = [
  {
    pattern: /^(iPhone 15 Pro|iPad Pro 11): /,
    reason: '§6-2 は 2 機種 × 10 項目を機種別に列挙せず要約している（件数は照合済み）',
  },
]

/** 逐語で載せることを要求する項目。中心的な結論を裏づけるものだけ */
const MUST_QUOTE = ['第1絶縁帯の深さ (8.35mm) では橋絡が出ない']

describe('C. artifact にあるのに文書が拾っていない項目が無い', () => {
  const doc = text['docs/TEST_RESULTS.md']

  it('ui_verification: 件数が文書と一致する', () => {
    expect(ui.results.length).toBe(ui.total)
    expect(ui.passed).toBe(ui.total)
    expect(doc).toContain(`${ui.total} 件すべて成功`)
  })

  it('touch_verification: 件数が文書と一致する', () => {
    expect(touch.results.length).toBe(touch.total)
    expect(touch.passed).toBe(touch.total)
    expect(doc).toContain(`${touch.total} 件すべて成功`)
  })

  it('ui_verification: 全項目が「文書に載っている」か「理由つきで除外されている」', () => {
    const unaccounted = ui.results
      .map((r: { name: string }) => r.name)
      .filter((n: string) => !doc.includes(n) && !UI_NOT_QUOTED.some((e) => e.pattern.test(n)))
    expect(unaccounted).toEqual([])
  })

  it('touch_verification: 全項目が「文書に載っている」か「理由つきで除外されている」', () => {
    const unaccounted = touch.results
      .map((r: { name: string }) => r.name)
      .filter((n: string) => !doc.includes(n) && !TOUCH_NOT_QUOTED.some((e) => e.pattern.test(n)))
    expect(unaccounted).toEqual([])
  })

  it('中心的な結論を裏づける項目は逐語で載っている', () => {
    for (const name of MUST_QUOTE) {
      // artifact 側に実在することもあわせて確かめる (綴りが変わったら気づけるように)
      expect(ui.results.some((r: { name: string }) => r.name === name)).toBe(true)
      expect(doc).toContain(name)
    }
  })

  it('除外にはすべて理由が書かれている', () => {
    for (const e of [...UI_NOT_QUOTED, ...TOUCH_NOT_QUOTED]) expect(e.reason.length).toBeGreaterThan(10)
  })
})
