/**
 * Half-Plug Topology Profile v3 の書き出し。
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

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { getModel } from '../src/data'
import { DEFAULT_FAULTS } from '../src/model/contact'
import { extractEvents, sweep } from '../src/model/sweep'
import type { TrsModel } from '../src/model/engine'
import { ALL_TOPOLOGY_CLASSES, classifyFromEvaluation } from '../src/model/topology'
import { buildProvenance } from './provenance'
import { migrationFor } from './contractMigration.mjs'
import { evaluateGate, predictionsFromEvents, GATE_DOCUMENT, LEDGER_PATH } from './measurementGate.mjs'

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
const hasFlag = (name: string) => argv.includes(`--${name}`)
const VARIANT = argOf('variant', 'TRS|JACK-TRS') as Parameters<typeof getModel>[0]
/** ファイル名に使える形へ。variant ごとに別ファイルにする */
const slug = String(VARIANT).toLowerCase().replace(/[^a-z0-9]+/g, '_')

// ---------------------------------------------------------------------------
// 再現可能な入力 (統合オーダー P0-1)
// ---------------------------------------------------------------------------

/** ARTIFACT_DATE で固定できる。既存 artifact と同じ規約 */
function generatedAt(): string {
  return process.env.ARTIFACT_DATE ?? new Date().toISOString().slice(0, 10)
}

/**
 * **`SOURCE_REVISION` の素通しは廃止した。**
 *
 * 2026-08-03 まで、環境変数があれば無条件でそれを `sourceRevision` に書いていた。
 * 古い値を渡したまま「その改訂から作った」と名乗れてしまう。
 * 実際の HEAD と食い違っていて `--unsafe-revision-override` も無ければ、止める。
 */
const provenance = buildProvenance({
  root: ROOT,
  // **この variant の感度 artifact だけを入力にする (P1-2)。**
  // 別 variant の感度を測り直しても、この profile の ID は変わらない
  variantSlug: slug,
  // process.argv をそのまま書かない。呼び出し方 (export:half-plug:all 経由か直接か) で
  // 変わってしまい、byte-identical でなくなる。正規化した形を記録する
  command: `npm run export:half-plug -- --variant "${VARIANT}"${hasFlag('release') ? ' --release' : ''}`,
  artifactDate: generatedAt(),
  release: hasFlag('release'),
  allowRevisionOverride: hasFlag('unsafe-revision-override'),
  envRevision: process.env.SOURCE_REVISION,
})

/** 後方互換のために残す。意味は「生成元 source commit」（一致は要求しない） */
const sourceRevision = () => provenance.generatedFromCommit

// ---------------------------------------------------------------------------
// 音響コードの整理 (統合オーダー P1「音響コード体系の整理」の先取り)
//
// acoustic.code をそのまま渡すと、受け手が係数へ写像しかねない。
// 「電気的なトポロジー」「未検証の聴感の仮説」「電気リスク」を分けて渡す。
// ---------------------------------------------------------------------------

/**
 * **`topologyClass` はここに無い。** 統合オーダー P0-4 で
 * 「electrical topology と audible hypothesis を別層にする」と定められたため、
 * 分類は `electricalTopology`（`src/model/topology.ts` が正本）が持つ。
 * ここに残るのは「どう聞こえるか」の仮説だけである。
 */
interface Annotation {
  audibleHypothesis: string | null
  stabilityOverlay: string | null
  electricalRisk: 'none' | 'protection-dependent' | 'short-circuit'
  confidence: 'low' | 'medium' | 'high'
}

