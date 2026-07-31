import { GRADE_COLOR, GRADE_LABEL, STATE_COLOR, STATE_LABEL, STATE_SYMBOL } from '../three/materials'
import { useModel } from '../store/useAppStore'
import { useEvaluation } from '../store/useEvaluation'
import type { ContactState, Grade } from '../model/types'

export function StateBadge({ state }: { state: ContactState }) {
  return (
    <span className="badge" style={{ color: STATE_COLOR[state] }}>
      {STATE_SYMBOL[state]} {STATE_LABEL[state]}
    </span>
  )
}

export function GradeBadge({ grade }: { grade: Grade }) {
  return (
    <span className="badge" style={{ color: GRADE_COLOR[grade] }} title={GRADE_LABEL[grade]}>
      {grade}
    </span>
  )
}

export function ContactTable() {
  const model = useModel()
  const ev = useEvaluation()

  return (
    <div className="card">
      <h2>接点の状態</h2>
      <table className="grid">
        <thead>
          <tr>
            <th>接点</th>
            <th>触れている所</th>
            <th>状態</th>
            <th style={{ width: 62 }}>品質</th>
          </tr>
        </thead>
        <tbody>
          {ev.contacts.map((c) => {
            const jc = model.jack.contacts.find((x) => x.id === c.contactId)!
            const expected = model.plug.segments.find((s) => s.id === jc.expectedSegment)
            return (
              <tr key={c.contactId}>
                <td>
                  <div style={{ fontWeight: 600 }}>{c.label}</div>
                  <div className="xsmall muted">
                    期待: {expected?.net ?? jc.expectedSegment} / 端子 {c.terminalId}
                  </div>
                  <div className="xsmall muted mono">
                    たわみ {c.deflectionMm.toFixed(3)} mm ・ {c.normalForceN.toFixed(2)} N
                  </div>
                </td>
                <td>
                  {c.overlaps.length === 0 ? (
                    <span className="muted">—</span>
                  ) : (
                    c.overlaps.map((o) => (
                      <div key={o.segmentId} className="xsmall">
                        <span
                          className="swatch"
                          style={{
                            background: o.kind === 'insulator' ? 'var(--purple)' : 'var(--accent)',
                            marginRight: 4,
                          }}
                        />
                        {o.segmentLabel}
                        <span
                          className="muted mono"
                          title={`パッドの噛み合い ${o.engagedWidthMm.toFixed(3)}mm / 導通判定に使う帯 ${o.widthMm.toFixed(3)}mm`}
                        >
                          {' '}
                          {o.engagedWidthMm.toFixed(3)}mm ({(o.fraction * 100).toFixed(0)}%)
                          {Math.abs(o.engagedWidthMm - o.widthMm) > 1e-6 &&
                            ` / 導通帯 ${o.widthMm.toFixed(3)}mm`}
                        </span>
                      </div>
                    ))
                  )}
                  {c.breakState && (
                    <div className="xsmall" style={{ marginTop: 3 }}>
                      <span
                        className="badge"
                        style={{ color: c.breakState === 'BREAK_OPEN' ? 'var(--warn)' : 'var(--ok)' }}
                      >
                        {c.breakState === 'BREAK_OPEN' ? '⎋ ブレーク OPEN' : '⏛ ブレーク CLOSED'}
                      </span>
                    </div>
                  )}
                </td>
                <td>
                  <StateBadge state={c.state} />
                  <div className="xsmall muted" style={{ marginTop: 3 }}>{c.reason}</div>
                  <div style={{ marginTop: 3 }}>
                    <GradeBadge grade={c.grade} />
                  </div>
                </td>
                <td>
                  <div className="mono xsmall">{c.quality.toFixed(2)}</div>
                  <div className="bar" style={{ marginTop: 3 }}>
                    <span
                      style={{
                        width: `${c.quality * 100}%`,
                        background: STATE_COLOR[c.state],
                      }}
                    />
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div className="legend" style={{ marginTop: 8 }}>
        {(Object.keys(STATE_LABEL) as ContactState[]).map((s) => (
          <span key={s}>
            <span className="swatch" style={{ background: STATE_COLOR[s] }} />
            {STATE_SYMBOL[s]} {STATE_LABEL[s]}
          </span>
        ))}
      </div>

      <div className="xsmall muted" style={{ marginTop: 8 }}>
        品質スコアは 0〜1 の相対指標であり、抵抗値 (Ω) ではない。完全接触時のメーカー公称接触抵抗は
        別途「仕様値」として表示している。
      </div>
    </div>
  )
}
