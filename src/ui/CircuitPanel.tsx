import { STATE_COLOR } from '../three/materials'
import { useModel } from '../store/useAppStore'
import { useEvaluation } from '../store/useEvaluation'
import type { PlugNet } from '../model/types'

const NET_ORDER: PlugNet[] = ['TIP', 'RING', 'RING2', 'SLEEVE']
const NET_LABEL: Record<PlugNet, string> = {
  TIP: 'Plug Tip',
  RING: 'Plug Ring',
  RING2: 'Plug Ring 2',
  SLEEVE: 'Plug Sleeve',
}

export function CircuitPanel() {
  const model = useModel()
  const ev = useEvaluation()

  const nets = NET_ORDER.filter((n) => model.plug.segments.some((s) => s.net === n))
  const terminals = model.jack.terminals

  const W = 400
  const rowH = 30
  const H = Math.max(nets.length, terminals.length) * rowH + 26
  const leftX = 82
  const termW = 152
  const rightX = W - termW - 6

  const netY = (i: number) => 20 + i * rowH + rowH / 2
  const termY = (i: number) => 20 + i * rowH + rowH / 2

  // 接点ごとの結線 (ばね → 端子 は内部配線なので端子とばねを同一視して描く)
  const links: { netIdx: number; termIdx: number; color: string; dashed: boolean; label: string }[] = []
  for (const c of ev.contacts) {
    const termIdx = terminals.findIndex((t) => t.id === c.terminalId)
    if (termIdx < 0) continue
    for (const net of c.connectedNets) {
      const netIdx = nets.indexOf(net)
      if (netIdx < 0) continue
      links.push({
        netIdx,
        termIdx,
        color: STATE_COLOR[c.state],
        dashed: c.state === 'TOUCH_UNSTABLE',
        label: c.contactId,
      })
    }
    // ブレーク接点が閉じているとき、信号端子とノーマル端子が内部でつながる
    const jc = model.jack.contacts.find((x) => x.id === c.contactId)
    if (jc?.breakContact && c.breakState === 'BREAK_CLOSED') {
      const nIdx = terminals.findIndex((t) => t.id === jc.breakContact!.terminalId)
      if (nIdx >= 0) {
        links.push({ netIdx: -1 - nIdx, termIdx, color: '#22c55e', dashed: false, label: jc.breakContact.id })
      }
    }
  }

  const acoustic = ev.acoustic
  const boxClass =
    acoustic.severity === 'ok' ? 'warnbox okbox' : acoustic.severity === 'bad' ? 'warnbox badbox' : 'warnbox'

  return (
    <div className="card">
      <h2>電気回路 (TRS 標準: Tip=Left / Ring=Right / Sleeve=帰線)</h2>

      <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="接続グラフ" style={{ display: 'block' }}>
        {/* 端子間 (ブレーク接点) の結線 */}
        {links
          .filter((l) => l.netIdx < 0)
          .map((l, i) => {
            const y1 = termY(l.termIdx)
            const y2 = termY(-1 - l.netIdx)
            // 端子ボックスの手前に、内部スイッチを表す縦のブラケットを描く
            const x = rightX - 14
            return (
              <g key={`b${i}`}>
                <path
                  d={`M ${rightX - 6} ${y1} L ${x} ${y1} L ${x} ${y2} L ${rightX - 6} ${y2}`}
                  stroke={l.color}
                  strokeWidth={2}
                  fill="none"
                />
                <circle cx={x} cy={(y1 + y2) / 2} r={2.6} fill={l.color} />
              </g>
            )
          })}
        {/* プラグ導体 ↔ 端子 */}
        {links
          .filter((l) => l.netIdx >= 0)
          .map((l, i) => {
            const y1 = netY(l.netIdx)
            const y2 = termY(l.termIdx)
            const mid = (leftX + rightX) / 2
            return (
              <path
                key={`l${i}`}
                d={`M ${leftX + 4} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${rightX - 20} ${y2}`}
                stroke={l.color}
                strokeWidth={2.4}
                strokeDasharray={l.dashed ? '5 4' : undefined}
                fill="none"
              />
            )
          })}

        {/* プラグ導体 */}
        {nets.map((n, i) => (
          <g key={n}>
            <rect x={4} y={netY(i) - 11} width={78} height={22} rx={5} fill="#0d1526" stroke="#334155" />
            <text x={43} y={netY(i) + 4} fontSize={11} fill="#e2e8f0" textAnchor="middle">
              {NET_LABEL[n]}
            </text>
          </g>
        ))}

        {/* ジャック端子 */}
        {terminals.map((t, i) => (
          <g key={t.id}>
            <rect x={rightX - 6} y={termY(i) - 11} width={termW} height={22} rx={5} fill="#0d1526" stroke="#334155" />
            <text x={rightX + 4} y={termY(i) + 4} fontSize={10} fill="#e2e8f0" textAnchor="start">
              {t.pin ? `${t.pin}: ` : ''}
              {t.label}
            </text>
          </g>
        ))}
      </svg>

      <div className="mono xsmall" style={{ marginTop: 8, lineHeight: 1.75 }}>
        {ev.circuit.lines.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>

      <div className={boxClass} style={{ marginTop: 10 }}>
        <div style={{ fontWeight: 650 }}>音響上の予測: {acoustic.label}</div>
        <div className="xsmall" style={{ marginTop: 2 }}>{acoustic.detail}</div>
        <div className="xsmall muted" style={{ marginTop: 4 }}>
          これは回路接続からの簡易推定であり、特定製品の実際の音を保証するものではない。
        </div>
      </div>
    </div>
  )
}
