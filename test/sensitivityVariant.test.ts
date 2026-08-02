/**
 * 感度情報が variant を跨いで混入しないことの検証。
 * 統合フォローアップ（2026-08-03）P0-4 の 7 項目に対応する。
 *
 * ## 何が起きていたか
 *
 * `scripts/sensitivity.ts` は解析基準を `TRS|JACK-TRS` に固定している。
 * ところが exporter は variant を問わず単一の `artifacts/sensitivity.json` を読み、
 * その `eventSpread.byKind` を**どの profile へも配っていた。**
 *
 * ```
 * TRS×TRS   FIRST_BREAK_OPEN  名目 8.06mm  幅 8.06〜8.06mm   ← 一致
 * TRS×TRRS  FIRST_BREAK_OPEN  名目 8.48mm  幅 8.06〜8.06mm   ← **名目値が幅の外**
 * ```
 *
 * 名目値が自分の幅の外にあるのは、その幅が別のモデルのものだからである。
 * Half-Plug Lab 側の fixture import で見つかった。
 *
 * **こちらの検査は 45 本あって、どれも捕まえなかった。**
 * 構造（一意性・連続性・存在）は見ていたが、記録された値どうしの整合を見ていなかった。
 */

import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { listInputs } from '../scripts/provenance'
import { mustFind } from './_must'

const ROOT = resolve(__dirname, '..')
const J = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))

const trs = J('artifacts/half_plug_topology_profile.v2.trs_jack_trs.json')
const trrs = J('artifacts/half_plug_topology_profile.v2.trs_jack_trrs.json')
const sensTrs = J('artifacts/sensitivity.trs_jack_trs.json')
const sensTrrs = J('artifacts/sensitivity.trs_jack_trrs.json')

const tmps: string[] = []
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })))

/**
 * 感度 artifact を差し替えて profile を作り、その中身を返す。
 *
 * **リポジトリの `artifacts/` には触らない。**
 * 一時 root を作り、コードは symlink で共有し、`artifacts/` だけ実体を複製して
 * そこの感度 artifact を書き換える。
 *
 * 最初は実物を一時的に差し替えて finally で戻す形にしたが、
 * **vitest はファイルを並列に走らせるので、差し替えている最中に
 * 別のテスト（validate:profiles を起動するもの）がそれを読んで落ちた。**
 * 共有状態を触るテストは、そもそも共有しない形にする。
 */
