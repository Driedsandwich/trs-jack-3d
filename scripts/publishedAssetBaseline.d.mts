/** scripts/publishedAssetBaseline.mjs の型。実体は .mjs 側にある（正本は 1 つ） */

export interface PublishedAsset {
  tag: string
  name: string
  digest: string
}

export interface PublishedAssetBaseline {
  schemaVersion: number
  schemaId: string
  purpose: string
  repo: string
  takenAt: string
  assets: PublishedAsset[]
}

export interface BaselineIo {
  listTags(repo: string): string
  viewAssets(repo: string, tag: string): string
  remoteUrl(): string
  readFile(path: string): string
  writeFile(path: string, contents: string): void
  fileExists(path: string): boolean
  now(): string
}

export declare const BASELINE_PATH: string
export declare const EXIT_OK: 0
export declare const EXIT_MISMATCH: 1
export declare const EXIT_MEASUREMENT_FAILED: 2

/** 取得そのものができなかったとき。**件数を出してはいけない**合図 */
export declare class MeasurementFailure extends Error {}

export declare function keyOf(a: PublishedAsset): string

export declare function compareToBaseline(
  live: PublishedAsset[],
  baselineAssets: PublishedAsset[],
): { intact: PublishedAsset[]; changed: PublishedAsset[] }

/** 対照。**変異が入ったことを証明してから**返す */
export declare function mutateOneDigest(
  baselineAssets: PublishedAsset[],
  intactKeys: Set<string>,
): { assets: PublishedAsset[]; index: number; from: string; to: string }

/** 版の順。文字列比較だと `v0.6.9 > v0.6.10` になるので数の列として比べる */
export declare function compareTags(a: string, b: string): number

export declare function repoFromRemote(url: string): string

export declare function defaultIo(): BaselineIo

/** **どこで失敗しても `MeasurementFailure` を投げる**（空配列を返さない） */
export declare function measurePublished(io: BaselineIo, repo: string): PublishedAsset[]

export declare function main(
  args?: string[],
  io?: BaselineIo,
  root?: string,
): { code: 0 | 1 | 2; lines: string[]; write?: PublishedAssetBaseline; live?: PublishedAsset[] }
