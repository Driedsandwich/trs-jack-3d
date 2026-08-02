/**
 * 挿入経路の全域走査とイベント抽出。仕様 §11 / §17 / §18。
 *
 * 走査は 0.05mm 以下の刻みで行い、同じ入力なら必ず同じ結果になる。
 */

import type { TrsModel } from './engine'
import type { BreakState, ContactState, FaultParams, Grade, InsertionEvent } from './types'
import { DEFAULT_FAULTS } from './contact'

export interface SweepContactRow {
  contactId: string
  /** 接点パッドが重なっているセグメント id (幅の大きい順) */
  touchingSegments: string[]
  /** 導通していると判定したプラグ導体 */
  connectedNets: string[]
  state: ContactState
  breakState: BreakState | null
  quality: number
  deflectionMm: number
  grade: Grade
}

export interface SweepRow {
  depthMm: number
  depthPercent: number
  contacts: SweepContactRow[]
  bridged: boolean
  wrongSegment: boolean
  acoustic: string
  estimatedInsertionForceN: number
  estimatedWithdrawalForceN: number
}

export function sweep(
  model: TrsModel,
  opts: { stepMm?: number; startMm?: number; faults?: FaultParams } = {},
): SweepRow[] {
  const stepMm = opts.stepMm ?? 0.02
  const startMm = opts.startMm ?? -(model.plug.fingerLengthMm + 1)
  const faults = opts.faults ?? DEFAULT_FAULTS
  const end = model.fullDepthMm
  const n = Math.round((end - startMm) / stepMm)
  const rows: SweepRow[] = []
  for (let i = 0; i <= n; i++) {
    // 浮動小数の累積誤差を避けるため毎回 startMm から作り直す
    const depth = Math.min(end, Number((startMm + i * stepMm).toFixed(6)))
    const ev = model.evaluate(depth, faults)
    const f = model.force(depth, faults)
    rows.push({
      depthMm: depth,
      depthPercent: Number(ev.depthPercent.toFixed(4)),
      contacts: ev.contacts.map((c) => ({
        contactId: c.contactId,
        touchingSegments: c.overlaps.map((o) => o.segmentId),
        connectedNets: c.connectedNets,
        state: c.state,
        breakState: c.breakState,
        quality: Number(c.quality.toFixed(4)),
        deflectionMm: Number(c.deflectionMm.toFixed(4)),
        grade: c.grade,
      })),
      bridged: ev.anyBridged,
      wrongSegment: ev.anyWrongSegment,
      acoustic: ev.acoustic.code,
      estimatedInsertionForceN: Number(f.insertionN.toFixed(3)),
      estimatedWithdrawalForceN: Number(f.withdrawalN.toFixed(3)),
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// イベント抽出
// ---------------------------------------------------------------------------

const CONDUCTING: ContactState[] = ['CLOSED', 'TOUCH_UNSTABLE', 'WRONG_SEGMENT', 'BRIDGED']

export function extractEvents(model: TrsModel, rows: SweepRow[]): InsertionEvent[] {
  const events: InsertionEvent[] = []
  const seen = new Set<string>()

  const push = (
    kind: InsertionEvent['kind'],
    depthMm: number,
    label: string,
    detail: string,
    severity: InsertionEvent['severity'],
    once = true,
  ) => {
    if (once) {
      if (seen.has(kind)) return
      seen.add(kind)
    }
    events.push({ kind, depthMm, label, detail, severity })
  }

  const expectedNetOf = (contactId: string) => {
    const c = model.jack.contacts.find((x) => x.id === contactId)!
    return model.plug.segments.find((s) => s.id === c.expectedSegment)?.net
  }

  let prev: SweepRow | null = null

  for (const row of rows) {
    // 最初の物理接触
    if (row.contacts.some((c) => c.deflectionMm > 0)) {
      push(
        'FIRST_PHYSICAL_CONTACT',
        row.depthMm,
        '最初の物理接触',
        'ジャックの接点ばねがプラグ表面に触れ、たわみ始めた',
        'info',
      )
    }
    // 最初の電気接触
    if (row.contacts.some((c) => CONDUCTING.includes(c.state))) {
      push(
        'FIRST_ELECTRICAL_CONTACT',
        row.depthMm,
        '最初の電気接触',
        'いずれかの接点がプラグ導体と導通した',
        'info',
      )
    }
    // 最初のブレーク接点開放
    if (row.contacts.some((c) => c.breakState === 'BREAK_OPEN')) {
      push(
        'FIRST_BREAK_OPEN',
        row.depthMm,
        '最初のブレーク接点開放',
        '接点ばねが押し広げられ、内蔵スイッチが開いた (内蔵スピーカ等への切替が起きる位置)',
        'info',
      )
    }
    // 最初の誤セグメント接触
    if (row.wrongSegment) {
      const c = row.contacts.find((x) => x.state === 'WRONG_SEGMENT')!
      push(
        'FIRST_WRONG_SEGMENT',
        row.depthMm,
        '最初の誤セグメント接触',
        `${c.contactId} が本来の ${expectedNetOf(c.contactId)} ではなく ${c.connectedNets.join('+')} に触れた`,
        'warn',
      )
    }
    // 最初の橋絡
    if (row.bridged) {
      const c = row.contacts.find((x) => x.state === 'BRIDGED')!
      push(
        'FIRST_BRIDGE',
        row.depthMm,
        '最初の橋絡 (短絡)',
        `${c.contactId} が ${c.connectedNets.join(' と ')} を同時に短絡させた`,
        'bad',
      )
    }
    // 全信号接点が正しいセグメントに接触
    const allCorrect = row.contacts.every((c) => {
      const jc = model.jack.contacts.find((x) => x.id === c.contactId)!
      const expected = model.plug.segments.find((s) => s.id === jc.expectedSegment)?.net
      return c.state === 'CLOSED' && c.connectedNets.length === 1 && c.connectedNets[0] === expected
    })
    if (allCorrect) {
      push(
        'ALL_SIGNALS_CORRECT',
        row.depthMm,
        '全接点が正規接続',
        'Tip/Ring/Sleeve の全てが対応する導体に安定接触した',
        'ok',
      )
    }
    prev = row
  }

  // 完全挿入
  push(
    'FULL_INSERTION',
    model.fullDepthMm,
    '完全挿入',
    'プラグ肩がジャックの停止面に当たり、それ以上入らない位置',
    'ok',
  )

  // 抜去時に最後の接点が離れる位置。
  // 浅い側から走査し、最初に接触が生じる深度を取る。これより浅い側では常に非接触なので、
  // 抜いていく向きではここが「最後に離れる」位置になる。
  // 幾何は挿入方向と抜去方向で同一なので、この深度は最初の物理接触と一致する
  // (異なるのは力だけ。力のヒステリシスは force_curve.json 側に出る)。
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].contacts.some((c) => c.deflectionMm > 0)) {
      events.push({
        kind: 'LAST_CONTACT_RELEASE',
        depthMm: rows[i].depthMm,
        label: '抜去時に最後の接点が離れる位置',
        detail:
          'これより浅いとジャックはプラグに一切触れていない。経路の幾何は挿入・抜去で同じなので最初の物理接触と同じ深度になる (違うのは力だけ)。',
        severity: 'info',
      })
      break
    }
  }

  // 状態が切り替わる位置 (接点ごと)
  prev = null
  for (const row of rows) {
    if (prev) {
      for (let i = 0; i < row.contacts.length; i++) {
        const a = prev.contacts[i]
        const b = row.contacts[i]
        if (a.state !== b.state) {
          events.push({
            kind: 'STATE_CHANGE',
            depthMm: row.depthMm,
            label: `${b.contactId}: ${a.state} → ${b.state}`,
            detail: `接触セグメント: ${b.touchingSegments.join(', ') || 'なし'}`,
            severity:
              b.state === 'BRIDGED' || b.state === 'WRONG_SEGMENT'
                ? 'bad'
                : b.state === 'CLOSED'
                  ? 'ok'
                  : 'info',
            // label とは別に持つ。文言を直しても識別子が変わらないようにする
            subject: {
              subjectType: 'contact',
              subjectId: b.contactId,
              fromState: a.state,
              toState: b.state,
            },
          })
        }
        if (a.breakState !== b.breakState) {
          events.push({
            kind: 'STATE_CHANGE',
            depthMm: row.depthMm,
            label: `${b.contactId} ブレーク接点: ${a.breakState} → ${b.breakState}`,
            detail: 'ジャック内蔵スイッチの開閉',
            severity: 'info',
            subject: {
              subjectType: 'break-contact',
              subjectId: b.contactId,
              fromState: String(a.breakState),
              toState: String(b.breakState),
            },
          })
        }
      }
    }
    prev = row
  }

  events.sort((a, b) => a.depthMm - b.depthMm)
  return events
}
