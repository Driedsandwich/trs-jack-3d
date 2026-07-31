import { useEffect, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Line, Text } from '@react-three/drei'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { Plug } from './Plug'
import { Jack } from './Jack'
import { STATE_COLOR } from './materials'
import { useAppStore, useModel } from '../store/useAppStore'
import { useEvaluation } from '../store/useEvaluation'
import { LABEL_FONT } from './labelFont'

// ---------------------------------------------------------------------------
// 断面クリッピング
// ---------------------------------------------------------------------------

function Clipping() {
  const gl = useThree((s) => s.gl)
  const viewMode = useAppStore((s) => s.viewMode)
  const clipPos = useAppStore((s) => s.clipPositionMm)
  const clipAxis = useAppStore((s) => s.clipAxis)

  useEffect(() => {
    gl.localClippingEnabled = true
    if (viewMode === 'section' || viewMode === 'section-drag') {
      const normal = clipAxis === 'z' ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, -1, 0)
      gl.clippingPlanes = [new THREE.Plane(normal, viewMode === 'section' ? 0 : clipPos)]
    } else {
      gl.clippingPlanes = []
    }
    return () => {
      gl.clippingPlanes = []
    }
  }, [gl, viewMode, clipPos, clipAxis])
  return null
}

// ---------------------------------------------------------------------------
// アニメーション駆動
// ---------------------------------------------------------------------------

function Ticker() {
  const tick = useAppStore((s) => s.tick)
  useFrame((_, dt) => tick(Math.min(dt, 0.05)))
  return null
}

/** 開発時のみ: ブラウザから描画状態を検査できるようにする */
function DebugBridge() {
  const state = useThree()
  useEffect(() => {
    if (import.meta.env.DEV) {
      ;(window as unknown as { __r3fState?: unknown }).__r3fState = state
    }
  }, [state])
  return null
}

// ---------------------------------------------------------------------------
// 接触点マーカー: 実際の接触位置に球を置き、状態で色と大きさを変える
// ---------------------------------------------------------------------------

function ContactMarkers() {
  const model = useModel()
  const ev = useEvaluation()
  const glow = useAppStore((s) => s.glowContacts)
  const ref = useRef<THREE.Group>(null)

  // 不安定接触は脈動させる (色だけに依存しない表現)
  useFrame((state) => {
    if (!ref.current) return
    const t = state.clock.elapsedTime
    ref.current.children.forEach((child, i) => {
      const res = ev.contacts[i]
      if (!res) return
      const pulse = res.state === 'TOUCH_UNSTABLE' ? 0.7 + 0.5 * Math.sin(t * 9) : 1
      child.scale.setScalar(pulse)
    })
  })

  if (!glow) return null

  return (
    <group ref={ref} name="contact-markers">
      {ev.contacts.map((c) => {
        const jc = model.jack.contacts.find((x) => x.id === c.contactId)!
        const r = jc.freeRadiusMm + c.deflectionMm
        const a = (jc.angularPositionDeg * Math.PI) / 180
        return (
          <mesh
            key={c.contactId}
            position={[jc.axialCenterMm, r * Math.cos(a), r * Math.sin(a)]}
            name={`marker-${c.contactId}`}
          >
            <sphereGeometry args={[c.state === 'OPEN' ? 0.16 : 0.3, 16, 12]} />
            <meshBasicMaterial
              color={STATE_COLOR[c.state]}
              transparent
              opacity={c.state === 'OPEN' ? 0.5 : 0.95}
            />
          </mesh>
        )
      })}
    </group>
  )
}

// ---------------------------------------------------------------------------
// 寸法表示
// ---------------------------------------------------------------------------