const ANNOTATION: Record<string, Omit<Annotation, 'stabilityOverlay'>> = {
  NORMAL: { audibleHypothesis: '正常', electricalRisk: 'none', confidence: 'high' },
  SILENT: { audibleHypothesis: '無音', electricalRisk: 'none', confidence: 'medium' },
  LEFT_ONLY: { audibleHypothesis: '左のみ', electricalRisk: 'none', confidence: 'medium' },
  RIGHT_ONLY: { audibleHypothesis: '右のみ', electricalRisk: 'none', confidence: 'medium' },
  DIFFERENCE_SIGNAL: {
    // 「左右の差分が残る」は電気的な帰結であって、聴感の実測ではない
    audibleHypothesis: '音量が落ち、左右の差分成分が残る',
    electricalRisk: 'none',
    confidence: 'low',
  },
  GROUND_OPEN: {
    audibleHypothesis: 'ほぼ無音',
    electricalRisk: 'none',
    confidence: 'low',
  },
  LR_SHORTED: {
    // 聴感は機器の保護動作に依存するので、断定しない
    audibleHypothesis: null,
    electricalRisk: 'short-circuit',
    confidence: 'low',
  },
  INSULATED: { audibleHypothesis: '断', electricalRisk: 'none', confidence: 'medium' },
  WRONG_SEGMENT: {
    audibleHypothesis: null,
    electricalRisk: 'protection-dependent',
    confidence: 'low',
  },
}

