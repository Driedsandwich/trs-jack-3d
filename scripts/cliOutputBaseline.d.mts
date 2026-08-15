/** 基準ファイルの置き場（配布 source に入れる） */
export declare const BASELINE_PATH: string

export interface BaselineRoute {
  label: string
  args: readonly string[]
  injected: string | null
  exitCode: number
  stdoutBytes: number
  stdoutSha256: string
  stderrBytes: number
  stderrSha256: string
}

/** 注入で踏む 7 経路 ＋ 注入なしの 2 経路 */
export declare function allBaselineRoutes(keep?: string[]): { label: string, args: string[], preload?: string, env?: Record<string, string> }[]
/** 1 経路を走らせる。**非 0 で投げない** */
export declare function runRoute(route: unknown, root?: string): { stdout: string, stderr: string, code: number }
/** 全経路を測る */
export declare function measureAll(root?: string): BaselineRoute[]
/** 基準と実測を突き合わせる。空配列なら一致 */
export declare function diffBaseline(live: readonly BaselineRoute[], recorded: { routes?: readonly BaselineRoute[] }): string[]
