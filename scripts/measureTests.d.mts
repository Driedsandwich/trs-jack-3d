/** テスト件数の実測値。`artifacts/test_counts.json` に入るのと同じ形 */
export interface TestMeasurement {
  total: number
  byFile: Record<string, number>
  skipped: number
  failed: number
  failedSuites: number
  exitCode: number
  allPassed: boolean
}

/** vitest を 1 回走らせて実測する。`reportPath` があれば、その報告を読み直す */
export declare function measureTests(root?: string, reportPath?: string | null): TestMeasurement

/** vitest を走らせて JSON 報告と終了コードを返す。**落ちても投げない** */
export declare function runVitestJson(root?: string): { report: any, exitCode: number }

/** vitest の JSON 報告を畳む**唯一の集計器**（純関数・v0.6.17） */
export declare function summarizeVitestReport(report: any, exitCode: number): TestMeasurement

/** 突き合わせる欄の一覧 */
export declare const EVIDENCE_FIELDS: readonly string[]

/** 実測と記録を 1 欄ずつ比べる。空配列なら一致 */
export declare function diffEvidence(live: TestMeasurement, recorded: unknown): string[]

/** テストの結果を変えうるファイルの範囲（由来の検査用・実在から拾う） */
export declare function testInputPaths(root?: string): string[]

/**
 * `validation-results.testEvidence` が名乗る証拠を、`test_counts.json` の実物と結び直す。
 * 空配列なら一致（v0.6.17・外部監査 P1-B）
 */
export declare function crossBindTestEvidence(tc: any, validation: any, tcSha256: string): string[]