function annotate(code: string, unstable: boolean): Annotation {
  const base = ANNOTATION[code] ?? {
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
    // **safetyFlags を導体名から作らない (統合オーダー P0-4)。**
    // 2026-08-03 まで shortsSignalToSignal を `TIP と RING に同時接触` で判定していた。
    // 導体名は位置であって機能ではない。OMTP では Ring2 と Sleeve の機能が入れ替わるので、
    // 同じ導体名でも意味が変わる。shorted も「どれかの接点が 2 本に触れている」＝橋絡であって、
    // 帰線への短絡ではなかった。分類器の出力へ差し替える。
    const cls = classifyFromEvaluation(m.jack.terminals, m.plug.netFunctions, ev)
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
      // 電気的な事実。**分類の正本は src/model/topology.ts。**
      electricalTopology: {
        topologyClass: cls.topologyClass,
        reasonCode: cls.reasonCode,
        openSignals: cls.openSignals,
        confidenceBoundary: cls.confidenceBoundary,
      },
      // 聴感の仮説。**別層。** ここに分類は入らない
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
      safetyFlags: { shortsSignalToReturn: cls.shortsSignalToReturn, shortsSignalToSignal: cls.shortsSignalToSignal },
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

/**
 * **variant 固有の感度だけを読む。fail-closed (統合フォローアップ P0-2)。**
 *
 * 2026-08-03 まで、variant を問わず単一の `artifacts/sensitivity.json` を読み、
 * その `eventSpread.byKind` をどの profile へも配っていた。
 * `sensitivity.ts` は解析基準を `TRS|JACK-TRS` に固定しているので、
 * **TRS×TRRS profile に 3極の幅が付いていた。**
 * FIRST_BREAK_OPEN は名目 8.48mm なのに幅 8.06〜8.06mm という、
 * 名目値が自分の幅の外にある状態だった (Half-Plug 側の fixture import で発覚)。
 *
 * いまは `artifacts/sensitivity.<slug>.json` を読み、**variantId が一致しなければ捨てる。**
 * 迷ったら出さない。誤った幅を配るより、幅が無いほうが害が小さい。
 */
let eventSpread: Record<string, { minMm: number; maxMm: number }> = {}
let spreadSource: Record<string, unknown> | null = null
let spreadRejectedBecause: string | null = null
const SPREAD_FILE = `artifacts/sensitivity.${slug}.json`
try {
  const ev = JSON.parse(readFileSync(resolve(ROOT, SPREAD_FILE), 'utf8'))
  if (ev.variantId !== String(VARIANT))
    throw new Error(`variantId が ${ev.variantId} で、この profile の ${VARIANT} と違う`)
  if (!ev.byKind || !Object.keys(ev.byKind).length) throw new Error('byKind が空')
  eventSpread = ev.byKind
  spreadSource = {
    file: SPREAD_FILE,
    variantId: ev.variantId,
    analysisScope: ev.analysisScope ?? null,
    basis: ev.basis ?? null,
    sweptParameters: ev.sweptParameters ?? null,
    generatedFromCommit: ev.generatedFromCommit ?? null,
    /**
     * **感度 artifact 側の入力指紋**（非阻害オーダー P1-1）。
     * `generatedFromCommit` は参考値でしかない（release commit より前を指す）。
     * 感度解析を回し直したかどうかは、commit ではなくこちらで見る。
     */
    inputDigest: ev.provenance?.inputDigest ?? null,
    configurationsUsable: ev.sweep?.configurationsUsable ?? null,
    shippedInsideSweptRange: ev.sweep?.shippedInsideSweptRange ?? null,
  }
} catch (e) {
  spreadRejectedBecause = `${SPREAD_FILE} を使えない: ${(e as Error).message}`
}

/**
 * 3極の総合解析 (`artifacts/sensitivity.json`)。**3極 variant のときだけ使う。**
 * プラトー間隔・Tip 橋絡しきい値・挿抜力はいずれも 3極の幾何に結びついており、
 * 他の variant へ持ち出すと、まさに今回直した誤りをもう一度作ることになる。
 */
/**
 * **`available` は 2 つの別々の事実を 1 つの真偽値に潰していた**（非阻害オーダー P1-3）。
 *
 * TRS×TRRS は `available: false` でありながら event-specific spread を 7 件持っていた。
 * 受け手からは「感度情報が一切無い」と読めてしまう。実際に読み違えられた。
 *
 * 分ける。`available` は互換のため残すが、**意味は global summary の有無だけ**である。
 */
const eventSpreadAvailable = spreadSource !== null
let sens: Record<string, unknown> = {
  available: false,
  globalSummaryAvailable: false,
  eventSpreadAvailable,
  basis: eventSpreadAvailable ? 'MODEL_PARAMETER_SWEEP' : null,
  bridgeDepthJointRangeMm: null,
  tipBridgeComplianceThreshold: null,
  tipBridgeWorstCornerThreshold: null,
  aggregateSpreadByKind: null,
  eventSpreadSource: spreadSource,
  notes: [
    spreadRejectedBecause ?? 'この variant 固有の総合感度解析はまだ無い。',
    eventSpreadAvailable
      ? 'variant 固有の global summary は出していない。'
        + 'event-specific な model-sweep spread は eventSpreadSource から提供している。'
        + '**「感度情報が無い」ではない。**'
      : '**variant 固有の解析が無いので、感度情報は出していない (fail-closed)。**'
        + '別 variant の値を流用するより、無いほうが害が小さい。',
  ],
}
try {
  if (String(VARIANT) !== 'TRS|JACK-TRS') throw new Error('3極以外では総合解析を使わない')
  const s = JSON.parse(readFileSync(resolve(ROOT, 'artifacts/sensitivity.json'), 'utf8'))
  sens = {
    available: true,
    globalSummaryAvailable: true,
    eventSpreadAvailable,
    basis: 'MODEL_PARAMETER_SWEEP',
    bridgeDepthJointRangeMm: [s.bridgeDepthRange.joint.minMm, s.bridgeDepthRange.joint.maxMm],
    tipBridgeComplianceThreshold: s.tipBridge.complianceThreshold,
    tipBridgeWorstCornerThreshold: s.tipBridge.toleranceBox.worstCorner.tipThreshold,
    // kind 単位の集計は**ここに置く**。事象へは配らない (統合オーダー P0-3)
    aggregateSpreadByKind: eventSpread,
    eventSpreadSource: spreadSource,
    notes: [
      'これはモデル内部の感度であって、実物のばらつきでも製造公差でもない。',
      'spreadMm が null の事象は「測っていない」であって「動かない」ではない。',
      'aggregateSpreadByKind は kind 単位の集計である。'
        + 'STATE_CHANGE は 1 回の挿入で複数回起きるので、この幅を個々の事象へ当てはめてはならない。',
      'bridgeDepthJointRangeMm / tipBridge* は 3極 (TRS|JACK-TRS) の解析である。'
        + '他の variant では出力しない。',
    ],
  }
} catch {
  /* fail-closed のまま */
}

const intervals = buildIntervals(m)
const rawEvents = extractEvents(m, sweep(m, { stepMm: STEP_MM }))

/**
 * 感度解析が振った寸法。**artifact の記録から取る。**
 * 2026-08-03 まで 3極のキーを直書きしており、4極 profile にも 3極のキーが載っていた。
 * 直書きは、値が別 variant のものでも気付けない (今回の流入がまさにそれ)。
 */
const sweptForSpread = (spreadSource?.sweptParameters as string[] | null) ?? []

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
    spreadMm: eventSpecific ? { minMm: sp.minMm, maxMm: sp.maxMm, sweptParameters: sweptForSpread } : null,
    /**
     * null の理由を分ける。**「動かない」ではない。**
     *
     * 2026-08-03 に MEASURED という語をやめた。**実物測定と誤認される。**
     * これはモデルのパラメータを振った結果であって、測定ではない
     * (統合フォローアップ P1 の指摘。schema v2 送りにせず今回入れた)。
     */
    spreadStatus: eventSpecific
      ? 'MODEL_SWEEP_EVENT_SPECIFIC'
      : sp === undefined
        ? 'NOT_ANALYZED'
        : 'MODEL_SWEEP_NOT_EVENT_SPECIFIC',
  }
})

