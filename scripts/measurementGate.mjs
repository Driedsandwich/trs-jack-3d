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
 */

export const GATE_VERSION = 1
export const GATE_DOCUMENT = 'docs/VERIFIED_PHYSICAL_GATE.md'
export const LEDGER_PATH = 'docs/measurements/measurement-records.v1.json'

/**
 * 観測点の定義。
 *
 * `toleranceMm` は**その観測点で見分けたい差の 1/5** を基準に置いた。
 * 例えば `L` は本モデルと実在部品 PS000001 の予測が 1.45 mm 離れているので 0.29 mm。
 * **判定に効かない桁を要求しない**ためで、これ以上厳しくすると
 * 「測ってもらったのに弾く」ことになる。
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

/**
 * 記録 1 件が使えるかを見る。**予測との一致は見ない**（→ `evaluateGate`）。
 * 理由を全部返す。最初の 1 個で止めると、直しても次が出る。
 */
export function checkRecord(rec) {
  const reasons = []
  const obs = OBSERVATIONS[rec?.observation]
  if (!obs) reasons.push(`観測点 ${rec?.observation} は定義されていない`)
  if (rec?.retracted === true) reasons.push('取り下げられている')
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
  if (Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    rangeMm = +(Math.max(...v) - Math.min(...v)).toFixed(4)
    meanMm = +mean(v).toFixed(4)
    if (obs && rangeMm > obs.toleranceMm) {
      reasons.push(`3 回のばらつき ${rangeMm} mm が許容 ${obs.toleranceMm} mm を超えている`)
    }
  }
  return { valid: reasons.length === 0, reasons, rangeMm, meanMm }
}

/**
 * profile 1 本ぶんの判定。
 *
 * @param ledger      記録台帳（`docs/measurements/measurement-records.v1.json`）
 * @param profileVariantId  判定したい profile の variant
 * @param predictions {観測点ID: 現行モデルの予測値}。**渡されていない観測点は満たせない**
 */
export function evaluateGate({ ledger, profileVariantId, predictions = {} }) {
  const required = REQUIRED_FOR_PROFILE[profileVariantId]
  const satisfied = []
  const missing = []
  const rejected = []

  if (!required) {
    return {
      verified: false,
      gateVersion: GATE_VERSION,
      required: [],
      satisfied,
      missing: [`profile ${profileVariantId} の必須観測点が条文に無い（定義が無いものは検証済みにしない）`],
      rejected,
    }
  }

  const records = Array.isArray(ledger?.records) ? ledger.records : []
  for (const id of required) {
    const obs = OBSERVATIONS[id]
    const cands = records.filter((r) => r?.observation === id)
    const predicted = predictions[id]
    let hit = null
    for (const r of cands) {
      const c = checkRecord(r)
      if (!c.valid) { rejected.push({ recordId: r?.recordId ?? '(id なし)', observation: id, reasons: c.reasons }); continue }
      if (typeof predicted !== 'number' || !Number.isFinite(predicted)) {
        rejected.push({ recordId: r.recordId, observation: id, reasons: ['現行モデルの予測が渡されていない'] })
        continue
      }
      const deltaMm = +Math.abs(c.meanMm - predicted).toFixed(4)
      if (deltaMm > obs.toleranceMm) {
        rejected.push({
          recordId: r.recordId,
          observation: id,
          reasons: [`実測 ${c.meanMm} mm と現行モデルの予測 ${predicted} mm の差 ${deltaMm} mm が`
            + `許容 ${obs.toleranceMm} mm を超えている。**モデルのほうを直すこと**`],
        })
        continue
      }
      hit = { observation: id, recordId: r.recordId, measuredMm: c.meanMm, predictedMm: predicted, deltaMm, rangeMm: c.rangeMm }
      break
    }
    if (hit) satisfied.push(hit)
    else missing.push(id)
  }

  return {
    verified: missing.length === 0,
    gateVersion: GATE_VERSION,
    required,
    satisfied,
    missing,
    rejected,
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
