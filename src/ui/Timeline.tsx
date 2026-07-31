import { useMemo, useRef, useState } from 'react'
import { useAppStore, useModel } from '../store/useAppStore'
import { useSweep } from '../store/useEvaluation'
import type { InsertionEvent } from '../model/types'

const SEV_COLOR: Record<InsertionEvent['severity'], string> = {
  info: '#38bdf8',
  ok: '#22c55e',
  warn: '#f59e0b',
  bad: '#ef4444',
}

/** 主要イベント (STATE_CHANGE 以外) を優先して表示 */
function pickMajor(events: InsertionEvent[]): InsertionEvent[] {
  return events.filter((e) => e.kind !== 'STATE_CHANGE')
}

export function Timeline() {
  const model = useModel()
  const depthMm = useAppStore((s) => s.depthMm)
  const setDepth = useAppStore((s) => s.setDepth)
  const { events } = useSweep(0.05)
  const [showAll, setShowAll] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)

  const min = -(model.plug.fingerLengthMm + 1)
  const max = model.fullDepthMm
  const toPct = (mm: number) => ((mm - min) / (max - min)) * 100

  const major = useMemo(() => pickMajor(events), [events])
  const shown = showAll ? events : major

  const onBarClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = barRef.current?.getBoundingClientRect()
    if (!rect) return
    const t = (e.clientX - rect.left) / rect.width
    setDepth(min + t * (max - min))
  }

  return (
    <div className="card">
      <div className="spread">
        <h2 style={{ margin: 0 }}>イベントマーカー</h2>
        <button className="xsmall" onClick={() => setShowAll(!showAll)}>
          {showAll ? '主要のみ' : `全 ${events.length} 件`}
        </button>
      </div>

      <div className="timeline" ref={barRef} onClick={onBarClick} role="slider"
           aria-label="挿入経路タイムライン" aria-valuenow={depthMm} aria-valuemin={min} aria-valuemax={max}
           tabIndex={0}>
        {shown.map((e, i) => (
          <div
            key={`${e.kind}-${e.depthMm}-${i}`}
            className="tick"
            style={{ left: `${toPct(e.depthMm)}%`, background: SEV_COLOR[e.severity] }}
            title={`${e.depthMm.toFixed(2)}mm — ${e.label}`}
          />
        ))}
        <div className="cursor" style={{ left: `${toPct(depthMm)}%` }} />
        <div className="axis">
          <span>{min.toFixed(0)}</span>
          <span>0</span>
          <span>{max.toFixed(1)} mm</span>
        </div>
      </div>

      <div style={{ maxHeight: 210, overflowY: 'auto', marginTop: 8 }}>
        <table className="grid">
          <tbody>
            {shown.map((e, i) => (
              <tr key={`${e.kind}-${e.depthMm}-${i}`}>
                <td style={{ width: 62 }}>
                  <button
                    className="xsmall mono"
                    onClick={() => setDepth(e.depthMm)}
                    style={{ padding: '2px 5px' }}
                    title="この深度へ移動"
                  >
                    {e.depthMm.toFixed(2)}
                  </button>
                </td>
                <td>
                  <span style={{ color: SEV_COLOR[e.severity], fontWeight: 600 }}>{e.label}</span>
                  <div className="xsmall muted">{e.detail}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="xsmall muted" style={{ marginTop: 6 }}>
        走査刻み 0.05 mm。同じ入力なら常に同じイベント列になる (決定論的)。
      </div>
    </div>
  )
}
