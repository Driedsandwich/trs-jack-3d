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
  /** **detail.stableReasonCode は必須**（catalog に無い名前・status 違いはその場で投げる・v0.6.14） */
  constructor(reason: string, detail: { stableReasonCode: string, [k: string]: unknown })
  detail: Record<string, unknown>
}

/**
 * 壊れてはいないが、この道具が扱うと決めた範囲の外（v0.6.7）。
 * ふつうの tar なら展開できる——`ARCHIVE_INVALID` と混ぜない
 */
export declare class ArchiveUnsupported extends Error {
  /** **detail.stableReasonCode は必須**（catalog に無い名前・status 違いはその場で投げる・v0.6.14） */
  constructor(reason: string, detail: { stableReasonCode: string, [k: string]: unknown })
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

/** この道具が出しうる status の全部（v0.6.11・外部監査 §7） */
/** status と、そのときの終了コード。**列挙を持つ側の正本はここ 1 か所**（v0.6.12） */
/** status に紐づくもの（終了コード・loader が返してよいか・受け手向け注記）を 1 か所で持つ（v0.6.14） */
/** 止め方の名前の唯一の正本（v0.6.14）。**配布物 1 ファイルに同梱する** */
/** `reachability` は**宣言**であり、試験が両方向で実測と突き合わせる（v0.6.15・外部監査 P1-C） */
export type Reachability = 'corpus' | 'external-fixture' | 'cli-route' | 'defensive-invariant'
export interface ReasonCodeMeta { reachability: Reachability, status: string, family: string, summary: string }
export declare const REASON_CODES: Record<string, ReasonCodeMeta>
export declare const OTHER_CODES: readonly string[]
export declare function assertCatalogued(code: string): string
export declare const CLI_STATUS_META: Record<string, { exit: number, fromLoad: boolean, summary: string, note?: string }>

export declare const CLI_STATUS_EXIT: Record<string, number>
export declare const CLI_STATUSES: readonly string[]

/** `{ kind: ARCHIVE_* }` を直に組み立てず、catalog から kind を引く（v0.6.14） */
export declare function archiveError(code: string, error: string, detail?: Record<string, unknown>): { error: string, kind: string, detail: Record<string, unknown>, stableReasonCode: string }
