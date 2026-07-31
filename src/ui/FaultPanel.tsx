import { DEFAULT_FAULTS } from '../model/contact'
import { useAppStore, useModel } from '../store/useAppStore'

function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  hint,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  onChange: (v: number) => void
  hint?: string
}) {
  return (
    <div style={{ marginBottom: 7 }}>
      <div className="spread xsmall">
        <span className="muted">{label}</span>
        <span className="mono">
          {value.toFixed(step < 0.1 ? 2 : 1)}
          {unit ?? ''}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
      />
      {hint && <div className="xsmall muted" style={{ marginTop: -2 }}>{hint}</div>}
    </div>
  )
}

export function FaultPanel() {
  const model = useModel()
  const faults = useAppStore((s) => s.faults)
  const setFaults = useAppStore((s) => s.setFaults)
  const applyPreset = useAppStore((s) => s.applyPreset)
  const activePresetId = useAppStore((s) => s.activePresetId)

  return (
    <div className="card">
      <h2>故障・接続不良プリセット</h2>

      <div className="tabs">
        {model.faultPresets.map((p) => (
          <button
            key={p.id}
            data-active={activePresetId === p.id}
            onClick={() => applyPreset(p.id)}
            title={p.description}
          >
            {p.label}
          </button>
        ))}
      </div>

      {activePresetId && (
        <div className="xsmall muted" style={{ marginBottom: 8 }}>
          {model.faultPresets.find((p) => p.id === activePresetId)?.description}
        </div>
      )}

      <details>
        <summary>パラメータを個別に調整</summary>

        <Slider
          label="汚れ・酸化"
          value={faults.contamination}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => setFaults({ contamination: v })}
          hint="1.0 で接触面が完全に絶縁される"
        />
        <Slider
          label="接点摩耗"
          value={faults.wear}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => setFaults({ wear: v })}
          hint="接触ドームが減り、押付が落ちる"
        />
        <Slider
          label="ばね押付倍率"
          value={faults.springForceScale}
          min={0.1}
          max={1.5}
          step={0.01}
          onChange={(v) => setFaults({ springForceScale: v })}
        />
        <Slider
          label="軸ずれ"
          value={faults.lateralOffsetMm}
          min={-0.6}
          max={0.6}
          step={0.01}
          unit=" mm"
          onChange={(v) => setFaults({ lateralOffsetMm: v })}
          hint="正常モードでは 0。位置ずれモードでのみ有効"
        />
        <Slider
          label="傾き"
          value={faults.tiltDeg}
          min={-4}
          max={4}
          step={0.1}
          unit="°"
          onChange={(v) => setFaults({ tiltDeg: v })}
        />
        <Slider
          label="プラグ軸回転"
          value={faults.rotationDeg}
          min={0}
          max={360}
          step={1}
          unit="°"
          onChange={(v) => setFaults({ rotationDeg: v })}
          hint="理想的な同心接点では接続は変わらない。汚れ・摩耗がある場合のみ影響する"
        />

        <div className="row" style={{ marginTop: 8 }}>
          <button
            data-active={faults.intermittent}
            onClick={() => setFaults({ intermittent: !faults.intermittent })}
          >
            断続接触 {faults.intermittent ? 'ON' : 'OFF'}
          </button>
          {faults.intermittent && (
            <>
              <span className="xsmall muted">シード</span>
              <input
                type="number"
                value={faults.seed}
                onChange={(e) => setFaults({ seed: Number(e.target.value) })}
                style={{ width: 68 }}
                aria-label="乱数シード"
              />
            </>
          )}
        </div>
        {faults.intermittent && (
          <Slider
            label="断続の強さ"
            value={faults.intermittentAmplitude}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => setFaults({ intermittentAmplitude: v })}
            hint="ノイズは深度のハッシュから作るため、同じ深度なら常に同じ値になる (再現可能)"
          />
        )}

        <button style={{ marginTop: 8 }} onClick={() => setFaults({ ...DEFAULT_FAULTS })}>
          パラメータを初期化
        </button>
      </details>

      <div className="xsmall muted" style={{ marginTop: 8 }}>
        故障は正常モデルを書き換えず、パラメータとして重ねている。既定では乱数は無効。
      </div>
    </div>
  )
}
