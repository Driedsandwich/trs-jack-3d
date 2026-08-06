/**
 * `verifiedPhysical` を、**記録から機械で決める。**
 *
 * 2026-08-06 まで `scripts/exportHalfPlugProfile.ts` のリテラル `false` だった。
 * schema の説明は「true にできるのは実測記録が伴う場合のみ」だけで、
 * **何を何点測れば足りるのかが定義されていなかった。**
 * つまり実態は「誰かがリテラルを書き換えたら true」で、**検証ではなかった。**
 *
 * 条文は `docs/VERIFIED_PHYSICAL_GATE.md`。ここはその実装である。
 *
 * **予測は呼び出し側が渡す。**この module はモデルを読まない。
 * 生成器が「いま計算したモデルの予測」を渡すので、
 * **モデルが動けば判定もやり直される**（古い予測と照合し続けることがない）。
 *
 * ---
 * **条文 v2（2026-08-06）で 3 つ直した。**外部監査の反例をこちらで再現してから直している。
 *
 * | | v1 で何が起きたか | v2 |
 * |---|---|---|
 * | 相反記録 | 一致する記録を 1 件見つけた時点で `break` していたので、**同じ台帳でも並び順で結果が変わり、矛盾する記録があっても `true`** | 全候補を評価し、順序に依存しない。一致と矛盾が併存したら `AMBIGUOUS`（＝ `false`） |
 * | 分解能 | `resolutionMm > 0` しか見ていないので、**許容 0.29 mm の判定を分解能 1.0 mm の測定器が通った** | 観測点ごとに `maxResolutionMm` を置き、超えたら**認定しない** |
 * | 主張の範囲 | `verifiedPhysical: true` が「その接点トポロジーを実物で確かめた」と読めた | `claimScope` を出力し、**幾何の観測点が合っただけ**であることを機械可読にする |
 */

export const GATE_VERSION = 2
export const GATE_DOCUMENT = 'docs/VERIFIED_PHYSICAL_GATE.md'
export const LEDGER_PATH = 'docs/measurements/measurement-records.v1.json'

/**
 * **この判定が何を主張しているか。**（条文 v2 第9条）
 *
 * `verifiedPhysical: true` が言うのは「**条文が名指しした幾何量が、モデルの予測と合った**」まで。
 * 接点トポロジー（どの端子がどの導体と繋がるか・GND が開放か・短絡が無いか）も、
 * 音響特性も、**この判定では確かめていない。**
 */
export const CLAIM_SCOPE = 'geometry-only'

/** 将来ここが増えたら、増えたぶんだけ別に測る。**`verifiedPhysical` は geometry しか担わない** */
export const CLAIM_SCOPES_NOT_COVERED = ['target-topology', 'acoustic', 'lot-variation']

/**
 * 分解能の要求は**許容の 1/3 以下**から出す（条文 v2 第5条）。
 * 目盛が許容と同じ粗さだと、量子化の誤差だけで許容帯を食い尽くしてしまい、
 * **「合った」が測定器の粗さの結果なのかモデルの正しさなのか分けられない。**
 */
export const RESOLUTION_DIVISOR = 3

/** 実際の測定器の刻みへ**切り下げる**（0.0967 のような要求値は道具の側に存在しない） */
const INSTRUMENT_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1]
function maxResolutionFor(toleranceMm) {
  const want = toleranceMm / RESOLUTION_DIVISOR
  const usable = INSTRUMENT_STEPS.filter((s) => s <= want + 1e-12)
  return usable.length ? usable[usable.length - 1] : INSTRUMENT_STEPS[0]
}

/**
 * 観測点の定義。
 *
 * `toleranceMm` は**その観測点で見分けたい差の 1/5** を基準に置いた。
 * 例えば `L` は本モデルと実在部品 PS000001 の予測が 1.45 mm 離れているので 0.29 mm。
 * **判定に効かない桁を要求しない**ためで、これ以上厳しくすると
 * 「測ってもらったのに弾く」ことになる。
 *
 * `maxResolutionMm` は許容から導く（→ `maxResolutionFor`）。**手で書かない。**
 */