function DimensionOverlay() {
  const model = useModel()
  const show = useAppStore((s) => s.showDimensions)
  const depthMm = useAppStore((s) => s.depthMm)
  if (!show) return null

  const L = model.plug.fingerLengthMm
  const R = model.plug.bodyRadiusMm
  const full = model.fullDepthMm
  const yTop = 6.5

  const dim = (
    key: string,
    x0: number,
    x1: number,
    y: number,
    label: string,
    color = '#38bdf8',
  ) => (
    <group key={key}>
      <Line points={[[x0, y, 0], [x1, y, 0]]} color={color} lineWidth={1.5} />
      <Line points={[[x0, y - 0.5, 0], [x0, y + 0.5, 0]]} color={color} lineWidth={1.5} />
      <Line points={[[x1, y - 0.5, 0], [x1, y + 0.5, 0]]} color={color} lineWidth={1.5} />
      <Text
        font={LABEL_FONT}
        position={[(x0 + x1) / 2, y + 0.7, 0]}
        fontSize={0.75}
        color={color}
        anchorX="center"
        anchorY="bottom"
        outlineWidth={0.05}
        outlineColor="#0b1220"
      >
        {label}
      </Text>
    </group>
  )

  return (
    <group name="dimensions">
      {dim('finger', depthMm - L, depthMm, yTop, `指部 ${L.toFixed(1)} mm`)}
      {dim('full', 0, full, yTop + 2.4, `完全挿入深度 ${full.toFixed(2)} mm`, '#a78bfa')}
      {dim('depth', 0, depthMm, yTop + 4.8, `現在深度 ${depthMm.toFixed(2)} mm`, '#f59e0b')}
      {/* 直径 */}
      <Line
        points={[[depthMm - L / 2, -R, 0], [depthMm - L / 2, R, 0]]}
        color="#38bdf8"
        lineWidth={1.5}
      />
      <Text
        font={LABEL_FONT}
        position={[depthMm - L / 2, -R - 1.0, 0]}
        fontSize={0.7}
        color="#38bdf8"
        anchorX="center"
        anchorY="top"
        outlineWidth={0.05}
        outlineColor="#0b1220"
      >
        {`φ${model.plug.bodyDiameterMm.toFixed(2)} mm`}
      </Text>
      {/* 接点の軸位置 */}
      {model.jack.contacts.map((c) => (
        <group key={c.id}>
          <Line
            points={[[c.axialCenterMm, -6.5, 0], [c.axialCenterMm, -4.5, 0]]}
            color="#64748b"
            lineWidth={1}
            dashed
            dashSize={0.3}
            gapSize={0.2}
          />
          <Text
        font={LABEL_FONT}
            position={[c.axialCenterMm, -6.8, 0]}
            fontSize={0.55}
            color="#94a3b8"
            anchorX="center"
            anchorY="top"
          >
            {`${c.id} @${c.axialCenterMm.toFixed(2)}`}
          </Text>
        </group>
      ))}
    </group>
  )
}

// ---------------------------------------------------------------------------
// プラグのドラッグ (軸方向 1 自由度)
// ---------------------------------------------------------------------------

