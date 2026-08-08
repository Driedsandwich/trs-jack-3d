/** 道具の版。判定の意味を変えたら上げる */
export declare const TOOL_VERSION: number

/**
 * 信頼できない archive を読むための上限。
 * 値は v0.5.2 の実物を測ってから決めた（→ 本体の JSDoc）。
 */
export declare const TAR_LIMITS: {
  maxEntries: number
  maxEntryBytes: number
  maxTotalBytes: number
  maxPathLength: number
  fetchTimeoutMs: number
  /** **圧縮された入力そのものの上限（v0.6.1）。**展開後の上限とは別に効く */
  maxCompressedBytes: number
}

/** archive が壊れている／敵対的であることを表す。取れなかった（SOURCE_UNAVAILABLE）とは別物 */
export declare class ArchiveInvalid extends Error {
  detail: Record<string, unknown>
}

export interface ArchiveReadResult {
  files?: Map<string, Buffer>
  /** 全 entry の型つき一覧（v0.6.4）。完全性の検査はこちらを母集団にする */
  inventory?: { name: string, type: string, isDirEntry: boolean, linkname: string | null }[]
  /**
   * 剥がした先頭 1 階層の名前（v0.6.5）。剥がしていなければ `null`。
   * **差分試験が綴りを推測しないで済むように記録する。**
   */
  rootStripped?: string | null
  error?: string
  kind?: 'ARCHIVE_INVALID'
  detail?: Record<string, unknown>
}

/** archive を読む共通の入口。例外を「壊れている」と「取れない」に分けて返す */
export declare function readArchiveBuffer(buf: Buffer, o: { gzip: boolean }): ArchiveReadResult

/**
 * 受け取りながら上限を効かせる（v0.6.1）。
 * `arrayBuffer()` は全部読み終えてから返すので、上限に届いた時点で止められない。
 */
export declare function readBodyLimited(res: Response, limit: number): Promise<Buffer>
