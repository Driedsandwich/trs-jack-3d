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
  'JACK-TRRS': { id: 'JACK-TRRS', label: '4極ジャック (端子系 Lumberg 1503 28 / 接点位置は仮定)', poles: 4, manufacturerPartNumber: null },
}

const m = getModel(VARIANT)
const dims = JSON.parse(readFileSync(resolve(ROOT, 'src/data/dimensions.json'), 'utf8')).entries as Record<
  string,
  { grade: Grade }
>

/**
 * ジャックの根拠を、**台帳から組み立てる**。
 *
 * 統合オーダー 2026-08-03 P0-2: ここは 2026-08-02 まで variant ごとの文字列を直書きしていた。
 * その後 4極ジャックを Lumberg 1503 28 ベースへ組み直したのに、**この文字列だけが取り残され**、
 * 公開済み artifact に「一次資料なし」「接点位置を含めて全て仮定」が残った。
 * 直書きをやめて grade から生成すれば、台帳を直した時点で自動的に追随する。
 *
 * 分けて書くもの (オーダーの推奨構造):
 *   端子の軸位置        … FACT      (基板レイアウト図の記載値)
 *   端子番号と機能の対応 … DERIVED   (ばね 3 本の位置から順列が 1 通りしか成立しない)
 *   ブレーク接点        … FACT      (回路記号に 2 個記載)
 *   接点の軸位置        … ASSUMPTION (**ここだけが残った仮定**)
 */
function gradeOf(...keys: string[]): Grade | null {
  const gs = keys.map((k) => dims[k]?.grade).filter(Boolean) as Grade[]
  return gs.length === keys.length ? weakest(gs) : null
}

function jackBasis() {
  if (!String(VARIANT).endsWith('JACK-TRRS'))
    return {
      source: 'メーカー公開データシートの外形・基板レイアウト・回路記号 (Lumberg 1503 09)',
      evidenceGrade: 'ASSUMPTION' as const,
      note: '外形は図面どおりだが、内部の接点ばね寸法は一次資料に無く、仮定である。',
      detail: {
        partIdentityBasis: 'Lumberg 1503 09 (実在の単一品)',
        externalGeometryBasis: 'FACT — データシート外形図',
        terminalLayoutBasis: 'FACT — 基板レイアウト図',
        breakContactBasis: 'FACT — 回路記号',
        internalContactGeometryBasis: 'ASSUMPTION — 接点ばねの寸法は公開資料に無い',
        electricalContinuityValidation: '未実施',
        acousticValidation: '未実施',
        constructedProfile: false,
        constructedFrom: [],
      },
    }
  const terminal = gradeOf(...[1, 2, 3, 4, 5, 6].map((i) => `trrs.jack.terminal.p${i}.axialCenter`))
  const contact = gradeOf(...['tip', 'ring1', 'ring2', 'sleeve'].map((c) => `trrs.jack.contact.${c}.axialCenter`))
  return {
    // **かつての「一次資料なし」「全て仮定」は誤りになった。** 端子系は 1503 28 の図面から採っている。
    // 資料が無いのは接点の軸方向オフセットだけなので、そう書く (包括的な断りに戻さない)
    source: 'Lumberg 1503 28 の基板レイアウト図・回路記号 (端子系)。接点の軸方向オフセットだけ資料が無い',
    evidenceGrade: (contact ?? 'ASSUMPTION') as Grade,
    note:
      `端子 6 本の軸位置は図面記載 (${terminal ?? '不明'})。ブレーク接点 2 個も回路記号どおり。`
      + `**残る仮定は接点が端子より何 mm 手前にあるか (beamOffset) だけである (${contact ?? '不明'})。**`
      + 'この profile の深さの数字は、その 1 つの仮定に乗っている。'
      + 'なお PS000001 の断面図 (Tip 12.75) を入れると左右差分の区間は消える。実在資料 2 件は逆を指している。',
    detail: {
      // 実在の単一品と誤認させない。3極プラグ × 4極ジャックの混挿は構成 profile である
      partIdentityBasis: '構成 profile。実在の単一品ではない',
      externalGeometryBasis: 'ASSUMPTION — 外形は 3極 1503 09 の値を流用している (1503 28 の外形図は未入手)',
      terminalLayoutBasis: `${terminal ?? 'UNKNOWN'} — Lumberg 1503 28 基板レイアウト図`,
      breakContactBasis: 'FACT — Lumberg 1503 28 回路記号に 2 個記載',
      internalContactGeometryBasis: `${contact ?? 'UNKNOWN'} — 端子位置に拘束された仮定`,
      electricalContinuityValidation: '未実施',
      acousticValidation: '未実施',
      constructedProfile: true,
      constructedFrom: [
        `プラグ: ${PARTS[String(VARIANT).split('|')[0]]?.label ?? '不明'}`,
        'ジャックの端子系: Lumberg 1503 28',
        'ジャックの外形: Lumberg 1503 09 からの流用',
      ],
    },
  }
}
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
    // kind 単位の集計は**ここに置く**。事象へは配らない (統合オーダー P0-3)
    aggregateSpreadByKind: s.eventSpread?.byKind ?? null,
    notes: [
      'これはモデル内部の感度であって、実物のばらつきではない。',
      'spreadMm が null の事象は「測っていない」であって「動かない」ではない。',
      'aggregateSpreadByKind は kind 単位の集計である。'
        + 'STATE_CHANGE は 1 回の挿入で複数回起きるので、この幅を個々の事象へ当てはめてはならない。'
        + '2026-08-03 まで当てはめており、Ring のブレーク接点に帰線接点用の幅が付いていた。',
    ],
  }
} catch {
  /* 無ければ available:false のまま */
}

