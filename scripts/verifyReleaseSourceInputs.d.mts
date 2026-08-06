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
}

/** archive が壊れている／敵対的であることを表す。取れなかった（SOURCE_UNAVAILABLE）とは別物 */
export declare class ArchiveInvalid extends Error {
  detail: Record<string, unknown>
}

export interface ArchiveReadResult {
  files?: Map<string, Buffer>
  error?: string
  kind?: 'ARCHIVE_INVALID'
  detail?: Record<string, unknown>
}

/** archive を読む共通の入口。例外を「壊れている」と「取れない」に分けて返す */
export declare function readArchiveBuffer(buf: Buffer, o: { gzip: boolean }): ArchiveReadResult
