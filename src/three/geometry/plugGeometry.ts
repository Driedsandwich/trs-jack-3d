/**
 * プラグの 3D 形状生成。
 *
 * 単位: 1 three.js unit = 1 mm (仕様 §15 の単位対応の明示)。
 * 軸: プラグは +X 方向を向いて挿入される。回転体は Y 軸まわりに作ってから
 *     rotateZ(-90°) で +Y → +X に倒す。
 *
 * 重要: Tip / Ring / Sleeve は色分けではなく、それぞれ独立した Geometry として作る。
 *       絶縁帯も幅を持った独立オブジェクトにする (仕様 §4.2)。
 */

import * as THREE from 'three'
import { plugRadiusAt, type ResolvedPlug, type ResolvedPlugSegment } from '../../model/resolve'

export const RADIAL_SEGMENTS = 64

/** プロファイルを [s0, s1] に切り出し、両端を閉じた回転体を作る。 */
export function latheForRange(
  profile: { s: number; r: number }[],
  s0: number,
  s1: number,
  radialSegments = RADIAL_SEGMENTS,
): THREE.LatheGeometry {
  const pts: THREE.Vector2[] = []
  const push = (s: number, r: number) => {
    const last = pts[pts.length - 1]
    if (last && Math.abs(last.y - s) < 1e-9 && Math.abs(last.x - r) < 1e-9) return
    pts.push(new THREE.Vector2(Math.max(r, 0), s))
  }

  // 区間の端では、外側ではなく「区間の内側」の半径を採る。
  // 導体と絶縁帯の境界は幅ゼロの垂直な段なので、境界ちょうどの半径は両側で
  // 食い違う。素直に plugRadiusAt(s0) を使うと Ring が低い側 (絶縁帯の半径)
  // から始まってしまい、円筒であるべき導体が円錐に描かれる。
  const eps = 1e-6

  // 始端キャップ (中心へ)
  push(s0, 0)
  push(s0, plugRadiusAt(profile, s0 + eps))
  for (const p of profile) {
    if (p.s > s0 + 1e-9 && p.s < s1 - 1e-9) push(p.s, p.r)
  }
  push(s1, plugRadiusAt(profile, s1 - eps))
  // 終端キャップ
  push(s1, 0)

  const geo = new THREE.LatheGeometry(pts, radialSegments)
  // プラグは +X 方向へ挿入されるので、先端 (s=0) が +X 側、肩 (s=L) が -X 側に来るよう
  // +Y → -X に倒す。鏡像スケールを使わないので面の巻き方向は正しいまま保たれる。
  geo.rotateZ(Math.PI / 2)
  geo.computeVertexNormals()
  return geo
}

export interface PlugPartGeometry {
  segment: ResolvedPlugSegment
  geometry: THREE.LatheGeometry
}

/** 指部の各セグメント (Tip / 絶縁1 / Ring / 絶縁2 / Sleeve) を独立に生成 */
export function buildPlugSegments(plug: ResolvedPlug): PlugPartGeometry[] {
  return plug.segments.map((seg) => ({
    segment: seg,
    geometry: latheForRange(plug.profile, seg.startMm, seg.endMm),
  }))
}

export interface PlugHandleGeometries {
  shoulder: THREE.CylinderGeometry
  insulatorSupport: THREE.CylinderGeometry
  body: THREE.CylinderGeometry
  strainRelief: THREE.CylinderGeometry
  cable: THREE.CylinderGeometry
  /** 各パーツの中心 X 座標 (プラグ先端 s=0 を基準) */
  offsets: {
    shoulder: number
    insulatorSupport: number
    body: number
    strainRelief: number
    cable: number
  }
}

/**
 * 肩から後ろのハンドル部。接触判定には一切使わない (表示専用)。
 * ジャックの停止面に当たるのは「肩の前端」= s = fingerLength。
 */
export function buildPlugHandle(plug: ResolvedPlug): PlugHandleGeometries {
  const h = plug.handle
  const L = plug.fingerLengthMm

  const cyl = (d: number, len: number) => {
    const g = new THREE.CylinderGeometry(d / 2, d / 2, len, RADIAL_SEGMENTS)
    g.rotateZ(-Math.PI / 2)
    return g
  }

  // 肩 (指部から太くなる部分) — 円錐台。前端 (指部側) が停止面に当たる。
  const shoulder = new THREE.CylinderGeometry(
    plug.bodyRadiusMm,
    h.shoulderDiameterMm / 2,
    h.shoulderLengthMm,
    RADIAL_SEGMENTS,
  )
  shoulder.rotateZ(-Math.PI / 2)

  // 絶縁支持体: 肩カラーの後半を絶縁体として描き分ける (長さは肩に含まれるので加算しない)
  const supportLen = h.shoulderLengthMm * 0.45
  const insulatorSupport = cyl(h.shoulderDiameterMm * 0.99, supportLen)

  const body = cyl(h.bodyDiameterMm, h.bodyLengthMm)
  // 歪み止めブーツ。図面の断面 A-A は Ø7 の一定径で、円錐ではない。
  // (2026-07-31 まで φ10 → φ5.8 のテーパで描いていた)
  const strainRelief = cyl(h.strainReliefDiameterMm, h.strainReliefLengthMm)
  const cable = cyl(h.cableDiameterMm, h.cableLengthMm)

  let x = L
  const shoulderX = x + h.shoulderLengthMm / 2
  const supportX = x + h.shoulderLengthMm - supportLen / 2
  x += h.shoulderLengthMm
  const bodyX = x + h.bodyLengthMm / 2
  x += h.bodyLengthMm
  const srX = x + h.strainReliefLengthMm / 2
  x += h.strainReliefLengthMm
  const cableX = x + h.cableLengthMm / 2

  return {
    shoulder,
    insulatorSupport,
    body,
    strainRelief,
    cable,
    offsets: {
      shoulder: shoulderX,
      insulatorSupport: supportX,
      body: bodyX,
      strainRelief: srX,
      cable: cableX,
    },
  }
}