// ---------------------------------------------------------------------------
// verifiedPhysical — **条文（docs/VERIFIED_PHYSICAL_GATE.md）に従って記録から決める**
//
// 2026-08-06 まで、ここはリテラル `false` だった。schema の説明は
// 「true にできるのは実測記録が伴う場合のみ」だけで、**何を何点測れば足りるのかが無かった**。
// つまり「誰かが書き換えたら true」で、検証ではなかった。
// ---------------------------------------------------------------------------

const ledgerRaw = (() => {
  try {
    return readFileSync(resolve(ROOT, LEDGER_PATH), 'utf8')
  } catch {
    // **台帳が無いのは異常。**黙って「記録 0 件」にすると、
    // ファイルを消しただけで「条文どおり false」に見えてしまう
    throw new Error(
      `実測記録の台帳 ${LEDGER_PATH} が読めない。\n`
      + `  ${GATE_DOCUMENT} の条文はこの台帳を正本にしている。空でも置いておくこと。`,
    )
  }
})()
const ledger = JSON.parse(ledgerRaw) as { records?: unknown[] }

/**
 * **`TRS|JACK-TRRS` の必須観測点は、4極プラグ（`TRRS-CTIA|JACK-TRRS`）の量である。**
 * 3極プラグを挿したこの profile の event 列には現れないので、別に評価して渡す。
 * ここを渡さないと、その観測点は永久に満たせない（fail closed）。
 */
function predictLShoulderGap(): number | undefined {
  const [, jackId] = String(VARIANT).split('|')
  if (jackId !== 'JACK-TRRS') return undefined
  const four = getModel('TRRS-CTIA|JACK-TRRS')
  const rows = sweep(four, { stepMm: STEP_MM, faults: DEFAULT_FAULTS })
  for (const row of rows) {
    const c = row.contacts.find((x) => x.contactId === 'JC_TIP')
    if (c && c.connectedNets.includes('TIP')) return +(four.fullDepthMm - row.depthMm).toFixed(4)
  }
  return undefined
}

const gatePredictions: Record<string, number> = {
  ...predictionsFromEvents(events, m.fullDepthMm),
}
const lGap = predictLShoulderGap()
if (typeof lGap === 'number') gatePredictions.L_FIRST_CONTACT_SHOULDER_GAP_MM = lGap

/**
 * **判定に使った予測を artifact 自身へ記録する（v0.6.3・外部監査 P0-4）。**
 *
 * v0.6.2 はここで `artifacts/real_jack_comparison.json` を直接読み、
 * その値と自分の計算値を突き合わせていた。**その読み込みが宣言されていなかった**ので、
 * 同ファイルを変えても `inputDigest` も `profileId` も動かなかった（実測）。
 * しかもそのファイルは release asset ではないので、**受け手の手元には無い。**
 *
 * 代わりに、**使った予測をここへ書き出す。**profile の中に入るので、
 * 書き換えれば `profileId` も asset の sha256 も動く。
 * 受け手は配布物だけで判定をやり直せる（→ `predictionsForValidation`）。
 */
const predictedRecord = Object.entries(gatePredictions)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([k, v]) => `${k}:${+v.toFixed(4)}`)
  .join(',') || '-'

const gate = evaluateGate({ ledger, profileVariantId: String(VARIANT), predictions: gatePredictions })

