import { useMemo, useState } from 'react'
import { GRADE_COLOR, GRADE_LABEL } from '../three/materials'
import { useModel } from '../store/useAppStore'
import type { Grade } from '../model/types'

export function EvidencePanel() {
  const model = useModel()
  const [filter, setFilter] = useState<Grade | 'ALL'>('ALL')
  const [q, setQ] = useState('')

  const rows = useMemo(() => {
    const table = model.dims.all()
    return Object.entries(table)
      .filter(([k, e]) => (filter === 'ALL' || e.grade === filter) && k.toLowerCase().includes(q.toLowerCase()))
      .sort(([a], [b]) => a.localeCompare(b))
  }, [model, filter, q])

  const counts = useMemo(() => {
    const c: Record<Grade, number> = { FACT: 0, DERIVED: 0, ASSUMPTION: 0, UNKNOWN: 0 }
    for (const e of Object.values(model.dims.all())) c[e.grade]++
    return c
  }, [model])

  const total = Object.values(counts).reduce((a, b) => a + b, 0)

  return (
    <div className="card">
      <h2>根拠 (寸法・材料・仕様)</h2>

      <div className="row" style={{ marginBottom: 8 }}>
        <button data-active={filter === 'ALL'} onClick={() => setFilter('ALL')} className="xsmall">
          全 {total}
        </button>
        {(Object.keys(counts) as Grade[]).map((g) => (
          <button
            key={g}
            data-active={filter === g}
            onClick={() => setFilter(g)}
            className="xsmall"
            style={{ color: GRADE_COLOR[g] }}
            title={GRADE_LABEL[g]}
          >
            {g} {counts[g]}
          </button>
        ))}
      </div>

      <input
        type="text"
        placeholder="キーで絞り込み (例: plug.tip)"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{ width: '100%', marginBottom: 8 }}
        aria-label="寸法キーで絞り込み"
      />

      <div style={{ maxHeight: 300, overflowY: 'auto' }}>
        <table className="grid">
          <thead>
            <tr>
              <th>キー</th>
              <th style={{ width: 78 }}>値</th>
              <th style={{ width: 82 }}>根拠</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([k, e]) => (
              <tr key={k}>
                <td>
                  <div className="mono xsmall">{k}</div>
                  {e.note && <div className="xsmall muted">{e.note}</div>}
                  {e.sources && e.sources.length > 0 && (
                    <div className="xsmall muted">
                      出典:{' '}
                      {e.sources.map((sid, i) => {
                        const src = model.sources.get(sid)
                        return (
                          <span key={sid}>
                            {i > 0 && ', '}
                            {src?.url ? (
                              <a href={src.url} target="_blank" rel="noreferrer" title={src.title}>
                                {sid}
                              </a>
                            ) : (
                              sid
                            )}
                          </span>
                        )
                      })}
                    </div>
                  )}
                </td>
                <td className="mono xsmall">
                  {e.value}
                  {e.tolerance ? ` ±${e.tolerance}` : ''} {e.unit ?? 'mm'}
                </td>
                <td>
                  <span className="badge" style={{ color: GRADE_COLOR[e.grade] }} title={GRADE_LABEL[e.grade]}>
                    {e.grade}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details style={{ marginTop: 10 }}>
        <summary>参照した資料 ({model.sources.size} 件)</summary>
        <table className="grid">
          <tbody>
            {[...model.sources.values()].map((s) => (
              <tr key={s.id}>
                <td>
                  <div className="xsmall mono">{s.id}</div>
                  <div className="xsmall">
                    {s.url ? (
                      <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a>
                    ) : (
                      s.title
                    )}
                  </div>
                  <div className="xsmall muted">
                    {s.publisher}
                    {s.partNumber ? ` / ${s.partNumber}` : ''}
                    {s.docDate ? ` / ${s.docDate}` : ''}
                    {s.accessed ? ` / 取得 ${s.accessed}` : ''}
                  </div>
                  {s.usedFor && <div className="xsmall muted">用途: {s.usedFor}</div>}
                  {s.usageTerms && <div className="xsmall muted">利用条件: {s.usageTerms}</div>}
                </td>
                <td style={{ width: 84 }}>
                  <span className="badge muted">{s.reliability}</span>
                  {s.fetchStatus && (
                    <div className="xsmall muted" style={{ marginTop: 2 }}>
                      {s.fetchStatus}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <div className="xsmall muted" style={{ marginTop: 8, lineHeight: 1.6 }}>
        FACT=一次資料に直接記載 / DERIVED=図面や記載寸法から幾何学的に導出 /
        ASSUMPTION=資料が無いため明示した仮定 / UNKNOWN=未確認。
        内部接点の寸法はメーカー外形図には含まれないため、DERIVED または ASSUMPTION である。
      </div>
    </div>
  )
}
