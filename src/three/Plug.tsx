import { useMemo } from 'react'
import * as THREE from 'three'
import { Text } from '@react-three/drei'
import { buildPlugHandle, buildPlugSegments } from './geometry/plugGeometry'
import { materialPropsFor, GRADE_COLOR, STATE_COLOR } from './materials'
import { useAppStore, useModel } from '../store/useAppStore'
import { useEvaluation } from '../store/useEvaluation'
import type { ContactResult } from '../model/types'
import { LABEL_FONT } from './labelFont'

/** どのセグメントを光らせるか: そのセグメントに接している接点の状態から決める */
function segmentHighlight(segId: string, contacts: ContactResult[], glow: boolean) {
  if (!glow) return undefined
  const touching = contacts.filter((c) => c.overlaps.some((o) => o.segmentId === segId))
  if (touching.length === 0) return undefined
  // 最も深刻な状態を優先
  const priority: ContactResult['state'][] = [
    'BRIDGED',
    'WRONG_SEGMENT',
    'TOUCH_UNSTABLE',
    'CLOSED',
    'INSULATED',
    'OPEN',
    'UNKNOWN',
  ]
  const worst = priority.find((p) => touching.some((c) => c.state === p)) ?? 'OPEN'
  if (worst === 'OPEN') return undefined
  const q = Math.max(...touching.map((c) => c.quality))
  return { color: STATE_COLOR[worst], intensity: worst === 'CLOSED' ? 0.1 + 0.2 * q : 0.45 }
}

export function Plug({ onPointerDown }: { onPointerDown?: (e: unknown) => void }) {
  const model = useModel()
  const depthMm = useAppStore((s) => s.depthMm)
  const viewMode = useAppStore((s) => s.viewMode)
  const explode = useAppStore((s) => s.explodeAmount)
  const showGrades = useAppStore((s) => s.showGrades)
  const showLabels = useAppStore((s) => s.showLabels)
  const glow = useAppStore((s) => s.glowContacts)
  const faults = useAppStore((s) => s.faults)
  const ev = useEvaluation()

  const segs = useMemo(() => buildPlugSegments(model.plug), [model])
  const handle = useMemo(() => buildPlugHandle(model.plug), [model])

  // プラグ先端が X = depthMm に来るように、プラグ座標 s を X = depthMm - s に写す。
  // 3D 上は「s が増える = -X 方向」。プラグ全体を depthMm に置き、内部は -s で並べる。
  const rot = (faults.rotationDeg * Math.PI) / 180
  const lateral = faults.lateralOffsetMm
  const tilt = (faults.tiltDeg * Math.PI) / 180

  return (
    <group
      position={[depthMm, lateral, 0]}
      rotation={[rot, 0, -tilt]}
      onPointerDown={onPointerDown as never}
      name="plug-assembly"
    >
      {/* 指部の各セグメント。Tip/絶縁/Ring/絶縁/Sleeve は独立オブジェクト */}
      {segs.map(({ segment, geometry }) => {
        const mat = model.materialOf(segment.material)
        const hl = segmentHighlight(segment.id, ev.contacts, glow)
        const props = materialPropsFor(mat, {
          viewMode,
          isShell: false,
          isContact: false,
          isPlugConductor: true,
          highlight: hl,
          gradeColor: showGrades ? GRADE_COLOR[segment.grade] : undefined,
        })
        // 分解表示: セグメントを軸方向に広げる
        const mid = (segment.startMm + segment.endMm) / 2
        const ex = explode * (mid / model.plug.fingerLengthMm) * 6
        return (
          <mesh key={segment.id} geometry={geometry} position={[-ex, 0, 0]} name={`plug-${segment.id}`}>
            <meshStandardMaterial {...props} side={THREE.DoubleSide} />
          </mesh>
        )
      })}

      {/* 肩・絶縁支持体・ハンドル・ケーブル (表示専用) */}
      {(
        [
          ['shoulder', handle.shoulder, handle.offsets.shoulder, 'plug-contact-metal'],
          ['support', handle.insulatorSupport, handle.offsets.insulatorSupport, 'plug-insulator'],
          ['body', handle.body, handle.offsets.body, 'plug-jacket'],
          ['strain', handle.strainRelief, handle.offsets.strainRelief, 'plug-jacket'],
          ['cable', handle.cable, handle.offsets.cable, 'plug-cable'],
        ] as const
      ).map(([id, geo, off, matId]) => {
        const mat = model.materialOf(matId)
        const props = materialPropsFor(mat, {
          viewMode,
          isShell: false,
          isContact: false,
          gradeColor: showGrades ? GRADE_COLOR['ASSUMPTION'] : undefined,
        })
        return (
          <mesh key={id} geometry={geo} position={[-off - explode * 8, 0, 0]} name={`plug-${id}`}>
            <meshStandardMaterial {...props} />
          </mesh>
        )
      })}

      {/* セグメントのラベル */}
      {showLabels &&
        segs
          .filter(({ segment }) => segment.kind === 'conductor')
          .map(({ segment }) => {
            const mid = (segment.startMm + segment.endMm) / 2
            return (
              <Text
        font={LABEL_FONT}
                key={`lbl-${segment.id}`}
                position={[-mid, -(model.plug.bodyRadiusMm + 1.4), 0]}
                fontSize={0.85}
                color="#e2e8f0"
                anchorX="center"
                anchorY="top"
                outlineWidth={0.06}
                outlineColor="#0b1220"
              >
                {segment.net ?? segment.id}
              </Text>
            )
          })}
    </group>
  )
}
