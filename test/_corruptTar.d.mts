export interface TarEntry {
  name: string
  data?: string | Buffer
  type?: string
  linkname?: string
  prefix?: string
  mode?: number
  uid?: number
  gid?: number
  mtime?: number
  size?: number
  declaredSize?: number
  checksum?: 'valid' | 'bad' | 'blank'
}
/**
 * **材料は「どう終わるべきか」を持たない（v0.6.12）。**
 * 期待値は `test/_tarExpectations.mjs` が唯一の正本。
 * v0.6.11 まで `ok?: boolean` を持っていたが、**読み手が 1 か所・`!ok` としてだけ**だったので
 * `ok: true` が嘘でも誰も落ちなかった（実測で 10 件ずれていた）。
 */
export interface Case { id: string, tar: Buffer }

export declare function header(o: TarEntry): Buffer
export declare function buildTar(entries: TarEntry[], opts?: { endBlocks?: number }): Buffer
export declare function normalTar(top?: string, files?: Record<string, string>): Buffer
export declare function paxCases(): Case[]
export declare function longNameCases(): Case[]
export declare function checksumCases(): Case[]
export declare function traversalCases(): Case[]
export declare function linkCases(): Case[]
export declare function resourceCases(): Case[]
export declare function allCases(): Record<string, Case[]>
