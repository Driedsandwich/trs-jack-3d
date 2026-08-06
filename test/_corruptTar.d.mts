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
export interface Case { id: string, tar: Buffer, ok?: boolean }

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
