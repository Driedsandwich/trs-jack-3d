import { useEffect, useState } from 'react'
import { useAppStore, useModel } from '../store/useAppStore'
import { useEvaluation } from '../store/useEvaluation'

const STEPS = [0.01, 0.05, 0.2, 1]

export function InsertionControls() {
  const model = useModel()
  const depthMm = useAppStore((s) => s.depthMm)
  const animating = useAppStore((s) => s.animating)
  const paused = useAppStore((s) => s.paused)
  const speed = useAppStore((s) => s.animationSpeedMmPerSec)
  const setDepth = useAppStore((s) => s.setDepth)
  const nudge = useAppStore((s) => s.nudgeDepth)
  const patch = useAppStore((s) => s.patch)
  const ev = useEvaluation()

  const [step, setStep] = useState(0.05)
  const [entry, setEntry] = useState('')

  const min = -(model.plug.fingerLengthMm + 2)
  const max = model.fullDepthMm

  // キーボード操作
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return
      const fine = e.altKey ? 0.01 : e.shiftKey ? 0.5 : step
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowUp':
          e.preventDefault()
          nudge(fine)
          break
        case 'ArrowLeft':
        case 'ArrowDown':
          e.preventDefault()
          nudge(-fine)
          break
        case 'Home':
          e.preventDefault()
          setDepth(min)
          break
        case 'End':
          e.preventDefault()
          setDepth(max)
          break
        case ' ':
          e.preventDefault()
          if (useAppStore.getState().animating === 'none') useAppStore.getState().autoInsert()
          else useAppStore.getState().togglePause()
          break
        case 'r':
        case 'R':
          e.preventDefault()
          useAppStore.getState().reset()
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nudge, setDepth, step, min, max])

  const pct = model.toPercent(depthMm)

  return (
    <div className="card">
      <h2>挿抜操作</h2>

      <div className="spread">
        <span className="mono big" style={{ fontSize: 20, fontWeight: 650 }}>
          {depthMm.toFixed(2)} <span className="muted small">mm</span>
        </span>
        <span className="mono muted">{pct.toFixed(1)} %</span>
      </div>

      <input
        type="range"
        min={min}
        max={max}
        step={0.01}
        value={depthMm}
        onChange={(e) => setDepth(Number(e.target.value))}
        aria-label="挿入深度"
        style={{ marginTop: 6 }}
      />
      <div className="spread xsmall muted" style={{ marginTop: -2 }}>
        <span>{min.toFixed(1)} mm (完全抜去)</span>
        <span>0 (前面)</span>
        <span>{max.toFixed(2)} mm (完全挿入)</span>
      </div>

      <div className="row" style={{ marginTop: 9 }}>
        <button onClick={() => nudge(-step)} title="浅くする">−{step}</button>
        <button onClick={() => nudge(step)} title="深くする">＋{step}</button>
        <span className="xsmall muted">刻み</span>
        {STEPS.map((s) => (
          <button key={s} data-active={step === s} onClick={() => setStep(s)} className="xsmall">
            {s}
          </button>
        ))}
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={() => useAppStore.getState().autoWithdraw()} data-active={animating === 'withdrawing'}>
          ◀ 自動抜去
        </button>
        <button onClick={() => useAppStore.getState().autoInsert()} data-active={animating === 'inserting'}>
          自動挿入 ▶
        </button>
        <button onClick={() => useAppStore.getState().togglePause()} disabled={animating === 'none'}>
          {paused ? '再開' : '一時停止'}
        </button>
        <button onClick={() => useAppStore.getState().reset()}>リセット</button>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <span className="xsmall muted">速度</span>
        <input
          type="range"
          min={0.5}
          max={20}
          step={0.5}
          value={speed}
          onChange={(e) => patch({ animationSpeedMmPerSec: Number(e.target.value) })}
          style={{ flex: 1, minWidth: 90 }}
        />
        <span className="xsmall mono">{speed.toFixed(1)} mm/s</span>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <span className="xsmall muted">深度を入力</span>
        <input
          type="number"
          step={0.01}
          min={min}
          max={max}
          value={entry}
          placeholder={depthMm.toFixed(2)}
          onChange={(e) => setEntry(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && entry !== '') {
              setDepth(Number(entry))
              setEntry('')
            }
          }}
          style={{ width: 82 }}
          aria-label="挿入深度を mm で入力"
        />
        <span className="xsmall muted">mm</span>
        <button
          onClick={() => {
            if (entry !== '') {
              setDepth(Number(entry))
              setEntry('')
            }
          }}
        >
          移動
        </button>
        <button onClick={() => setDepth(model.fromPercent(50))} className="xsmall">50%</button>
      </div>

      <div className="xsmall muted" style={{ marginTop: 8, lineHeight: 1.6 }}>
        3D 上でプラグを直接ドラッグしても動きます。キーボード: ←/→ で微調整
        (Shift=0.5mm / Alt=0.01mm)、Home/End、Space で自動挿入・一時停止、R でリセット。
        ビューポート上で Shift+ホイールでも深度を動かせます。
      </div>

      <div className="spread small" style={{ marginTop: 9, paddingTop: 8, borderTop: '1px solid var(--line)' }}>
        <span className="muted">推定挿入力 (実測値ではない)</span>
        <span className="mono">{ev.estimatedForceN.toFixed(2)} N</span>
      </div>
    </div>
  )
}
