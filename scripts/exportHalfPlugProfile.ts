/**
 * Half-Plug Topology Profile v1 の書き出し。
 *   npm run export:half-plug
 *
 * 何のためか:
 *   半挿しイヤホン音響エミュレーター (Half-Plug Lab) へ、接点トポロジーを
 *   渡すための中立 JSON。3D 描画にも音声処理にも依存しない。
 *
 * **これは DSP 係数の供給源ではない。**
 *   統合オーダー (2026-08-01) が禁じている結合を、ここでも守る:
 *     - quality を接触抵抗 Ω・ゲイン・クロストーク量へ変換しない
 *     - acoustic.code を係数として扱わない (参考分類として annotation に入れるだけ)
 *     - 1 機種の mm 値を一般的な「挿入深度」にしない (normalized を併記する)
 *     - 未実測なのに verifiedPhysical=true にしない
 *     - 既定モデルに存在しない音響状態を出力しない
 *
 * 決定性:
 *   同じ入力・同じ ARTIFACT_DATE・同じ SOURCE_REVISION なら byte-identical。
 *   乱数も現在時刻も使わない。
 */

import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getModel } from '../src/data'
import { DEFAULT_FAULTS } from '../src/model/contact'
import { extractEvents, sweep } from '../src/model/sweep'
import type { TrsModel } from '../src/model/engine'

const ROOT = resolve(process.cwd())
const STEP_MM = 0.02

// --- 引数 ---------------------------------------------------------------
// 既定は 3極×3極。ただし **無改造で左右差分が残るのは 3極プラグ × 4極ジャック**
// なので (docs/SENSITIVITY.md / topology_search)、そちらも出せるようにする。
const argv = process.argv.slice(2)
const argOf = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const VARIANT = argOf('variant', 'TRS|JACK-TRS') as Parameters<typeof getModel>[0]
/** ファイル名に使える形へ。variant ごとに別ファイルにする */
const slug = String(VARIANT).toLowerCase().replace(/[^a-z0-9]+/g, '_')

// ---------------------------------------------------------------------------
// 再現可能な入力
// ---------------------------------------------------------------------------

function sourceRevision(): string {
  if (process.env.SOURCE_REVISION) return process.env.SOURCE_REVISION
  try {
    return execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'UNKNOWN'
  }
}

