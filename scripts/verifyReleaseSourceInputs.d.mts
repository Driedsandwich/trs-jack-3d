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

/**
 * 壊れてはいないが、この道具が扱うと決めた範囲の外（v0.6.7）。
 * ふつうの tar なら展開できる——`ARCHIVE_INVALID` と混ぜない
 */
export declare class ArchiveUnsupported extends Error {
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
  /** **`ARCHIVE_UNSUPPORTED` は v0.6.7 で増えた。**壊れているのではなく、範囲の外 */
  kind?: 'ARCHIVE_INVALID' | 'ARCHIVE_UNSUPPORTED'
  detail?: Record<string, unknown>
  /**
   * **止めた理由の、文章とは別の変わらない名前（v0.6.9 で追加・v0.6.10 で全 throw へ）。**
   * 文章は版ごとに書き換わるので、受け手が機械で分岐するならこちらを見る。
   * 欄名・型・パスの具体値は `detail` に入る（**欄ごとの code は作らない**）。
   * `*_OTHER` は「まだ名前を付けていない」の意味で、corpus の材料がこれを返したら試験が落ちる。
   */
  stableReasonCode?: string
  /** この archive に出たヘッダ形式（v0.6.9）。受け手が「何を読んだか」を後から見るため */
  headerFormats?: string[]
}

/** archive を読む共通の入口。例外を「壊れている」と「取れない」に分けて返す */
export declare function readArchiveBuffer(buf: Buffer, o: { gzip: boolean }): ArchiveReadResult

/**
 * 受け取りながら上限を効かせる（v0.6.1）。
 * `arrayBuffer()` は全部読み終えてから返すので、上限に届いた時点で止められない。
 */
export declare function readBodyLimited(res: Response, limit: number): Promise<Buffer>
