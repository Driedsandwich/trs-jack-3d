import { GRADE_COLOR, GRADE_LABEL } from '../three/materials'
import { useAppStore, useModel } from '../store/useAppStore'
import type { ViewMode } from '../store/useAppStore'
import type { Grade } from '../model/types'
import { jackInfo, listJackVariants, listPlugVariants, plugInfo, splitVariantId } from '../data'

const MODES: { id: ViewMode; label: string }[] = [
  { id: 'normal', label: '通常外観' },
  { id: 'translucent', label: '半透明外装' },
  { id: 'transparent', label: '完全透明外装' },
  { id: 'section', label: '断面' },
  { id: 'section-drag', label: '断面 (可動)' },
  { id: 'exploded', label: '分解' },
  { id: 'contacts-only', label: '接点のみ' },
  { id: 'wireframe', label: 'ワイヤーフレーム' },
]

export function ViewPanel() {
  const model = useModel()
  const s = useAppStore()
  const [plugId, jackId] = splitVariantId(s.variantId)
  const mixed = model.plug.poleCount !== model.jack.contacts.length

  return (
    <div className="card">
      <h2>表示</h2>

      <div className="tabs">
        {MODES.map((m) => (
          <button
            key={m.id}
            data-active={s.viewMode === m.id}
            onClick={() => {
              s.setViewMode(m.id)
              if (m.id === 'exploded') s.patch({ explodeAmount: 1 })
              else if (s.explodeAmount > 0) s.patch({ explodeAmount: 0 })
            }}
          >
            {m.label}
          </button>
        ))}
      </div>

      {(s.viewMode === 'section-drag' || s.viewMode === 'section') && (
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="xsmall muted">切断面</span>
          <button data-active={s.clipAxis === 'z'} onClick={() => s.patch({ clipAxis: 'z' })} className="xsmall">
            水平 (XY)
          </button>
          <button data-active={s.clipAxis === 'y'} onClick={() => s.patch({ clipAxis: 'y' })} className="xsmall">
            垂直 (XZ)
          </button>
          {s.viewMode === 'section-drag' && (
            <>
              <input
                type="range"
                min={-6}
                max={6}
                step={0.05}
                value={s.clipPositionMm}
                onChange={(e) => s.patch({ clipPositionMm: Number(e.target.value) })}
                style={{ flex: 1, minWidth: 100 }}
                aria-label="切断面の位置"
              />
              <span className="xsmall mono">{s.clipPositionMm.toFixed(2)} mm</span>
            </>
          )}
        </div>
      )}

      <div className="row" style={{ marginBottom: 8 }}>
        <span className="xsmall muted">分解量</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={s.explodeAmount}
          onChange={(e) => s.patch({ explodeAmount: Number(e.target.value) })}
          style={{ flex: 1, minWidth: 100 }}
          aria-label="分解量"
        />
        <span className="xsmall mono">{(s.explodeAmount * 100).toFixed(0)}%</span>
      </div>

      <div className="row">
        <button data-active={s.glowContacts} onClick={() => s.patch({ glowContacts: !s.glowContacts })}>
          接触箇所を発光
        </button>
        <button data-active={s.showDimensions} onClick={() => s.patch({ showDimensions: !s.showDimensions })}>
          寸法表示
        </button>
        <button data-active={s.showLabels} onClick={() => s.patch({ showLabels: !s.showLabels })}>
          ラベル
        </button>
        <button data-active={s.showGrades} onClick={() => s.patch({ showGrades: !s.showGrades })}>
          根拠区分表示
        </button>
        <button data-active={s.lowQuality} onClick={() => s.patch({ lowQuality: !s.lowQuality })}>
          低負荷モード
        </button>
        <button onClick={() => s.patch({ cameraResetToken: s.cameraResetToken + 1 })}>視点を戻す</button>
      </div>

      {s.showGrades && (
        <div className="legend" style={{ marginTop: 8 }}>
          {(Object.keys(GRADE_COLOR) as Grade[]).map((g) => (
            <span key={g}>
              <span className="swatch" style={{ background: GRADE_COLOR[g] }} />
              {g}: {GRADE_LABEL[g]}
            </span>
          ))}
        </div>
      )}

      <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--line)' }}>
        <div className="row" style={{ marginBottom: 6 }}>
          <span className="xsmall muted" style={{ width: 44 }}>プラグ</span>
          <select
            value={plugId}
            onChange={(e) => s.setPlugVariant(e.target.value as never)}
            style={{ flex: 1, minWidth: 200 }}
          >
            {listPlugVariants().map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <span className="xsmall muted" style={{ width: 44 }}>ジャック</span>
          <select
            value={jackId}
            onChange={(e) => s.setJackVariant(e.target.value as never)}
            style={{ flex: 1, minWidth: 200 }}
          >
            {listJackVariants().map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </div>

        <div className="xsmall muted" style={{ marginTop: 6, lineHeight: 1.55 }}>
          {plugInfo(plugId).description}
        </div>
        <div className="xsmall muted" style={{ marginTop: 4, lineHeight: 1.55 }}>
          {jackInfo(jackId).description}
        </div>

        {mixed && (
          <div className="warnbox" style={{ marginTop: 8 }}>
            極数の違う組み合わせ (プラグ {model.plug.poleCount} 極 / ジャック {model.jack.contacts.length} 極)。
            結線は各接点の軸位置から計算しており、あらかじめ決めた結論ではない。
          </div>
        )}
        {(plugInfo(plugId).basis === 'constructed' || jackInfo(jackId).basis === 'constructed') && (
          <div className="warnbox" style={{ marginTop: 8 }}>
            この構成には、一次図面で寸法を確認できていない部分 (ASSUMPTION) が含まれる。
            「根拠」タブの trrs.* キーを参照。
          </div>
        )}
      </div>
    </div>
  )
}