const intervals = buildIntervals(m)
const rawEvents = extractEvents(m, sweep(m, { stepMm: STEP_MM }))

/**
 * 感度解析が振った寸法。artifact の note に書かれている 2 本。
 * ここを直したら sensitivity.ts の `SWEPT_FOR_EVENT_SPREAD` も直す (同じ定数を 2 か所に置かない)。
 */
const SWEPT_FOR_EVENT_SPREAD = ['jack.contact.sleeve.axialCenter', 'jack.contact.sleeve.padWidth']

/**
 * その kind が 1 回しか出ないか。**幅を事象へ配れるのはここが true のときだけ。**
 *
 * 統合オーダー P0-3: 2026-08-03 まで `eventSpread.byKind[e.kind]` を全事象へ配っていた。
 * STATE_CHANGE は 1 回の挿入で 29 件出るので、**29 件すべてに同じ −0.88〜14mm が付いた**。
 * Ring のブレーク接点にも帰線接点用の幅が付き、受け手には誤情報になる。
 * kind 単位しか無い集計は profile 直下の aggregateSpreadByKind へ移し、事象へは配らない。
 */
const kindCount = new Map<string, number>()
for (const e of rawEvents) kindCount.set(e.kind, (kindCount.get(e.kind) ?? 0) + 1)

/**
 * 文言を変えても変わらない識別子。**label からは作らない。**
 *
 * 末尾の連番は、同じ遷移が挿入中に複数回起きるため要る。
 * (帰線接点は絶縁帯を 2 本またぐので OPEN→INSULATED が 2 回起きる。
 *  最初 `kind:subject:from->to` だけで作って重複検査に落ちた。検査を入れていなければ
 *  「一意な ID」を名乗ったまま 7 件が衝突していた。)
 *
 * **この連番は位置に依存する。** 手前に事象が増えると後ろがずれる。
 * profile v1 の intervalId と同じ性質で、ID の組は profileId とセットで保存する
 * (docs/HALF_PLUG_ADAPTER.md)。事象列が変われば profileId が変わるので検出できる。
 */
const idSeen = new Map<string, number>()
const eventIdOf = (e: (typeof rawEvents)[number]) => {
  const base = e.subject
    ? `${e.kind}:${e.subject.subjectId}:${e.subject.fromState}->${e.subject.toState}`
    : e.kind
  const n = (idSeen.get(base) ?? 0) + 1
  idSeen.set(base, n)
  return n === 1 && !e.subject ? base : `${base}#${n}`
}

const events = rawEvents.map((e) => {
  const sp = eventSpread[e.kind]
  const eventSpecific = sp !== undefined && kindCount.get(e.kind) === 1
  return {
    eventId: eventIdOf(e),
    kind: e.kind,
    eventIdentity: e.subject ?? null,
    depthMm: +e.depthMm.toFixed(4),
    normalized: +(e.depthMm / m.fullDepthMm).toFixed(6),
    label: e.label,
    spreadMm: eventSpecific ? { minMm: sp.minMm, maxMm: sp.maxMm, sweptParameters: SWEPT_FOR_EVENT_SPREAD } : null,
    // null の理由を分ける。「動かない」ではない
    spreadStatus: eventSpecific
      ? 'MEASURED'
      : sp === undefined
        ? 'NOT_MEASURED'
        : 'NOT_EVENT_SPECIFIC',
  }
})

// eventId は決定的で、同じ入力からは同じ値になる。重複が出たら識別子として使えない
const dupIds = [...new Map<string, number>(
  events.map((e) => [e.eventId, events.filter((x) => x.eventId === e.eventId).length]),
)].filter(([, n]) => n > 1)
if (dupIds.length)
  throw new Error(`eventId が重複している: ${dupIds.map(([id, n]) => `${id} ×${n}`).join(', ')}`)

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
  jackBasis: jackBasis(),
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
      '実物と突き合わせた検証をしていない。ジャック内部の接点ばね寸法は仮定である。',
      // **variant ごとに書き分ける。** 2026-08-03 まで全 variant へ 1532 10 × 1503 09 と書いていた
      // (統合オーダー P0-2)。組み合わせは PARTS の実データから作る
      `この profile は ${PARTS[String(VARIANT).split('|')[0]]?.label ?? '不明'} × `
        + `${PARTS[String(VARIANT).split('|')[1]]?.label ?? '不明'} の 1 組についてのものであり、`
        + '3.5mm ジャック全般を代表しない。',
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