export const OBSERVATIONS = {
  L_FIRST_CONTACT_SHOULDER_GAP_MM: {
    variantId: 'TRRS-CTIA|JACK-TRRS',
    label: '4極ジャックの L 端子が、プラグ Tip 導体と最初に導通するときの肩すき間',
    unit: 'mm',
    toleranceMm: 0.29,
    discriminatesMm: 1.45,
    why: '**このプロジェクトで最も重い未確認事項**（UNKNOWNS §5-2）を直接決める。'
      + '本モデルの予測 2.14 mm と実在部品 PS000001 由来の予測 0.69 mm が 1.45 mm 離れており、'
      + 'ノギスの分解能 0.01 mm の 145 倍なので、測り慣れていなくても結果が動かない',
    procedure: 'docs/VERIFICATION_PLAN.md §2-2',
  },
  RING_BREAK_OPEN_DEPTH_MM: {
    variantId: 'TRS|JACK-TRS',
    label: 'Ring 側ブレーク接点が最初に開く深さ（ピン2 ↔ ピン4）',
    unit: 'mm',
    toleranceMm: 0.3,
    discriminatesMm: 1.5,
    why: 'ジャックだけで測れて、Ring 接点ばねの軸位置がそのまま出る',
    procedure: 'docs/VERIFICATION_PLAN.md §1',
  },
  TIP_BREAK_OPEN_DEPTH_MM: {
    variantId: 'TRS|JACK-TRS',
    label: 'Tip 側ブレーク接点が開く深さ（ピン3 ↔ ピン5）',
    unit: 'mm',
    toleranceMm: 0.3,
    discriminatesMm: 1.5,
    why: '同上。Tip 接点ばねの軸位置に効く',
    procedure: 'docs/VERIFICATION_PLAN.md §1',
  },
}
for (const o of Object.values(OBSERVATIONS)) o.maxResolutionMm = maxResolutionFor(o.toleranceMm)

/**
 * profile ごとの必須観測点。
 *
 * **ここに載っていない profile は必ず `false` になる**（fail closed）。
 * 「必須が 0 件だから全部満たしている」で `true` になると、
 * **profile を足しただけで検証済みを名乗れてしまう。**
 */