function exportWith(variant: string, slug: string, mutate: (a: Record<string, unknown>) => void) {
  const d = mkdtempSync(join(tmpdir(), 'trs-sens-'))
  tmps.push(d)
  // コードと依存は symlink で共有する（複製すると vite の解決が壊れる）
  for (const sub of ['node_modules', 'src', 'scripts', 'schemas', 'package.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'tsconfig.scripts.json'])
    symlinkSync(resolve(ROOT, sub), join(d, sub))
  // artifacts だけ実体を複製する
  cpSync(resolve(ROOT, 'artifacts'), join(d, 'artifacts'), { recursive: true })

  const p = join(d, `artifacts/sensitivity.${slug}.json`)
  const a = JSON.parse(readFileSync(p, 'utf8'))
  mutate(a)
  writeFileSync(p, JSON.stringify(a, null, 1) + '\n')

  execFileSync('npx', ['vite-node', resolve(ROOT, 'scripts/exportHalfPlugProfile.ts'), '--variant', variant], {
    cwd: d,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return JSON.parse(readFileSync(join(d, `artifacts/half_plug_topology_profile.v2.${slug}.json`), 'utf8'))
}

describe('P0-4 感度情報が variant を跨がない', () => {
  it('1. **TRS の FIRST_BREAK_OPEN は、TRS 自身の幅に含まれる**', () => {
    const e = mustFind(
      trs.events as { kind: string; depthMm: number; spreadStatus: string; spreadMm: { minMm: number; maxMm: number } }[],
      (x) => x.kind === 'FIRST_BREAK_OPEN',
      'TRS の FIRST_BREAK_OPEN',
    )
    expect(e.spreadStatus).toBe('MODEL_SWEEP_EVENT_SPECIFIC')
    expect({ 名目: e.depthMm, 下限: e.spreadMm.minMm, 上限: e.spreadMm.maxMm }).toEqual({
      名目: 8.06,
      下限: 8.06,
      上限: 8.06,
    })
  })

  it('2. **TRRS の FIRST_BREAK_OPEN に TRS の幅（8.06〜8.06）が付いていない**', () => {
    const e = mustFind(
      trrs.events as { kind: string; depthMm: number; spreadMm: { minMm: number; maxMm: number; sweptParameters: string[] } }[],
      (x) => x.kind === 'FIRST_BREAK_OPEN',
      'TRRS の FIRST_BREAK_OPEN',
    )
    expect(e.depthMm).toBe(8.48)
    // 名目値が自分の幅の中にあること。ここが今回の欠陥そのもの
    expect({
      幅の外: e.depthMm < e.spreadMm.minMm || e.depthMm > e.spreadMm.maxMm,
    }).toEqual({ 幅の外: false })
    // TRS の幅そのものが付いていないこと
    expect({ min: e.spreadMm.minMm, max: e.spreadMm.maxMm }).not.toEqual({ min: 8.06, max: 8.06 })
    // 振った寸法が 4極のキーであること（3極のキーが載っていない）
    for (const k of e.spreadMm.sweptParameters) expect({ k, trrs: k.startsWith('trrs.') }).toEqual({ k, trrs: true })
  })

  it('3. **variant が食い違う感度 artifact は取り込まない（available:false）**', () => {
    const p = exportWith('TRS|JACK-TRRS', 'trs_jack_trrs', (a) => {
      a.variantId = 'TRS|JACK-TRS' // 別 variant のものにすり替える
    })
    expect(p.sensitivitySummary.available).toBe(false)
    expect(p.sensitivitySummary.notes.join()).toMatch(/variantId が/)
  }, 120_000)

  it('4. **variant が食い違うと、全事象の spreadMm が null になる**', () => {
    const p = exportWith('TRS|JACK-TRRS', 'trs_jack_trrs', (a) => {
      a.variantId = 'TRRS-CTIA|JACK-TRRS'
    })
    const withSpread = p.events.filter((e: { spreadMm: unknown }) => e.spreadMm !== null)
    expect({ 幅が付いた事象: withSpread.length }).toEqual({ 幅が付いた事象: 0 })
    for (const e of p.events) expect(e.spreadStatus).toBe('NOT_ANALYZED')
  }, 120_000)

  it('5. **profile の入力に、その variant の感度 artifact が入っている**', () => {
    for (const [slug, p] of [
      ['trs_jack_trs', trs],
      ['trs_jack_trrs', trrs],
    ] as const) {
      const paths = (p.provenance.inputFiles as { path: string }[]).map((f) => f.path)
      expect({ slug, has: paths.includes(`artifacts/sensitivity.${slug}.json`) }).toEqual({ slug, has: true })
      // **別 variant の感度は入力に入らない**（入ると ID が巻き添えで変わる）
      const other = slug === 'trs_jack_trs' ? 'trs_jack_trrs' : 'trs_jack_trs'
      expect({ slug, hasOther: paths.includes(`artifacts/sensitivity.${other}.json`) }).toEqual({
        slug,
        hasOther: false,
      })
    }
  })

  it('6/7. **片方の感度を測り直しても、もう片方の profile ID は変わらない**', () => {
    // 入力一覧を variant ごとに引き、相手の感度 artifact を含まないことを確かめる。
    // 含んでいると、3極の感度を測り直しただけで 4極 profile の ID まで変わる
    const trsInputs = listInputs(ROOT, 'trs_jack_trs').map((f) => f.path)
    const trrsInputs = listInputs(ROOT, 'trs_jack_trrs').map((f) => f.path)
    expect(trsInputs).not.toContain('artifacts/sensitivity.trs_jack_trrs.json')
    expect(trrsInputs).not.toContain('artifacts/sensitivity.trs_jack_trs.json')
    // その結果、2 つの profile の digest は別物になる
    expect(trs.provenance.inputDigest).not.toBe(trrs.provenance.inputDigest)
    expect(trs.profileId).not.toBe(trrs.profileId)
  })

  it('**感度 artifact 自身が、どの variant の解析かを名乗っている**', () => {
    expect({ trs: sensTrs.variantId, trrs: sensTrrs.variantId }).toEqual({
      trs: 'TRS|JACK-TRS',
      trrs: 'TRS|JACK-TRRS',
    })
    for (const s of [sensTrs, sensTrrs]) {
      expect(s.basis).toBe('MODEL_PARAMETER_SWEEP')
      expect(s.analysisScope).toBe('EVENT_DEPTH_SPREAD_ONLY')
      expect(s.sweptParameters.length).toBeGreaterThan(0)
      // 既定値が走査範囲の中にあること。外だと名目値が幅の外に出る
      expect(s.sweep.shippedInsideSweptRange).toBe(true)
      expect(s.sweep.configurationsUsable).toBeGreaterThan(0)
    }
    // 4極の走査軸は 4極のキー
    for (const k of sensTrrs.sweptParameters) expect({ k, ok: k.startsWith('trrs.') }).toEqual({ k, ok: true })
  })

  it('**`MEASURED` という語を使っていない**（実物測定と誤認される）', () => {
    for (const [name, p] of [['TRS', trs], ['TRRS', trrs]] as const) {
      const statuses = new Set((p.events as { spreadStatus: string }[]).map((e) => e.spreadStatus))
      for (const s of statuses)
        expect({ name, s, allowed: ['MODEL_SWEEP_EVENT_SPECIFIC', 'MODEL_SWEEP_NOT_EVENT_SPECIFIC', 'NOT_ANALYZED'].includes(s) })
          .toEqual({ name, s, allowed: true })
    }
  })

  it('**3極の総合解析を他の variant へ持ち出していない**', () => {
    // bridgeDepthJointRangeMm / tipBridge* は 3極の幾何に結びついた解析
    expect(trs.sensitivitySummary.bridgeDepthJointRangeMm).not.toBeNull()
    expect({
      trrs_bridge: trrs.sensitivitySummary.bridgeDepthJointRangeMm,
      trrs_tipCompliance: trrs.sensitivitySummary.tipBridgeComplianceThreshold,
      trrs_tipCorner: trrs.sensitivitySummary.tipBridgeWorstCornerThreshold,
    }).toEqual({ trrs_bridge: null, trrs_tipCompliance: null, trrs_tipCorner: null })
  })
})
