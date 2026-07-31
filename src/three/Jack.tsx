import { useMemo } from 'react'
import * as THREE from 'three'
import { Text } from '@react-three/drei'
import {
  buildContactSpring,
  buildJackHousing,
  buildTerminals,
  deflectionToRotation,
} from './geometry/jackGeometry'
import { materialPropsFor, GRADE_COLOR, STATE_COLOR } from './materials'
import { useAppStore, useModel } from '../store/useAppStore'
import { useEvaluation } from '../store/useEvaluation'
import { LABEL_FONT } from './labelFont'

const SPRING_OPTS = {
  thicknessMm: 0.25,
  widthMm: 1.6,
  rootRadiusMm: 2.75,
  leadInRiseMm: 0.85,
  leadInLengthMm: 1.1,
}

export function Jack() {
  const model = useModel()
  const viewMode = useAppStore((s) => s.viewMode)
  const explode = useAppStore((s) => s.explodeAmount)
  const showGrades = useAppStore((s) => s.showGrades)
  const showLabels = useAppStore((s) => s.showLabels)
  const glow = useAppStore((s) => s.glowContacts)
  const ev = useEvaluation()

  const housing = useMemo(() => buildJackHousing(model.jack), [model])
  const springs = useMemo(
    () => model.jack.contacts.map((c) => buildContactSpring(c, SPRING_OPTS)),
    [model],
  )
  const terminals = useMemo(() => buildTerminals(model.jack), [model])

  const shellMat = model.materialOf('jack-housing')
  const metalMat = model.materialOf('jack-bushing')
  const springMat = model.materialOf('jack-contact-spring')
  const termMat = model.materialOf('jack-terminal')

  const shellProps = materialPropsFor(shellMat, {
    viewMode,
    isShell: true,
    isContact: false,
    gradeColor: showGrades ? GRADE_COLOR['DERIVED'] : undefined,
  })

  return (
    <group name="jack-assembly">
      {/* 絶縁ハウジング前部 (挿入穴あり) */}
      <mesh geometry={housing.frontShell} position={[0, 0, 0]} name="jack-front-shell">
        <meshStandardMaterial {...shellProps} side={THREE.DoubleSide} />
      </mesh>
      {/* 絶縁ハウジング後部 */}
      <mesh
        geometry={housing.rearShell}
        position={[housing.rearShellX + explode * 6, 0, 0]}
        name="jack-rear-shell"
      >
        <meshStandardMaterial {...shellProps} />
      </mesh>
      {/* ボア内壁 */}
      <mesh geometry={housing.bore} position={[housing.boreX, 0, 0]} name="jack-bore">
        <meshStandardMaterial
          {...materialPropsFor(model.materialOf('jack-bore'), {
            viewMode,
            isShell: true,
            isContact: false,
          })}
          side={THREE.BackSide}
        />
      </mesh>
      {/* 金属ブッシング (入口) */}
      <mesh
        geometry={housing.bushing}
        position={[housing.bushingX - explode * 4, 0, 0]}
        name="jack-bushing"
      >
        <meshStandardMaterial
          {...materialPropsFor(metalMat, {
            viewMode,
            isShell: false,
            isContact: false,
            gradeColor: showGrades ? GRADE_COLOR['DERIVED'] : undefined,
          })}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* 基板 */}
      <mesh
        geometry={housing.pcb}
        position={[model.jack.housing.depthMm / 2 - 2, -model.jack.housing.axisHeightFromPcbMm - 0.8, 0]}
        name="pcb"
      >
        <meshStandardMaterial color="#14532d" roughness={0.9} metalness={0} />
      </mesh>

      {/* 接点ばね + ブレーク接点 */}
      {springs.map((sp) => {
        const res = ev.contacts.find((c) => c.contactId === sp.contactId)
        const defl = res?.deflectionMm ?? 0
        const rot = deflectionToRotation(defl, sp.armLengthMm)
        const hl =
          glow && res && res.state !== 'OPEN'
            ? { color: STATE_COLOR[res.state], intensity: res.state === 'CLOSED' ? 0.5 : 0.95 }
            : undefined
        const jc = model.jack.contacts.find((c) => c.id === sp.contactId)!
        const springProps = materialPropsFor(springMat, {
          viewMode,
          isShell: false,
          isContact: true,
          highlight: hl,
          gradeColor: showGrades ? GRADE_COLOR[jc.grade] : undefined,
        })
        const breakOpen = res?.breakState === 'BREAK_OPEN'

        return (
          <group
            key={sp.contactId}
            rotation={[(sp.angularPositionDeg * Math.PI) / 180, 0, 0]}
            name={`spring-group-${sp.contactId}`}
          >
            {/* 可動部: 根元まわりに回転してたわみを表現 */}
            <group
              position={[sp.rootX, sp.rootR + explode * 5, 0]}
              rotation={[0, 0, rot]}
              name={`spring-${sp.contactId}`}
            >
              <mesh geometry={sp.geometry}>
                <meshStandardMaterial {...springProps} side={THREE.DoubleSide} />
              </mesh>
            </group>

            {/* ブレーク接点の固定側 */}
            {sp.breakPad && (
              <mesh
                geometry={sp.breakPad.geometry}
                position={[sp.breakPad.x, sp.breakPad.r + explode * 3, 0]}
                name={`break-${sp.breakPad.id}`}
              >
                <meshStandardMaterial
                  {...materialPropsFor(springMat, {
                    viewMode,
                    isShell: false,
                    isContact: true,
                    highlight: glow
                      ? { color: breakOpen ? '#f97316' : '#22c55e', intensity: 0.75 }
                      : undefined,
                  })}
                />
              </mesh>
            )}

            {/* 根元のリード */}
            <mesh geometry={sp.lead.geometry} position={[sp.lead.x, sp.lead.r + explode * 5, 0]}>
              <meshStandardMaterial
                {...materialPropsFor(termMat, { viewMode, isShell: false, isContact: true })}
              />
            </mesh>

            {showLabels && (
              <Text
        font={LABEL_FONT}
                position={[sp.rootX + 0.8, sp.rootR + 1.1, 0]}
                fontSize={0.55}
                color="#93a3b8"
                anchorX="left"
                anchorY="middle"
                rotation={[-(sp.angularPositionDeg * Math.PI) / 180, 0, 0]}
                outlineWidth={0.04}
                outlineColor="#0b1220"
              >
                {jc.label}
              </Text>
            )}
          </group>
        )
      })}

      {/* 端子 */}
      {terminals.map((t) => (
        <mesh
          key={t.terminalId}
          geometry={t.geometry}
          position={[t.position.x, t.position.y - explode * 4, t.position.z]}
          name={`terminal-${t.terminalId}`}
        >
          <meshStandardMaterial
            {...materialPropsFor(termMat, { viewMode, isShell: false, isContact: false })}
          />
        </mesh>
      ))}

      {/* 前面基準面 (X=0) のマーカー */}
      <mesh position={[0, 0, 0]} rotation={[0, Math.PI / 2, 0]} name="reference-plane">
        <ringGeometry args={[model.jack.entryBoreDiameterMm / 2, model.jack.entryBoreDiameterMm / 2 + 0.15, 48]} />
        <meshBasicMaterial color="#38bdf8" side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}