/**
 * **判定の根拠を artifact 自身へ残す。**台帳を書き換えて profile を作り直さなければ
 * `validate:profiles` の semantic 規則 `measurementRecords` が落ちる。
 *
 * **文字列で持つ。**schema の `physicalVerificationRef` は `["string","null"]` なので、
 * 構造を足すと言語が広がって **profile v4（BUMP）**になり、下流が止まる
 * （→ docs/SCHEMA_VERSIONING_POLICY.md）。**この commit で版は上げない。**
 * 形式は `docs/VERIFIED_PHYSICAL_GATE.md` 第6条。区切りは空白 1 個で固定する。
 */
const gateRef = [
  `${LEDGER_PATH}@sha256:${createHash('sha256').update(ledgerRaw).digest('hex').slice(0, 12)}`,
  `gate=${GATE_DOCUMENT}@v${gate.gateVersion}`,
  // **何を主張しているか**を機械可読で置く（条文 v2 第9条）。
  // これが無いと verifiedPhysical=true が「接点トポロジーを実物で確かめた」と読まれる
  // （この行に `verifiedPhysical:` と `true` を続けて書かないこと。
  //  test/halfPlugProfile.test.ts §7 が「true にできる経路がコードに無い」を文字列で見ている）
  `scope=${gate.claimScope}`,
  `verdict=${gate.verdict}`,
  `records=${Array.isArray(ledger.records) ? ledger.records.length : 0}`,
  `required=${gate.required.join(',') || '-'}`,
  `satisfied=${gate.satisfied.map((x) => x.observation).join(',') || '-'}`,
  `missing=${gate.missing.join(',') || '-'}`,
  // 一致と矛盾が併存している観測点。**missing とは別**（記録はあるが決まらない）
  `ambiguous=${gate.ambiguous.join(',') || '-'}`,
  `conflicting=${gate.conflicting.length}`,
  `notCertified=${gate.notCertified.length}`,
  `retracted=${gate.retracted.length}`,
  `dupIds=${gate.duplicateRecordIds.length}`,
  `decidedBy=${gate.decidedBy.join(',') || '-'}`,
  // **判定に使った予測**（v0.6.3）。受け手が配布物だけで判定をやり直すために要る
  `predicted=${predictedRecord}`,
  `rejected=${gate.rejected.length}`,
].join(' ')

// eventId は決定的で、同じ入力からは同じ値になる。重複が出たら識別子として使えない
const dupIds = [...new Map<string, number>(
  events.map((e) => [e.eventId, events.filter((x) => x.eventId === e.eventId).length]),
)].filter(([, n]) => n > 1)
if (dupIds.length)
  throw new Error(`eventId が重複している: ${dupIds.map(([id, n]) => `${id} ×${n}`).join(', ')}`)

/** 電気的に全機能が揃う最初の深さ。無ければ null（その variant では揃わない） */
const allFunctionsFromMm: number | null =
  (intervals as { electricalTopology?: { topologyClass?: string }; nominalStartMm: number }[])
    .find((x) => x.electricalTopology?.topologyClass === 'all-expected-functions-match')?.nominalStartMm ?? null

/**
 * **v1 → v2 の移行表（非阻害オーダー P1-5）。**
 *
 * ## なぜ schemaVersion を上げるのか
 *
 * v0.1.0 → v0.1.1 で `spreadStatus` の enum を非互換に変えたのに `schemaVersion` は 1 のままだった。
 * その結果、下流の adapter は `spreadStatus !== 'MEASURED'` で全 event を弾き、
 * **エラーも警告も出さずに汚染検出が丸ごと素通り**した。沈黙は最悪の壊れ方である。
 *
 * ## 選び方は実測で決めた
 *
 * 下流 (`half-plug-emulator` の `release-verifier.mjs`) が実際に何を見るかを確かめた。
 *
 *   - `schemaVersion` を 2 にする  → `Unsupported profile schemaVersion: 2` で**停止する**
 *   - `contractRevision` を足すだけ → **どこも読まないので PASS する**
 *
 * 沈黙を避けるという目的に対して、答えは 1 つしかなかった。
 */
const CONTRACT_MIGRATION = migrationFor('half-plug-topology-profile.v3')

