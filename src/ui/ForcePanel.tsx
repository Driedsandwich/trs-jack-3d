import { useMemo } from 'react'
import { useAppStore, useModel } from '../store/useAppStore'
import { computeForceCurve } from '../model/force'

export function ForcePanel() {
  const model = useModel()
  const depthMm = useAppStore((s) => s.depthMm)
  const faults = useAppStore((s) => s.faults)
  const setDepth = useAppStore((s) => s.setDepth)

  const curve = useMemo(
    () => computeForceCurve(model.jack, model.plug, faults, model.contactCfg, model.forceCfg, 0.02, -1),
    [model, faults],
  )

  const W = 396
  const H = 130
  const pad = { l: 30, r: 8, t: 8, b: 18 }
  const xMin = curve[0].depthMm
  const xMax = curve[curve.length - 1].depthMm
  const yMax = Math.max(
    1,
    ...curve.map((c) => Math.max(c.insertionN, c.withdrawalN)),
  ) * 1.15

  const px = (d: number) => pad.l + ((d - xMin) / (xMax - xMin)) * (W - pad.l - pad.r)
  const py = (f: number) => H - pad.b - (f / yMax) * (H - pad.t - pad.b)

  const path = (key: 'insertionN' | 'withdrawalN') =>
    curve.map((c, i) => `${i === 0 ? 'M' : 'L'} ${px(c.depthMm).toFixed(1)} ${py(c[key]).toFixed(1)}`).join(' ')

  const peakIns = Math.max(...curve.map((c) => c.insertionN))
  const peakWd = Math.max(...curve.map((c) => c.withdrawalN))
  const nowIns = model.force(depthMm, faults)

  const specLo = model.dims.entry('jack.spec.insertionForceMin').value
  const specHi = model.dims.entry('jack.spec.insertionForceMax').value
  const inRange = peakIns >= specLo && peakIns <= specHi

  return (
    <div className="card">
      <h2>推定挿抜力 (近似モデル・実測値ではない)</h2>

      <svg
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="挿抜力曲線"
        style={{ display: 'block', cursor: 'crosshair' }}
        onClick={(e) => {
          const r = (e.target as SVGElement).ownerSVGElement?.getBoundingClientRect()
          if (!r) return
          const t = ((e.clientX - r.left) / r.width) * W
          const d = xMin + ((t - pad.l) / (W - pad.l - pad.r)) * (xMax - xMin)
          setDepth(d)
        }}
      >
        {/* メーカー公称レンジの帯 */}
        <rect
          x={pad.l}
          y={py(specHi)}
          width={W - pad.l - pad.r}
          height={Math.max(0, py(specLo) - py(specHi))}
          fill="#22c55e"
          opacity={0.09}
        />
        <line x1={pad.l} y1={py(specLo)} x2={W - pad.r} y2={py(specLo)} stroke="#22c55e" strokeWidth={0.8} strokeDasharray="4 3" />
        <line x1={pad.l} y1={py(specHi)} x2={W - pad.r} y2={py(specHi)} stroke="#22c55e" strokeWidth={0.8} strokeDasharray="4 3" />

        <line x1={pad.l} y1={H - pad.b} x2={W - pad.r} y2={H - pad.b} stroke="#334155" />
        <line x1={pad.l} y1={pad.t} x2={pad.l} y2={H - pad.b} stroke="#334155" />

        <path d={path('insertionN')} stroke="#38bdf8" strokeWidth={1.8} fill="none" />
        <path d={path('withdrawalN')} stroke="#f472b6" strokeWidth={1.6} fill="none" strokeDasharray="5 3" />

        <line x1={px(depthMm)} y1={pad.t} x2={px(depthMm)} y2={H - pad.b} stroke="#fbbf24" strokeWidth={1.2} />

        <text x={2} y={py(yMax) + 9} fontSize={9} fill="#94a3b8">{yMax.toFixed(0)}N</text>
        <text x={2} y={H - pad.b} fontSize={9} fill="#94a3b8">0</text>
        <text x={pad.l} y={H - 5} fontSize={9} fill="#94a3b8">{xMin.toFixed(0)}mm</text>
        <text x={W - pad.r - 24} y={H - 5} fontSize={9} fill="#94a3b8">{xMax.toFixed(1)}</text>
      </svg>

      <div className="legend" style={{ marginTop: 4 }}>
        <span><span className="swatch" style={{ background: '#38bdf8' }} />挿入力</span>
        <span><span className="swatch" style={{ background: '#f472b6' }} />抜去力 (破線)</span>
        <span><span className="swatch" style={{ background: '#22c55e', opacity: 0.4 }} />公称 {specLo}–{specHi} N</span>
      </div>

      <table className="grid" style={{ marginTop: 8 }}>
        <tbody>
          <tr>
            <td>現在深度の推定挿入力</td>
            <td className="mono">{nowIns.insertionN.toFixed(2)} N</td>
          </tr>
          <tr>
            <td>現在深度の推定抜去力</td>
            <td className="mono">{nowIns.withdrawalN.toFixed(2)} N</td>
          </tr>
          <tr>
            <td>挿入ピーク</td>
            <td className="mono">{peakIns.toFixed(2)} N</td>
          </tr>
          <tr>
            <td>抜去ピーク</td>
            <td className="mono">{peakWd.toFixed(2)} N</td>
          </tr>
        </tbody>
      </table>

      <div className={inRange ? 'warnbox okbox' : 'warnbox'} style={{ marginTop: 8 }}>
        {inRange
          ? `挿入ピーク ${peakIns.toFixed(2)} N はメーカー公称の ${specLo}〜${specHi} N の範囲内。`
          : `挿入ピーク ${peakIns.toFixed(2)} N は公称 ${specLo}〜${specHi} N の範囲外。故障パラメータの影響。`}
      </div>

      <div className="xsmall muted" style={{ marginTop: 6, lineHeight: 1.6 }}>
        有限要素解析は行っていない。摩擦係数とばね定数は公称挿抜力レンジに合うよう置いた仮定値であり、
        実物と同一のばね力を再現したものではない。曲線の形 (入口摩擦・テーパ乗り越えの局所ピーク・
        完全挿入位置の保持・抜去時のヒステリシス) はエネルギー法から導いている。
      </div>
    </div>
  )
}
