/**
 * ジャックの 3D 形状生成。
 *
 * 単位: 1 unit = 1 mm。ジャック前面基準面が X = 0、奥が +X。
 * 半径方向の基準は Y (角度 0deg = +Y)。
 *
 * 外形はデータシートの寸法図から作る。内部接点ばねはメーカー外形 CAD には
 * 含まれないため、回路図と一般的な板ばね構造から独自に起こしたものである
 * (根拠区分 = ASSUMPTION / DERIVED)。仕様 §4.3。
 */

import * as THREE from 'three'
import type { ResolvedJack, ResolvedJackContact } from '../../model/resolve'

export const RADIAL_SEGMENTS = 48

// ---------------------------------------------------------------------------
// ハウジング
// ---------------------------------------------------------------------------

export interface JackHousingGeometries {
  /** 前部: 挿入穴が貫通している絶縁ハウジング */
  frontShell: THREE.ExtrudeGeometry
  /** 後部: 中実の絶縁ハウジング */
  rearShell: THREE.BoxGeometry
  rearShellX: number
  /** 金属ブッシング (入口部) */
  bushing: THREE.CylinderGeometry
  bushingX: number
  /** ボア内壁 (プラグを案内する絶縁バレル) */
  bore: THREE.CylinderGeometry
  boreX: number
  boreDepth: number
  /** 基板 (アングル型なので下面に出る) */
  pcb: THREE.BoxGeometry
}

export function buildJackHousing(jack: ResolvedJack): JackHousingGeometries {
  const { widthMm: W, heightMm: H, depthMm: D, axisHeightFromPcbMm: axisH } = jack.housing
  const boreR = jack.entryBoreDiameterMm / 2
  // ボアは停止面まで。停止面 = 完全挿入深度。
  const boreDepth = jack.fullInsertionDepthMm

  // 矩形断面 + 円穴 を X 方向に押し出す
  const shape = new THREE.Shape()
  const halfW = W / 2
  const yBottom = -axisH
  const yTop = H - axisH
  shape.moveTo(-halfW, yBottom)
  shape.lineTo(halfW, yBottom)
  shape.lineTo(halfW, yTop)
  shape.lineTo(-halfW, yTop)
  shape.closePath()
  const hole = new THREE.Path()
  hole.absarc(0, 0, boreR, 0, Math.PI * 2, false)
  shape.holes.push(hole)

  // 絶縁ハウジング本体はローレットナットの後ろから始まる
  const nose = jack.noseLengthMm
  const frontLen = Math.max(0.5, boreDepth - nose)
  const frontShell = new THREE.ExtrudeGeometry(shape, {
    depth: frontLen,
    bevelEnabled: false,
    curveSegments: RADIAL_SEGMENTS,
  })
  // ExtrudeGeometry は +Z に押し出す。+Z → +X へ倒し、ナットの後ろへ移動する。
  frontShell.rotateY(Math.PI / 2)
  frontShell.translate(nose, 0, 0)
  frontShell.computeVertexNormals()

  const rearDepth = Math.max(0.5, D - boreDepth)
  const rearShell = new THREE.BoxGeometry(rearDepth, H, W)
  const rearShellX = boreDepth + rearDepth / 2

  // ローレットナット (CuZn ニッケルめっき)。Sleeve 側の金属部でもある。
  const bushing = new THREE.CylinderGeometry(
    jack.nutDiameterMm / 2,
    jack.nutDiameterMm / 2,
    nose,
    24,
    1,
    true,
  )
  bushing.rotateZ(-Math.PI / 2)

  const bore = new THREE.CylinderGeometry(boreR, boreR, boreDepth, RADIAL_SEGMENTS, 1, true)
  bore.rotateZ(-Math.PI / 2)

  const pcb = new THREE.BoxGeometry(D + 5, 1.2, W + 4)

  return {
    frontShell,
    rearShell,
    rearShellX,
    bushing,
    bushingX: nose / 2,
    bore,
    boreX: boreDepth / 2,
    boreDepth,
    pcb,
  }
}