const profile = {
  schemaVersion: 3 as const,
  schemaId: 'half-plug-topology-profile.v3',
  contractMigration: CONTRACT_MIGRATION,
  /**
   * **revision ではなく inputDigest で作る (2026-08-03 変更)。**
   *
   * 旧: `trs-jack-3d:<variant>:<revision 12桁>`
   * 新: `trs-jack-3d:<variant>:<inputDigest 12桁>`
   *
   * revision を使うと、**artifact を含めてコミットするたびに ID が変わる**。
   * 中身は同じなのに「別の profile」に見えるので、受け手が引き直しを繰り返す。
   * 逆に、寸法を直しても commit していなければ ID が変わらない。どちらも誤りだった。
   * inputDigest は「何から作ったか」なので、変わるべきときにだけ変わる。
   */
  profileId: `trs-jack-3d:${VARIANT}:${provenance.inputDigest.slice(0, 12)}`,
  variantId: VARIANT,
  plug: PARTS[String(VARIANT).split('|')[0]] ?? UNKNOWN_PART,
  jack: PARTS[String(VARIANT).split('|')[1]] ?? UNKNOWN_PART,
  plugBasis: {
    source: 'メーカー公開データシートの図面 (07/2025 改訂) と、その図面実測',
    evidenceGrade: 'DERIVED' as const,
    note: '外形は図面どおり。導体境界は記載寸法からの演算。絶縁帯の縮径のみ図面実測 (φ3.20〜3.22)。',
  },
  jackBasis: jackBasis(),
  // 残すが、意味を「生成元 source commit」と定義し直した。**一致の要求はしない。**
  // 固定に使うのは provenance.inputDigest のほう
  sourceRevision: sourceRevision(),
  generatedAt: generatedAt(),
  provenance,
  fullInsertionDepthMm: m.fullDepthMm,
  stepMm: STEP_MM,
  coordinateSystem: {
    depthOrigin: 'ジャック前面基準面 (ローレットナット前面)。プラグ先端がここにあるとき depth = 0',
    depthDirection: '正が挿入方向',
    normalized: 'depthMm / fullInsertionDepthMm。0 = 先端が前面、1 = 完全挿入',
    /**
     * **normalized の射程を機械可読にする（非阻害オーダー P2-6.2）。**
     *
     * 同じ 0.95 が別 profile で同じ電気状態を意味する保証はどこにも無い。
     *
     * **【2026-08-05 訂正】**ここにはもともと「v0.1.1 で文章としては弱めた」と書いていたが、
     * **弱まっていなかった。**`modelLimitations.notes` は「機種横断では normalized を使うこと」を
     * v0.1.0 から v0.5.0 まで 7 版すべてでそのまま出し続けていた（全 tag を走査して実測）。
     * v0.2.0 でこの機械可読フィールドを足したときに、**元の文言を消し忘れて矛盾になっていた。**
     * 外部監査が指摘するまで気づかなかった。v0.5.1 で notes 側を直した。
     */
    normalizedScope: 'PROFILE_LOCAL' as const,
    crossProfileComparable: false,
    normalizedNote:
      '**profile 内のモデル相対座標である。**分母 (fullInsertionDepthMm) は profile ごとに違い、'
      + '接点配置も違うので、**同じ normalized 値が別 profile で同じ電気状態を意味することは保証しない。**'
      + '機種をまたいで比べるときは normalized ではなく、電気トポロジーの遷移そのもので対応づけること。',
  },
  /**
   * **電気的に全機能が揃う深さと、機械的な完全挿入は違う（非阻害オーダー P2-6.1）。**
   *
   * 旧クラス名 `fully-seated` は「プラグ肩が当たった」と読めたが、実体は
   * `ALL_EXPECTED_FUNCTIONS_MATCH` でしかない。v2 でクラス名を改めたうえで、
   * **その差が何 mm あるのかを数字で出す。**名前を直しただけでは同じ誤読が起きる。
   */
  mechanicalInsertion: {
    completeAtMm: m.fullDepthMm,
    firstAllFunctionsMatchAtMm: allFunctionsFromMm,
    gapMm: allFunctionsFromMm === null ? null : +(m.fullDepthMm - allFunctionsFromMm).toFixed(4),
    note:
      '**クラス名を「奥まで刺さった」と読まないこと。**電気的にすべての機能が揃う深さは、'
      + '機械的な完全挿入より手前にある。gapMm がその差である。',
  },
  dataLicense: {
    code: 'MIT',
    data: 'CC BY 4.0',
    attribution: 'trs-jack-3d (https://github.com/Driedsandwich/trs-jack-3d) — CC BY 4.0',
  },
  modelLimitations: {
    /**
     * **リテラルではない。**`docs/VERIFIED_PHYSICAL_GATE.md` の条文に従って、
     * `docs/measurements/measurement-records.v1.json` の記録から機械で決める。
     * 記録が 0 件なら `false`。**それが正しい状態である**（実測は募集しているが必須にしていない）。
     */
    verifiedPhysical: gate.verified,
    physicalVerificationRef: gateRef,
    notes: [
      '実物と突き合わせた検証をしていない。ジャック内部の接点ばね寸法は仮定である。',
      // **variant ごとに書き分ける。** 2026-08-03 まで全 variant へ 1532 10 × 1503 09 と書いていた
      // (統合オーダー P0-2)。組み合わせは PARTS の実データから作る
      `この profile は ${PARTS[String(VARIANT).split('|')[0]]?.label ?? '不明'} × `
        + `${PARTS[String(VARIANT).split('|')[1]]?.label ?? '不明'} の 1 組についてのものであり、`
        + '3.5mm ジャック全般を代表しない。',
      'acousticAnnotation は参考分類であって DSP 係数ではない。フィルタ係数・ゲイン・クロストーク量へ直接変換してはならない。',
      'quality を接触抵抗 Ω へ換算してはならない。相対スコアであって物理量ではない。',
      // **profile 横断の対応づけ方。** 2026-08-05 まで、ここは「機種横断では normalized を使うこと」
      // と書いていた。coordinateSystem.crossProfileComparable: false と真逆で、**配布した artifact の
      // 中で矛盾していた**（外部監査が発見）。normalized は主キーにならない
      'nominalStartMm は 1 機種の実寸であり、一般的な「挿入深度」ではない。'
        + 'profile を跨いで対応づけるときは topologyClass と event の同一性を主キーにすること。'
        + 'normalized は分母 (fullInsertionDepthMm) が profile ごとに違うので主キーにできない'
        + '（近傍を選ぶ補助にだけ使う）。',
    ],
  },
  assumptionSummary: { counts, jackInternalAssumptions: jackInternal },
  // 統合オーダー §3 P0: 既定モデルに GROUND_OPEN が無いなら、それを明示的に出力する。
  // Half-Plug 側の中核候補なので、「無い」ことこそ渡すべき情報である。
  absentTopologies: (() => {
    // **分類器が持つ一覧をそのまま使う。** ここに手書きの配列を置くと、
    // クラスを増やしたときに「探した」の一覧だけが古くなる (逆向きの陳腐化)
    const searched = [...ALL_TOPOLOGY_CLASSES]
    const present = new Set(intervals.map((i) => (i.electricalTopology as { topologyClass: string }).topologyClass))
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

// --out で書き出し先を変えられる。**byte-identical の確認に要る。**
// artifacts/ へ 2 回書いて比べると、比較の途中で作業ツリーが汚れてしまう
const OUT_DIR = argOf('out', resolve(ROOT, 'artifacts'))
mkdirSync(OUT_DIR, { recursive: true })
const OUT_PATH = resolve(OUT_DIR, `half_plug_topology_profile.v3.${slug}.json`)
writeFileSync(OUT_PATH, JSON.stringify(profile, null, 1) + '\n')

const codes = new Set(intervals.map((i) => (i.electricalTopology as { topologyClass: string }).topologyClass))
console.log(`\n  ${VARIANT}`)
console.log(`  区間 ${intervals.length} / イベント ${events.length}`)
console.log(`  現れたトポロジー: ${[...codes].sort().join(', ')}`)
console.log(`  共通帰線断: ${[...codes].some((c) => /ground-open/.test(c)) ? '存在する' : '**この既定モデルには存在しない**'}`)
console.log(`  inputDigest: ${provenance.inputDigest.slice(0, 12)} / dirty: ${provenance.workingTreeDirty} / ${provenance.artifactKind}`)
console.log(`  sourceRevision: ${profile.sourceRevision} / generatedAt: ${profile.generatedAt}`)
console.log(`  ${relative(ROOT, OUT_PATH)} を書き出した`)
