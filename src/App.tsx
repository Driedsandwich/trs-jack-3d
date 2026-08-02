import { useEffect, useRef, useState } from 'react'
import { Scene } from './three/Scene'
import { InsertionControls } from './ui/InsertionControls'
import { ContactTable } from './ui/ContactTable'
import { CircuitPanel } from './ui/CircuitPanel'
import { Timeline } from './ui/Timeline'
import { ViewPanel } from './ui/ViewPanel'
import { FaultPanel } from './ui/FaultPanel'
import { ForcePanel } from './ui/ForcePanel'
import { EvidencePanel } from './ui/EvidencePanel'
import { jackInfo, plugInfo, splitVariantId } from './data'
import { useAppStore, useModel } from './store/useAppStore'
import { useEvaluation } from './store/useEvaluation'
import { STATE_COLOR, STATE_LABEL, STATE_SYMBOL } from './three/materials'

function Hud() {
  const model = useModel()
  const depthMm = useAppStore((s) => s.depthMm)
  const ev = useEvaluation()
  const sev =
    ev.anyBridged || ev.anyWrongSegment ? 'var(--bad)' : ev.anyUnstable ? 'var(--warn)' : 'var(--ok)'

  return (
    <div className="hud">
      <div className="big mono">
        {depthMm.toFixed(2)} mm{' '}
        <span className="muted" style={{ fontSize: 13 }}>
          ({model.toPercent(depthMm).toFixed(1)}%)
        </span>
      </div>
      <div className="small" style={{ color: sev, fontWeight: 600 }}>
        {ev.acoustic.label}
      </div>
      <div className="xsmall" style={{ marginTop: 4 }}>
        {ev.contacts.map((c) => (
          <div key={c.contactId} style={{ color: STATE_COLOR[c.state] }}>
            {STATE_SYMBOL[c.state]} {c.label}: {STATE_LABEL[c.state]}
            {c.connectedNets.length > 0 && ` → ${c.connectedNets.join('+')}`}
            {c.breakState && (
              <span className="muted"> / SW {c.breakState === 'BREAK_OPEN' ? 'OPEN' : 'CLOSED'}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

const TABS = [
  { id: 'contacts', label: '接点' },
  { id: 'circuit', label: '回路' },
  { id: 'events', label: 'イベント' },
  { id: 'faults', label: '故障' },
  { id: 'force', label: '力' },
  { id: 'evidence', label: '根拠' },
] as const
type TabId = (typeof TABS)[number]['id']

export default function App() {
  const model = useModel()
  const nudge = useAppStore((s) => s.nudgeDepth)
  const [tab, setTab] = useState<TabId>('contacts')
  const viewportRef = useRef<HTMLDivElement>(null)

  // Shift + ホイールで深度を微調整 (通常のホイールは OrbitControls のズーム)
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.shiftKey) return
      e.preventDefault()
      e.stopPropagation()
      nudge(-Math.sign(e.deltaY) * 0.05)
    }
    el.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => el.removeEventListener('wheel', onWheel, { capture: true } as never)
  }, [nudge])

  // 両側が実在部品の実測に基づくときだけ「実在の一例」と名乗る
  const [plugId, jackId] = splitVariantId(useAppStore((s) => s.variantId))
  const realPair = plugInfo(plugId).basis === 'measured-part' && jackInfo(jackId).basis === 'measured-part'

  return (
    <div className="app">
      <header className="topbar">
        <h1>3.5&nbsp;mm TRS 接合機構ビューア</h1>
        <span className="sub">
          プラグ {model.plug.manufacturer} {model.plug.partNumber} / ジャック {model.jack.manufacturer}{' '}
          {model.jack.partNumber} —{' '}
          {/*
            **「実在する代表的な一例」と名乗ってよいのは、両側が実在部品のときだけ。**
            2026-08-02 に 4極ジャックを構成モデルのまま選んでも同じ文が出ていた。
            画面の一番目立つ行なので、ここが嘘だと他の注意書きが効かない。
          */}
          {realPair ? '実在する代表的な 3.5\u00a0mm TRS 接続の一例' : '構成モデルを含む (実在部品そのものではない)'}
        </span>
      </header>

      <div className="viewport" ref={viewportRef}>
        <Scene />
        <Hud />
      </div>

      <aside className="sidebar">
        <InsertionControls />
        <ViewPanel />

        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.id} data-active={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'contacts' && <ContactTable />}
        {tab === 'circuit' && <CircuitPanel />}
        {tab === 'events' && <Timeline />}
        {tab === 'faults' && <FaultPanel />}
        {tab === 'force' && <ForcePanel />}
        {tab === 'evidence' && <EvidencePanel />}
      </aside>
    </div>
  )
}