// ---------------------------------------------------------------------------
// 接点ばね
// ---------------------------------------------------------------------------

/** 板ばねの断面プロファイル (軸位置 X, 内面半径 R) */
export interface LeafPathPoint {
  x: number
  r: number
}

export interface SpringGeometry {
  contactId: string
  /** 根元を原点に平行移動済みの板ばね形状 */
  geometry: THREE.ExtrudeGeometry
  /** 根元のワールド位置 (角度配置前の XY 平面上) */
  rootX: number
  rootR: number
  /** 根元から接触パッドまでの軸方向距離 (たわみ→回転角の換算に使う) */
  armLengthMm: number
  angularPositionDeg: number
  /** ブレーク接点の固定パッド (存在する場合) */
  breakPad: {
    id: string
    geometry: THREE.BoxGeometry
    x: number
    r: number
    /** 根元からの距離。ここのギャップが開く */
    leverMm: number
  } | null
  /** 端子へ降りるリード */
  lead: { geometry: THREE.BoxGeometry; x: number; r: number }
  path: LeafPathPoint[]
}

export interface SpringBuildOptions {
  /** 板厚 [mm] */
  thicknessMm: number
  /** 板幅 (円周方向) [mm] */
  widthMm: number
  /** 根元の半径 [mm] */
  rootRadiusMm: number
  /** 前側の立ち上がり (リードイン) の高さ [mm] */
  leadInRiseMm: number
  /** 前側リードインの長さ [mm] */
  leadInLengthMm: number
}

/** 内面ポリラインから、板厚を持った閉じた 2D シェイプを作る */
function leafShape(path: LeafPathPoint[], thickness: number): THREE.Shape {
  const s = new THREE.Shape()
  s.moveTo(path[0].x, path[0].r)
  for (let i = 1; i < path.length; i++) s.lineTo(path[i].x, path[i].r)
  for (let i = path.length - 1; i >= 0; i--) s.lineTo(path[i].x, path[i].r + thickness)
  s.closePath()
  return s
}

/** ポリラインの X における R を線形補間 */
function radiusOnPath(path: LeafPathPoint[], x: number): number {
  const sorted = [...path].sort((a, b) => a.x - b.x)
  if (x <= sorted[0].x) return sorted[0].r
  if (x >= sorted[sorted.length - 1].x) return sorted[sorted.length - 1].r
  for (let i = 1; i < sorted.length; i++) {
    if (x <= sorted[i].x) {
      const a = sorted[i - 1]
      const b = sorted[i]
      const t = (x - a.x) / (b.x - a.x)
      return a.r + t * (b.r - a.r)
    }
  }
  return sorted[sorted.length - 1].r
}

