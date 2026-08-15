/** test/_schemaFuzz.mjs の型。実体は .mjs 側にある（正本は 1 つ） */

/** 種を固定した乱数。**失敗したケースを再現できる形にする** */
export declare function rng(seed: number): () => number

/** 小さな schema を作る（深いネストと `$ref` の連鎖も作る） */
export declare function genSchema(
  r: () => number,
  depth?: number,
  refs?: { defs: Record<string, unknown>, n: number },
): Record<string, unknown>

/** definitions を束ねて 1 枚の schema にする */
export declare function genRoot(r: () => number): Record<string, unknown>

/**
 * 1 か所だけ変えた対を作る。
 * `applied` が false のときは**変異が当たっていない**（呼び出し側で除く）
 */
export declare function mutate(
  r: () => number,
  schema: object,
): { schema: Record<string, unknown>, applied: boolean, op: string }

/** schema の最大ネスト深さ（対照用） */
export declare function depthOf(node: unknown, d?: number): number

/** `$ref` を 1 つでも含むか（対照用） */
export declare function hasRef(node: unknown): boolean

/** その schema 対から候補値を作る（固定プールだけに頼らない） */
export declare function candidates(oldS: object, newS: object): unknown[]

/**
 * ajv を正解器にして包含関係の真値を出す。
 * `widenWitness` が undefined でなければ「新だけが通す値」が実在する
 */
export declare function witnesses(
  compile: (s: object) => (v: unknown) => boolean,
  oldS: object,
  newS: object,
): { compileFailed: boolean, widenWitness?: unknown, narrowWitness?: unknown }
