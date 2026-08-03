/** scripts/validateProfiles.mjs の型。実体は .mjs 側にある（正本は 1 つ） */

export interface ValidationResult {
  artifact: string
  schema: string | null
  missing: boolean
  schemaErrors: string[]
  semanticErrors: string[]
}

/** 全対象を検証して結果を返す。CLI と release evidence の両方がここを使う */
export declare function validateAll(): ValidationResult[]

/** 検証対象の件数。**テストで直書きしないための正本** */
export declare const TARGET_COUNT: number
