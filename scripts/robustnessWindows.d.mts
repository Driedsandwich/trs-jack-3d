/** scripts/robustnessWindows.mjs の型。実体は .mjs 側にある（正本は 1 つ） */

export interface RobustnessWindow {
  startMm: number
  lastSampleMm: number
  endExclusiveMm: number
  widthMm: number
}

/** 窓 1 つ分の不変条件。**エラー文字列の配列**を返す（空なら合格） */
export declare function checkWindow(w: RobustnessWindow, stepMm: number, where: string): string[]

/** artifact 全体の窓（nominalConfiguration と counterExamples の両方）を見る */
export declare function checkWindowInvariants(a: unknown): string[]
