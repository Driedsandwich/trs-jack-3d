/** 壊れた tar の材料が、どう終わるべきか。**ここが唯一の正本**（v0.6.12） */
export type Outcome = 'invalid' | 'unsupported' | 'safe'
/** 種類ごとの既定 */
export declare const EXPECTED: Record<string, Outcome>
/** 個別指定（種類ごとの既定より優先する） */
export declare const EXPECTED_BY_ID: Record<string, Outcome>
/** 材料 1 件の期待値を引く。**引けなければ投げる**（黙って「通るはず」側へ落とさない） */
export declare function expectedOutcome(kind: string, id: string): Outcome