export function buildContactSpring(
  contact: ResolvedJackContact,
  opts: SpringBuildOptions,
): SpringGeometry {
  const xc = contact.axialCenterMm
  const xr = contact.rootAxialMm
  const rFree = contact.freeRadiusMm
  const halfPad = contact.padWidthMm / 2

  if (xr <= xc) {
    throw new Error(
      `接点 ${contact.id}: 根元 (${xr}) は接触点 (${xc}) より奥になければならない`,
    )
  }

  // 内面のポリライン。奥 (根元) → 手前 (リードイン) の順。
  // 前方に向かって半径を絞り、接触パッドで平坦、さらに前方でプラグを迎えるため外へ開く。
  const bendLen = Math.min(1.2, (xr - xc - halfPad) * 0.5)
  const path: LeafPathPoint[] = [
    { x: xr, r: opts.rootRadiusMm },
    { x: xr - Math.max(0.4, (xr - xc) * 0.25), r: opts.rootRadiusMm },
    { x: xc + halfPad + bendLen, r: rFree + (opts.rootRadiusMm - rFree) * 0.15 },
    { x: xc + halfPad, r: rFree },
    { x: xc - halfPad, r: rFree },
    { x: xc - halfPad - opts.leadInLengthMm, r: rFree + opts.leadInRiseMm },
  ].sort((a, b) => a.x - b.x)

  const shape = leafShape(path, opts.thicknessMm)
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: opts.widthMm,
    bevelEnabled: false,
    curveSegments: 4,
  })
  // 円周方向に中心合わせ。根元を原点へ。
  geometry.translate(-xr, -opts.rootRadiusMm, -opts.widthMm / 2)
  geometry.computeVertexNormals()

  // ブレーク接点の固定パッド: 根元と接触パッドの中間で、板ばねの内面に接する。
  let breakPad: SpringGeometry['breakPad'] = null
  if (contact.breakContact) {
    const xb = xc + (xr - xc) * 0.55
    const rInner = radiusOnPath(path, xb)
    const padSize = 0.6
    breakPad = {
      id: contact.breakContact.id,
      geometry: new THREE.BoxGeometry(padSize, 0.35, opts.widthMm * 0.7),
      x: xb,
      // 板ばね内面のすぐ内側に頭が来るように配置 (無挿入時に接触)
      r: rInner - 0.35 / 2,
      leverMm: xr - xb,
    }
  }

  const lead = {
    geometry: new THREE.BoxGeometry(0.8, 0.5, opts.widthMm * 0.8),
    x: xr,
    r: opts.rootRadiusMm + opts.thicknessMm / 2,
  }

  return {
    contactId: contact.id,
    geometry,
    rootX: xr,
    rootR: opts.rootRadiusMm,
    armLengthMm: xr - xc,
    angularPositionDeg: contact.angularPositionDeg,
    breakPad,
    lead,
    path,
  }
}

/**
 * たわみ量 [mm] から板ばねの回転角 [rad] を求める。
 * 根元まわりの剛体回転で近似する (板ばね全体が根元から曲がるという近似)。
 * 実際の片持ち梁は曲率分布を持つため、これは表示上の近似である。
 */
export function deflectionToRotation(deflectionMm: number, armLengthMm: number): number {
  return -Math.asin(Math.max(-0.9, Math.min(0.9, deflectionMm / armLengthMm)))
}

// ---------------------------------------------------------------------------
// 端子
// ---------------------------------------------------------------------------

export interface TerminalGeometry {
  terminalId: string
  geometry: THREE.BufferGeometry
  position: THREE.Vector3
}

/**
 * 端子の 3D 位置。図面の基板レイアウト図に記載された実位置を使う
 * (jack.pinN.axial は前面基準面から、jack.pinN.lateral は軸中心から)。
 *
 * 2026-07-31 まで 2.5mm の等間隔で並べていた。実位置がデータ層にあるのに
 * 使っていなかったため、「端子3 が軸の左 (−5.05) にあるから Tip 接点は
 * 270deg」という角度の導出を画面で確かめられなかった。
 *
 * 位置の分からない端子だけは、従来どおり等間隔で置いて外観を保つ。
 */
export function buildTerminals(jack: ResolvedJack, pitchMm = 2.5): TerminalGeometry[] {
  const n = jack.terminals.length
  const axisH = jack.housing.axisHeightFromPcbMm
  const startZ = -((n - 1) * pitchMm) / 2
  // 軸位置はジャック前面基準。3D はハウジング前面 (= noseLengthMm) を原点に持つ。
  return jack.terminals.map((t, i) => {
    const g = new THREE.BoxGeometry(0.6, axisH + 1.5, 0.4)
    const x = t.axialMm !== null ? t.axialMm - jack.noseLengthMm : jack.housing.depthMm * 0.35 + (i % 2) * 1.6
    const z = t.lateralMm !== null ? t.lateralMm : startZ + i * pitchMm
    return {
      terminalId: t.id,
      geometry: g,
      position: new THREE.Vector3(x, -axisH / 2 - 0.75, z),
    }
  })
}
