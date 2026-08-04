/** scripts/schemaLanguageDiff.mjs の型。実体は .mjs 側にある（正本は 1 つ） */

/** 差分 1 件。pointer は **schema への JSON Pointer** */
export interface SchemaDiffFact {
  kind: 'WIDEN' | 'NARROW' | 'UNDEC'
  /** 人が読む位置。`$.a.b[].c` 形式 */
  path: string
  /** schema への JSON Pointer。`/properties/a/items/properties/c` */
  pointer: string
  detail: string
}

export interface SchemaDiff {
  /** BUMP = 版を上げる / HOLD_RECORD = 据え置き可だが記録する / HOLD = 据え置き可 */
  verdict: 'BUMP' | 'HOLD_RECORD' | 'HOLD'
  facts: SchemaDiffFact[]
}

export declare const WIDEN: 'WIDEN'
export declare const NARROW: 'NARROW'
export declare const UNDEC: 'UNDEC'

export declare function diffSchemaObjects(oldSchema: unknown, newSchema: unknown): SchemaDiff
export declare function diffSchemaFiles(oldPath: string, newPath: string): SchemaDiff

/** JSON Pointer を解決する（`$ref` を辿る）。**存在しなければ undefined** */
export declare function resolvePointer(root: unknown, pointer: string): unknown