export const REQUIRED_FOR_PROFILE = {
  'TRS|JACK-TRS': ['RING_BREAK_OPEN_DEPTH_MM', 'TIP_BREAK_OPEN_DEPTH_MM'],
  'TRS|JACK-TRRS': ['L_FIRST_CONTACT_SHOULDER_GAP_MM'],
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
const round4 = (x) => +x.toFixed(4)

/**
 * 記録 1 件が使えるかを見る。**予測との一致は見ない**（→ `evaluateGate`）。
 * 理由を全部返す。最初の 1 個で止めると、直しても次が出る。
 *
 * **「使えない」を 2 つに分ける（条文 v2 第3条）。**
 *
 * - `valid: false` … 記録として壊れている。**中身を読まない**
 * - `certifiable: false` … 記録は読めるが、**認定には足りない**（分解能が粗い・目盛に乗っていない）
 *
 * 分けるのは、**粗い測定でもモデルとの食い違いは検出できる**ため。
 * 分解能 1.0 mm の測定でも「1.45 mm ずれている」は言える。
 * それを「使えない記録」として捨てると、**モデルの誤りを見逃す。**
 */
export function checkRecord(rec) {
  const reasons = []
  const notCertifiable = []
  const obs = OBSERVATIONS[rec?.observation]
  if (!obs) reasons.push(`観測点 ${rec?.observation} は定義されていない`)
  const retracted = rec?.retracted === true
  if (obs && rec?.variantId !== obs.variantId) {
    reasons.push(`variantId が観測点の定義（${obs.variantId}）と違う`)
  }
  const v = rec?.valuesMm
  if (!Array.isArray(v) || v.length < 3) reasons.push('生値が 3 回に満たない')
  else if (!v.every((x) => typeof x === 'number' && Number.isFinite(x))) reasons.push('生値に数でないものがある')
  const res = rec?.instrument?.resolutionMm
  if (!(typeof res === 'number' && res > 0)) reasons.push('測定器の分解能が書かれていない')
  for (const [k, label] of [['measuredBy', '測った人'], ['measuredOn', '測定日']]) {
    if (!rec?.[k]) reasons.push(`${label}（${k}）が無い`)
  }
  if (rec?.measuredOn && !isDate(rec.measuredOn)) reasons.push('測定日が YYYY-MM-DD ではない')
  for (const [k, label] of [['jack', 'ジャック'], ['plug', 'プラグ']]) {
    if (!rec?.parts?.[k]) reasons.push(`${label}の型番（parts.${k}）が無い`)
  }

  let rangeMm = null
  let meanMm = null
  const valuesOk = Array.isArray(v) && v.length >= 3
    && v.every((x) => typeof x === 'number' && Number.isFinite(x))
  if (valuesOk) {
    rangeMm = round4(Math.max(...v) - Math.min(...v))
    meanMm = round4(mean(v))
    if (obs && rangeMm > obs.toleranceMm) {
      reasons.push(`3 回のばらつき ${rangeMm} mm が許容 ${obs.toleranceMm} mm を超えている`)
    }
  }

  // --- 認定に足りるか（条文 v2 第5条）。**壊れているとは別に見る** ---
  if (obs && typeof res === 'number' && res > 0) {
    if (res > obs.maxResolutionMm + 1e-12) {
      notCertifiable.push(
        `測定器の分解能 ${res} mm では、許容 ${obs.toleranceMm} mm の判定を認定できない`
        + `（この観測点は ${obs.maxResolutionMm} mm 以下が要る＝許容の 1/${RESOLUTION_DIVISOR} 以下）。`
        + '**食い違いの検出には使うが、`verifiedPhysical` は立てない**',
      )
    }
    if (valuesOk) {
      const off = v.filter((x) => Math.abs(x - Math.round(x / res) * res) > res * 1e-3)
      if (off.length) {
        notCertifiable.push(
          `生値 ${off.join(', ')} が分解能 ${res} mm の目盛に乗っていない`
          + '（その測定器では読めない値なので、分解能か生値のどちらかが違う）',
        )
      }
    }
  }

  return {
    valid: reasons.length === 0,
    certifiable: reasons.length === 0 && notCertifiable.length === 0,
    retracted,
    reasons,
    notCertifiableReasons: notCertifiable,
    rangeMm,
    meanMm,
    resolutionMm: typeof res === 'number' && res > 0 ? res : null,
  }
}

/**
 * profile 1 本ぶんの判定。
 *
 * @param ledger      記録台帳（`docs/measurements/measurement-records.v1.json`）
 * @param profileVariantId  判定したい profile の variant
 * @param predictions {観測点ID: 現行モデルの予測値}。**渡されていない観測点は満たせない**
 *
 * **全候補を評価する。**一致を 1 件見つけても止まらない（条文 v2 第10条）。
 * 途中で止めると、後ろに矛盾する記録があっても `true` になり、
 * **同じ台帳でも並び順で結果が変わる**（外部監査 2026-08-06 の反例。こちらで再現済み）。
 */
export function evaluateGate({ ledger, profileVariantId, predictions = {} }) {
  const required = REQUIRED_FOR_PROFILE[profileVariantId]
  const satisfied = []
  const missing = []
  const ambiguous = []
  const rejected = []
  const conflicting = []
  const retracted = []
  const notCertified = []

  const records = Array.isArray(ledger?.records) ? ledger.records : []

  /**
   * **recordId の重複は台帳ごと拒む。**
   * 同じ ID が 2 つあると、判定に使った記録を後から一意に指せない
   * （`physicalVerificationRef` が指す先が 2 つになる）。
   */
  const counts = new Map()
  for (const r of records) {
    const id = r?.recordId
    if (typeof id === 'string') counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const duplicateRecordIds = [...counts].filter(([, n]) => n > 1).map(([id]) => id).sort()

  const base = {
    gateVersion: GATE_VERSION,
    claimScope: CLAIM_SCOPE,
    notCoveredByThisClaim: CLAIM_SCOPES_NOT_COVERED,
  }

  if (!required) {
    return {
      ...base,
      verified: false,
      verdict: 'UNVERIFIED',
      required: [],
      satisfied,
      missing: [`profile ${profileVariantId} の必須観測点が条文に無い（定義が無いものは検証済みにしない）`],
      ambiguous,
      rejected,
      conflicting,
      retracted,
      notCertified,
      duplicateRecordIds,
      decidedBy: [],
    }
  }

  for (const id of required) {
    const obs = OBSERVATIONS[id]
    // **並び順に依存しないよう recordId で固定する。**入力の順序が結果に出ない
    const cands = records
      .filter((r) => r?.observation === id)
      .slice()
      .sort((a, b) => String(a?.recordId ?? '').localeCompare(String(b?.recordId ?? '')))
    const predicted = predictions[id]
    const accepted = []
    let conflictsHere = 0

    for (const r of cands) {
      const recordId = typeof r?.recordId === 'string' ? r.recordId : '(id なし)'
      const c = checkRecord(r)

      // 取り下げは「壊れている」ではない。**消さずに残し、数えない**
      if (c.retracted) {
        retracted.push({ recordId, observation: id, reason: r?.retractedReason ?? null })
        continue
      }
      if (!c.valid) {
        rejected.push({ recordId, observation: id, reasons: c.reasons })
        continue
      }
      if (typeof predicted !== 'number' || !Number.isFinite(predicted)) {
        rejected.push({ recordId, observation: id, reasons: ['現行モデルの予測が渡されていない'] })
        continue
      }

      const deltaMm = round4(Math.abs(c.meanMm - predicted))
      /**
       * **食い違いの判定には測定器自身の不確かさを足す。**
       * 目盛の量子化で最大 ±分解能/2 ずれるので、それを超えた差だけを「合わない」と言う。
       * ここを許容そのものにすると、粗い測定器で測っただけで
       * **モデルが間違っていることになってしまう。**
       */
      const conflictLimit = round4(obs.toleranceMm + (c.resolutionMm ?? 0) / 2)
      if (deltaMm > conflictLimit) {
        const reasons = [
          `実測 ${c.meanMm} mm と現行モデルの予測 ${predicted} mm の差 ${deltaMm} mm が`
          + `許容 ${obs.toleranceMm} mm（測定器の不確かさ込みで ${conflictLimit} mm）を超えている。`
          + '**モデルのほうを直すこと**',
        ]
        conflicting.push({ recordId, observation: id, measuredMm: c.meanMm, predictedMm: predicted, deltaMm, reasons })
        rejected.push({ recordId, observation: id, reasons })
        conflictsHere++
        continue
      }

      // 差は許容内。**認定できるかは分解能で別に決まる**
      if (!c.certifiable) {
        notCertified.push({ recordId, observation: id, reasons: c.notCertifiableReasons })
        rejected.push({ recordId, observation: id, reasons: c.notCertifiableReasons })
        continue
      }
      if (deltaMm > obs.toleranceMm) {
        // 不確かさ込みなら矛盾しないが、許容そのものは外している。認定しない
        notCertified.push({
          recordId,
          observation: id,
          reasons: [`差 ${deltaMm} mm が許容 ${obs.toleranceMm} mm を外している（測定器の不確かさ込みなら矛盾はしない）`],
        })
        continue
      }
      accepted.push({ observation: id, recordId, measuredMm: c.meanMm, predictedMm: predicted, deltaMm, rangeMm: c.rangeMm })
    }

    if (conflictsHere > 0 && accepted.length > 0) {
      // **一致と矛盾が併存している。**どちらが正しいかは記録からは決まらない
      ambiguous.push(id)
      continue
    }
    if (!accepted.length) { missing.push(id); continue }
    satisfied.push({ ...accepted[0], recordIds: accepted.map((a) => a.recordId) })
  }

  const verdict = duplicateRecordIds.length
    ? 'INVALID_LEDGER'
    : ambiguous.length
      ? 'AMBIGUOUS'
      : missing.length
        ? 'UNVERIFIED'
        : 'VERIFIED'

  return {
    ...base,
    verified: verdict === 'VERIFIED',
    verdict,
    required,
    satisfied,
    missing,
    ambiguous,
    rejected,
    conflicting,
    retracted,
    notCertified,
    duplicateRecordIds,
    decidedBy: satisfied.flatMap((s) => s.recordIds ?? [s.recordId]),
  }
}

/**
 * profile の event 列から、この観測点の**現行モデルの予測**を取り出す。
 * `eventIdentity` で引く。**label の文字列で引かない**（文言を直すと壊れる）。
 */
export function predictionsFromEvents(events, fullDepthMm) {
  const firstBreakOpen = (subjectId) => {
    const e = (events ?? []).find(
      (x) => x?.eventIdentity?.subjectType === 'break-contact'
        && x.eventIdentity.subjectId === subjectId
        && x.eventIdentity.toState === 'BREAK_OPEN',
    )
    return e ? e.depthMm : undefined
  }
  const out = {}
  const ring = firstBreakOpen('JC_RING')
  const tip = firstBreakOpen('JC_TIP')
  if (typeof ring === 'number') out.RING_BREAK_OPEN_DEPTH_MM = ring
  if (typeof tip === 'number') out.TIP_BREAK_OPEN_DEPTH_MM = tip
  /**
   * **`L_FIRST_CONTACT_SHOULDER_GAP_MM` はここでは出せない。**
   * この観測点は 4極プラグ（`TRRS-CTIA|JACK-TRRS`）の量で、
   * 配布している profile は 3極プラグ（`TRS|JACK-TRRS`）だから、
   * **同じ event 列には現れない。**生成器が別 variant を評価して渡す。
   * 渡されなければ、その観測点は満たせない（fail closed）。
   */
  void fullDepthMm
  return out
}