function useAxialDrag(controls: React.RefObject<OrbitControlsImpl | null>) {
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const gl = useThree((s) => s.gl)
  const setDepth = useAppStore((s) => s.setDepth)

  return useMemo(() => {
    return (e: {
      clientX: number
      clientY: number
      pointerId?: number
      nativeEvent?: PointerEvent
      stopPropagation: () => void
    }) => {
      // 2 本目以降の指ではドラッグを始めない (ピンチはカメラ操作に渡す)
      if (e.nativeEvent && e.nativeEvent.isPrimary === false) return

      e.stopPropagation()
      const startX = e.clientX
      const startY = e.clientY
      const startDepth = useAppStore.getState().depthMm
      const pointerId = e.pointerId ?? e.nativeEvent?.pointerId ?? -1

      // 1mm の軸方向移動が NDC 上でどれだけの変位になるか
      const p0 = new THREE.Vector3(0, 0, 0).project(camera)
      const p1 = new THREE.Vector3(1, 0, 0).project(camera)
      const dirX = p1.x - p0.x
      const dirY = p1.y - p0.y
      const len2 = dirX * dirX + dirY * dirY

      /**
       * カメラ操作の抑制は enabled ではなく enableRotate / enablePan で行う。
       *
       * enabled = false にすると OrbitControls が 1 本目の指を登録しないため、
       * あとから 2 本目が触れてもピンチとして認識されず、プラグの上から始めた
       * ピンチが効かなくなる。回転と平行移動だけを止めておけば、
       * OrbitControls は指を数え続けるので 2 本指になった瞬間にズームへ移れる。
       */
      const c0 = controls.current
      if (c0) {
        c0.enableRotate = false
        c0.enablePan = false
      }
      const restoreControls = () => {
        const c = controls.current
        if (c) {
          c.enableRotate = true
          c.enablePan = true
        }
      }

      /** 2 本目の指が触れたら、プラグのドラッグはやめてカメラ操作に譲る */
      const onExtraPointer = (pe: PointerEvent) => {
        if (pe.pointerId === pointerId) return
        cleanup()
        restoreControls()
      }

      const move = (me: PointerEvent) => {
        if (me.pointerId !== pointerId && pointerId !== -1) return
        if (len2 < 1e-8) return // 軸方向を真正面から見ている: ドラッグ不能
        const dx = (2 * (me.clientX - startX)) / size.width
        const dy = (-2 * (me.clientY - startY)) / size.height
        const deltaMm = (dx * dirX + dy * dirY) / len2
        setDepth(startDepth + deltaMm)
      }
      function cleanup() {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        window.removeEventListener('pointerdown', onExtraPointer, true)
      }
      const up = (ue: PointerEvent) => {
        if (ue && ue.pointerId !== pointerId && pointerId !== -1) return
        cleanup()
        restoreControls()
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
      // 2 本目の指を検知するため capture 段階で拾う (OrbitControls より先に走る)
      window.addEventListener('pointerdown', onExtraPointer, true)
    }
  }, [camera, size.width, size.height, setDepth, controls, gl])
}

export const DEFAULT_CAMERA: [number, number, number] = [-14, 16, 34]
export const DEFAULT_TARGET: [number, number, number] = [1, 0, 0]

function CameraReset({ controls }: { controls: React.RefObject<OrbitControlsImpl | null> }) {
  const token = useAppStore((s) => s.cameraResetToken)
  const camera = useThree((s) => s.camera)
  useEffect(() => {
    if (token === 0) return
    camera.position.set(...DEFAULT_CAMERA)
    if (controls.current) {
      controls.current.target.set(...DEFAULT_TARGET)
      controls.current.update()
    }
  }, [token, camera, controls])
  return null
}

function SceneContents() {
  const controls = useRef<OrbitControlsImpl>(null)
  const onPlugPointerDown = useAxialDrag(controls)
  const lowQuality = useAppStore((s) => s.lowQuality)

  return (
    <>
      <color attach="background" args={['#0b1220']} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[18, 24, 16]} intensity={1.5} />
      <directionalLight position={[-14, -8, -12]} intensity={0.5} color="#93c5fd" />
      <hemisphereLight args={['#dbeafe', '#0f172a', 0.5]} />

      <Clipping />
      <Ticker />
      <DebugBridge />
      <Jack />
      <Plug onPointerDown={onPlugPointerDown as never} />
      <ContactMarkers />
      <DimensionOverlay />

      {!lowQuality && (
        <gridHelper args={[120, 60, '#182338', '#101827']} position={[0, -12, 0]} />
      )}

      <CameraReset controls={controls} />
      <OrbitControls
        ref={controls}
        makeDefault
        enableDamping
        dampingFactor={0.12}
        target={DEFAULT_TARGET}
        minDistance={6}
        maxDistance={200}
      />
    </>
  )
}

export function Scene() {
  const lowQuality = useAppStore((s) => s.lowQuality)
  return (
    <Canvas
      camera={{ position: DEFAULT_CAMERA, fov: 40, near: 0.1, far: 600 }}
      dpr={lowQuality ? 1 : [1, 2]}
      gl={{ antialias: !lowQuality, localClippingEnabled: true }}
      frameloop="always"
    >
      <SceneContents />
    </Canvas>
  )
}
