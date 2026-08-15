/**
 * **ランダム生成した schema 対で、判定器の危険側を探し続ける（property-based）。**
 *
 * 計画 `docs/V060_PLAN_20260805.md` §3 が `[AI]` で約束したまま 10 日落ちていた分。
 * 手書きの合成ペア（`schemaVersioningPolicy.test.ts` 条文 ①）は
 * **人が思いついた形しか含まない。**ここは思いつかない形を作る。
 *
 * ## 見ている性質（これ 1 つ）
 *
 * > ajv が「新だけが通す値」を見つけたなら、判定器は **BUMP** でなければならない。
 *
 * 逆（BUMP なのに広がっていない）は条文が明示的に許す保守的な誤りなので見ない。
 *
 * ## この試験が空振りしないための対照
 *
 * 一番の落とし穴は**値の作り方**である。「新だけが通す値」を探せなければ、
 * 言語が広がっていても反例が出ず、試験は緑になる。だから同じファイルで:
 *
 *   ① 証人探しが既知の広がり対で証人を出すこと（出なければ探索が壊れている）
 *   ② 同一 schema では証人を出さないこと（何にでも鳴るなら意味がない）
 *   ③ 生成器が深いネストと `$ref` の連鎖を実際に作れていること
 *   ④ 判定が BUMP 一色でないこと（**常に BUMP と言う判定器**を弾く）
 *   ⑤ 変異が当たった対だけを数えていること（当たらなかった変異は素通りと区別できない）
 *
 * ## 実際に反例が出た（2026-08-15）
 *
 * 961 対のうち 4 件。すべて `oneOf` の枝が `$ref` で、参照先だけが変わった形。
 * 判定器は **HOLD**（据え置き可）を返していた——**危険側**である。
 * 回帰テストを先に入れてから直した（条文 ①-c3）。
 *
 * ## 種は固定する
 *
 * 失敗したケースを再現できないと直せない。種は下の `SEEDS` で固定し、
 * 失敗時のメッセージに種と変異の種類を出す。
 * **テストの件数は種の数で決まるので、環境で変わらない。**
 */
import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
import { diffSchemaObjects } from '../scripts/schemaLanguageDiff.mjs'
import { depthOf, genRoot, hasRef, mutate, rng, witnesses } from './_schemaFuzz.mjs'

const compile = (s: object) => new Ajv({ allErrors: true, strict: false }).compile(s)

/** 種の範囲。**件数は固定**（環境で変わらない）。1 ケース ≒ 1 対 */
const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1)

type Pair = {
  seed: number
  op: string
  applied: boolean
  old: object
  neu: object
  verdict: string
  widenWitness: unknown
  hasWiden: boolean
}

/** 対を 1 回だけ作って共有する（各 it で作り直すと種が同じでも二重に走る） */
const PAIRS: Pair[] = SEEDS.map((seed) => {
  const r = rng(seed)
  const old = genRoot(r)
  const mu = mutate(r, old)
  const w = mu.applied ? witnesses(compile, old, mu.schema) : { compileFailed: true }
  const verdict = mu.applied && !w.compileFailed ? diffSchemaObjects(old, mu.schema).verdict : '-'
  return {
    seed,
    op: mu.op,
    applied: mu.applied && !w.compileFailed,
    old,
    neu: mu.schema,
    verdict,
    widenWitness: (w as { widenWitness?: unknown }).widenWitness,
    hasWiden: !w.compileFailed && (w as { widenWitness?: unknown }).widenWitness !== undefined,
  }
})

const USED = PAIRS.filter((p) => p.applied)

describe('property-based: 判定器の危険側を探す', () => {
  /**
   * **本体。**広がりが実在する対で、判定が BUMP でないものが 1 件でもあれば落とす。
   * 失敗メッセージに種と変異と証人を出す（再現できないと直せない）。
   */
  it('**広がりが実在する対は、すべて BUMP**（危険側 0 件）', () => {
    const danger = USED.filter((p) => p.hasWiden && p.verdict !== 'BUMP')
      .map((p) => `seed=${p.seed} op=${p.op} verdict=${p.verdict} 証人=${JSON.stringify(p.widenWitness)}`
        + `\n    旧 ${JSON.stringify(p.old)}\n    新 ${JSON.stringify(p.neu)}`)
    expect(danger, '**広がっているのに据え置き可と判定した**（受け手が旧 schema で拒む）').toEqual([])
  })

  it('**母集団が空でない**（広がりが実在する対が十分ある）', () => {
    const widened = USED.filter((p) => p.hasWiden)
    expect(widened.length, '広がりが実在する対').toBeGreaterThanOrEqual(50)
  })

  it('⑤ **変異が当たった対だけを数えている**（当たらなかった変異と素通りは区別がつかない）', () => {
    expect(USED.length, '変異が当たった対').toBeGreaterThanOrEqual(100)
    // 当たっていない対を混ぜていないこと
    expect(USED.every((p) => JSON.stringify(p.old) !== JSON.stringify(p.neu))).toBe(true)
  })

  it('④ **判定が BUMP 一色でない**（常に BUMP と言う判定器を弾く）', () => {
    const notBump = USED.filter((p) => p.verdict !== 'BUMP')
    expect(notBump.length, 'BUMP 以外の判定').toBeGreaterThanOrEqual(20)
  })
})

describe('property-based: 探索そのものが働いていること', () => {
  it('① 既知の広がり対で証人が出る（出なければ探索が壊れている）', () => {
    const w = witnesses(compile, { type: 'string', enum: ['a'] }, { type: 'string', enum: ['a', 'b'] })
    expect(w.widenWitness, '既知の広がりで証人が出ない').toBe('b')
  })

  it('② 同一 schema では証人が出ない（何にでも鳴らない）', () => {
    const s = { type: 'string', enum: ['a'] }
    const w = witnesses(compile, s, structuredClone(s))
    expect(w.widenWitness).toBeUndefined()
    expect(w.narrowWitness).toBeUndefined()
  })

  it('③ 生成器が**深いネスト**と **$ref の連鎖**を実際に作っている', () => {
    const deep = PAIRS.filter((p) => depthOf(p.old) >= 4).length
    const refs = PAIRS.filter((p) => hasRef(p.old)).length
    expect(deep, '深いネスト（>=4）を作れていない — 現行 schema に無い形を試せていない').toBeGreaterThanOrEqual(10)
    expect(refs, '$ref を作れていない').toBeGreaterThanOrEqual(20)
  })

  it('③-b 生成した schema を ajv がすべて読める（読めない形を数えていない）', () => {
    const bad = PAIRS.filter((p) => {
      try { compile(p.old); return false } catch { return true }
    })
    expect(bad.map((p) => p.seed), 'ajv が読めない schema を生成している').toEqual([])
  })
})