/** ARTIFACT_DATE で固定できる。既存 artifact と同じ規約 */
function generatedAt(): string {
  return process.env.ARTIFACT_DATE ?? new Date().toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// 音響コードの整理 (統合オーダー P1「音響コード体系の整理」の先取り)
//
// acoustic.code をそのまま渡すと、受け手が係数へ写像しかねない。
// 「電気的なトポロジー」「未検証の聴感の仮説」「電気リスク」を分けて渡す。
// ---------------------------------------------------------------------------

interface Annotation {
  topologyClass: string
  audibleHypothesis: string | null
  stabilityOverlay: string | null
  electricalRisk: 'none' | 'protection-dependent' | 'short-circuit'
  confidence: 'low' | 'medium' | 'high'
}

const ANNOTATION: Record<string, Omit<Annotation, 'stabilityOverlay'>> = {
  NORMAL: { topologyClass: 'fully-seated', audibleHypothesis: '正常', electricalRisk: 'none', confidence: 'high' },
  SILENT: { topologyClass: 'no-path', audibleHypothesis: '無音', electricalRisk: 'none', confidence: 'medium' },
  LEFT_ONLY: { topologyClass: 'one-sided', audibleHypothesis: '左のみ', electricalRisk: 'none', confidence: 'medium' },
  RIGHT_ONLY: { topologyClass: 'one-sided', audibleHypothesis: '右のみ', electricalRisk: 'none', confidence: 'medium' },
  DIFFERENCE_SIGNAL: {
    topologyClass: 'ground-open-differential',
    // 「左右の差分が残る」は電気的な帰結であって、聴感の実測ではない
    audibleHypothesis: '音量が落ち、左右の差分成分が残る',
    electricalRisk: 'none',
    confidence: 'low',
  },
  GROUND_OPEN: {
    topologyClass: 'ground-open-nondifferential',
    audibleHypothesis: 'ほぼ無音',
    electricalRisk: 'none',
    confidence: 'low',
  },
  LR_SHORTED: {
    topologyClass: 'signal-to-return-short',
    // 聴感は機器の保護動作に依存するので、断定しない
    audibleHypothesis: null,
    electricalRisk: 'short-circuit',
    confidence: 'low',
  },
  INSULATED: { topologyClass: 'on-insulator', audibleHypothesis: '断', electricalRisk: 'none', confidence: 'medium' },
  WRONG_SEGMENT: {
    topologyClass: 'wrong-conductor',
    audibleHypothesis: null,
    electricalRisk: 'protection-dependent',
    confidence: 'low',
  },
}

function annotate(code: string, unstable: boolean): Annotation {
  const base = ANNOTATION[code] ?? {
    topologyClass: `unmapped:${code}`,
    audibleHypothesis: null,
    electricalRisk: 'protection-dependent' as const,
    confidence: 'low' as const,
  }
  // 不安定性は基底トポロジーと直交する overlay として表す (オーダー P1 の方針)
  return { ...base, stabilityOverlay: unstable ? 'intermittent' : null }
}

// ---------------------------------------------------------------------------
// 区間化 — トポロジーが変わらない連続行を 1 区間へ潰す
// ---------------------------------------------------------------------------

const WEAKEST = ['FACT', 'DERIVED', 'ASSUMPTION', 'UNKNOWN'] as const
type Grade = (typeof WEAKEST)[number]
const weakest = (gs: Grade[]): Grade =>
  gs.reduce<Grade>((a, b) => (WEAKEST.indexOf(b) > WEAKEST.indexOf(a) ? b : a), 'FACT')

/** その深さでのトポロジーを、比較できる文字列にする */
function topologyKey(ev: ReturnType<TrsModel['evaluate']>): string {
  return JSON.stringify({
    c: ev.contacts.map((c) => [c.contactId, c.state, [...c.connectedNets].sort(), c.breakState]),
    t: ev.circuit.terminalToPlugNet,
    a: ev.acoustic.code,
  })
}

function buildIntervals(m: TrsModel) {
  const rows = sweep(m, { stepMm: STEP_MM }).filter((r) => r.depthMm >= 0)
  const out: Record<string, unknown>[] = []
  let runStart = rows[0]
  let runKey = ''

  const flush = (startRow: (typeof rows)[number], endMm: number, idx: number) => {
    const ev = m.evaluate(startRow.depthMm, DEFAULT_FAULTS)
    const grades = ev.contacts.map((c) => (c.grade ?? 'ASSUMPTION') as Grade)
    const shorted = ev.contacts.some((c) => c.connectedNets.length > 1)
    const signalToSignal = ev.contacts.some(
      (c) => c.connectedNets.includes('TIP') && c.connectedNets.includes('RING'),
    )
    out.push({
      intervalId: `IV${String(idx).padStart(3, '0')}`,
      nominalStartMm: +startRow.depthMm.toFixed(4),
      nominalEndMm: +endMm.toFixed(4),
      normalizedStart: +(startRow.depthMm / m.fullDepthMm).toFixed(6),
      normalizedEnd: +(endMm / m.fullDepthMm).toFixed(6),
      contacts: ev.contacts.map((c) => ({
        contactId: c.contactId,
        terminalId: c.terminalId,
        state: c.state,
        connectedNets: [...c.connectedNets].sort(),
        physicallyTouching: c.physicallyTouching,
        evidenceGrade: (c.grade ?? 'ASSUMPTION') as Grade,
      })),
      circuitEdges: ev.circuit.edges.map((e) => [e.from, e.to]).sort((x, y) => (x.join() < y.join() ? -1 : 1)),
      circuitNets: ev.circuit.nets.map((n) => [...n.nodes].sort()),
      terminalToPlugNet: ev.circuit.terminalToPlugNet,
      breakStates: Object.fromEntries(
        ev.contacts.filter((c) => c.breakContactId).map((c) => [c.breakContactId as string, c.breakState]),
      ),
      mechanicalFlags: {
        anyBridged: ev.anyBridged,
        anyWrongSegment: ev.anyWrongSegment,
        anyUnstable: ev.anyUnstable,
      },
      acousticAnnotation: annotate(ev.acoustic.code, ev.anyUnstable),
      evidenceGrade: weakest(grades),
      uncertainty: {
        // 区間境界の分解能は走査刻みそのもの。これ以上の精度を主張しない
        boundaryResolutionMm: STEP_MM,
        // UNKNOWNS §3-8: 帰線接点位置を入口ブッシング寸法と両立させると全深度が一律ずれる
        systematicShiftMm: 1.0,
        notes: [
          '区間境界は走査刻みの倍数でしか表せない。実際の切り替わりは刻みの間にある。',
          '帰線接点の軸位置 (ASSUMPTION) を入口ブッシング寸法と両立させると、全区間が一律 +1.0mm ずれる (UNKNOWNS §3-8)。',
        ],
      },
      safetyFlags: { shortsSignalToReturn: shorted, shortsSignalToSignal: signalToSignal },
    })
  }

  let idx = 0
  for (const r of rows) {
    const k = topologyKey(m.evaluate(r.depthMm, DEFAULT_FAULTS))
    if (runKey === '') {
      runKey = k
      runStart = r
      continue
    }
    if (k !== runKey) {
      flush(runStart, r.depthMm, idx++)
      runKey = k
      runStart = r
    }
  }
  flush(runStart, m.fullDepthMm, idx)
  return out
}

// ---------------------------------------------------------------------------

const UNKNOWN_PART = { id: 'UNKNOWN', label: '不明', poles: 3, manufacturerPartNumber: null }
const PARTS: Record<string, { id: string; label: string; poles: number; manufacturerPartNumber: string | null }> = {
  'TRS': { id: 'PLUG-TRS', label: 'Lumberg 1532 10', poles: 3, manufacturerPartNumber: '1532 10' },
  'TRRS-CTIA': { id: 'PLUG-TRRS-CTIA', label: '4極 CTIA プラグ (構成)', poles: 4, manufacturerPartNumber: null },
  'TRRS-OMTP': { id: 'PLUG-TRRS-OMTP', label: '4極 OMTP プラグ (構成)', poles: 4, manufacturerPartNumber: null },
  'JACK-TRS': { id: 'JACK-TRS', label: 'Lumberg 1503 09', poles: 3, manufacturerPartNumber: '1503 09' },
  'JACK-TRRS': { id: 'JACK-TRRS', label: '4極ジャック (接点位置は全て仮定)', poles: 4, manufacturerPartNumber: null },
}

const m = getModel(VARIANT)
const dims = JSON.parse(readFileSync(resolve(ROOT, 'src/data/dimensions.json'), 'utf8')).entries as Record<
  string,
  { grade: Grade }
>
const counts = { FACT: 0, DERIVED: 0, ASSUMPTION: 0, UNKNOWN: 0 }
for (const v of Object.values(dims)) counts[v.grade]++
const jackInternal = Object.keys(dims).filter(
  (k) => /^(jack\.|trrs\.jack\.)/.test(k) && dims[k].grade === 'ASSUMPTION',
).length

// 感度解析は別コマンド (15 分) なので、無ければ available:false で出す
let sens: Record<string, unknown> = {
  available: false,
  bridgeDepthJointRangeMm: null,
  tipBridgeComplianceThreshold: null,
  tipBridgeWorstCornerThreshold: null,
  notes: ['artifacts/sensitivity.json が無い。npm run sensitivity で生成する'],
}
let eventSpread: Record<string, { minMm: number; maxMm: number }> = {}
try {
  const s = JSON.parse(readFileSync(resolve(ROOT, 'artifacts/sensitivity.json'), 'utf8'))
  eventSpread = s.eventSpread?.byKind ?? {}
  sens = {
    available: true,
    bridgeDepthJointRangeMm: [s.bridgeDepthRange.joint.minMm, s.bridgeDepthRange.joint.maxMm],
    tipBridgeComplianceThreshold: s.tipBridge.complianceThreshold,
    tipBridgeWorstCornerThreshold: s.tipBridge.toleranceBox.worstCorner.tipThreshold,
    notes: [
      'これはモデル内部の感度であって、実物のばらつきではない。',
      'spreadMm が null の事象は「測っていない」であって「動かない」ではない。',
    ],
  }
} catch {
  /* 無ければ available:false のまま */
}

const intervals = buildIntervals(m)
const events = extractEvents(m, sweep(m, { stepMm: STEP_MM })).map((e) => {
  const sp = eventSpread[e.kind]
  return {
    kind: e.kind,
    depthMm: +e.depthMm.toFixed(4),
    normalized: +(e.depthMm / m.fullDepthMm).toFixed(6),
    label: e.label,
    spreadMm: sp
      ? {
          minMm: sp.minMm,
          maxMm: sp.maxMm,
          sweptParameters: ['jack.contact.sleeve.axialCenter', 'jack.contact.sleeve.padWidth'],
        }
      : null,
  }
})

const profile = {
  schemaVersion: 1 as const,
  profileId: `trs-jack-3d:${VARIANT}:${sourceRevision().slice(0, 12)}`,
  variantId: VARIANT,
  plug: PARTS[String(VARIANT).split('|')[0]] ?? UNKNOWN_PART,
  jack: PARTS[String(VARIANT).split('|')[1]] ?? UNKNOWN_PART,
  plugBasis: {
    source: 'メーカー公開データシートの図面 (07/2025 改訂) と、その図面実測',
    evidenceGrade: 'DERIVED' as const,
    note: '外形は図面どおり。導体境界は記載寸法からの演算。絶縁帯の縮径のみ図面実測 (φ3.20〜3.22)。',
  },
  jackBasis: String(VARIANT).endsWith('JACK-TRRS')
    ? {
        source: '一次資料なし',
        evidenceGrade: 'ASSUMPTION' as const,
        note:
          '**4極ジャックは接点位置を含めて全て仮定である。** 図面もデータシートも入手できていない。' +
          'この profile の深さの数字は、仮定した接点位置の帰結でしかない。',
      }
    : {
        source: 'メーカー公開データシートの外形・基板レイアウト・回路記号',
        evidenceGrade: 'ASSUMPTION' as const,
        note: '外形は図面どおりだが、内部の接点ばね寸法は一次資料に無く、全て仮定である。',
      },
  sourceRevision: sourceRevision(),
  generatedAt: generatedAt(),
  fullInsertionDepthMm: m.fullDepthMm,
  stepMm: STEP_MM,
  coordinateSystem: {
    depthOrigin: 'ジャック前面基準面 (ローレットナット前面)。プラグ先端がここにあるとき depth = 0',
    depthDirection: '正が挿入方向',
    normalized: 'depthMm / fullInsertionDepthMm。0 = 先端が前面、1 = 完全挿入',
  },
  dataLicense: {
    code: 'MIT',
    data: 'CC BY 4.0',
    attribution: 'trs-jack-3d (https://github.com/Driedsandwich/trs-jack-3d) — CC BY 4.0',
  },
  modelLimitations: {
    // 実測していないので false 以外にできない
    verifiedPhysical: false,
    physicalVerificationRef: null,
    notes: [
      '実物と突き合わせた検証をしていない。ジャック内部の接点寸法は全て仮定である。',
      'この profile は Lumberg 1532 10 × 1503 09 の 1 組についてのものであり、3.5mm ジャック全般を代表しない。',
      'acousticAnnotation は参考分類であって DSP 係数ではない。フィルタ係数・ゲイン・クロストーク量へ直接変換してはならない。',
      'quality を接触抵抗 Ω へ換算してはならない。相対スコアであって物理量ではない。',
      'nominalStartMm は 1 機種の実寸であり、一般的な「挿入深度」ではない。機種横断では normalized を使うこと。',
    ],
  },
  assumptionSummary: { counts, jackInternalAssumptions: jackInternal },
  // 統合オーダー §3 P0: 既定モデルに GROUND_OPEN が無いなら、それを明示的に出力する。
  // Half-Plug 側の中核候補なので、「無い」ことこそ渡すべき情報である。
  absentTopologies: (() => {
    const searched = ['fully-seated', 'no-path', 'one-sided', 'signal-to-return-short', 'on-insulator', 'wrong-conductor', 'ground-open-differential', 'ground-open-nondifferential']
    const present = new Set(intervals.map((i) => (i.acousticAnnotation as Annotation).topologyClass))
    return {
      searched,
      absent: searched.filter((t) => !present.has(t)),
      note: 'absent に ground-open が入っている場合、この既定モデルでは共通帰線断が一度も起きない。表示上だけ足してはならない。',
    }
  })(),
  intervals,
  events,
  sensitivitySummary: sens,
}

const OUT = resolve(ROOT, 'artifacts')
mkdirSync(OUT, { recursive: true })
writeFileSync(resolve(OUT, `half_plug_topology_profile.v1.${slug}.json`), JSON.stringify(profile, null, 1) + '\n')

const codes = new Set(intervals.map((i) => (i.acousticAnnotation as Annotation).topologyClass))
console.log(`\n  ${VARIANT}`)
console.log(`  区間 ${intervals.length} / イベント ${events.length}`)
console.log(`  現れたトポロジー: ${[...codes].sort().join(', ')}`)
console.log(`  共通帰線断: ${[...codes].some((c) => /ground-open/.test(c)) ? '存在する' : '**この既定モデルには存在しない**'}`)
console.log(`  sourceRevision: ${profile.sourceRevision} / generatedAt: ${profile.generatedAt}`)
console.log(`  artifacts/half_plug_topology_profile.v1.${slug}.json を書き出した`)
