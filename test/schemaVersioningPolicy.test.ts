/**
 * 条文（docs/SCHEMA_VERSIONING_POLICY.md）の機械判定を検査する。
 *
 * ## なぜ 3 種類あるか
 *
 * 判定器が「常に BUMP」と言うだけの壊れた実装でも、**過去 7 件は 7/7 で当たってしまう。**
 * 過去へ当てるだけでは、条文にも判定器にも判別力があることを示せない。
 *
 *   ① 合成   答えが分かっている 16 件。**うち 7 件は BUMP 以外**   → 常に BUMP と言えない
 *   ② 遡及   過去 7 件へ当てて BUMP になること                    → 過去を誤判定しない
 *   ③ 対照   中身が変わらない schema は HOLD になること           → 何にでも鳴らない
 *
 * ①は「判定が合っているか」だけでなく、**その経路が鳴ったか**まで見る。
 * 設計中に実際、pattern の変異が「BUMP は出たが別の理由で出ていた」ことがあった
 * （同じ変異で enum も消していた）。rc だけを見ていたら気付けない。
 *
 * ②③は tag の schema 実物を読む。作業ツリーの状態でテストの成否が変わらないように。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Ajv from 'ajv'
import { afterAll, describe, expect, it } from 'vitest'
import { HANDLED_KEYWORDS, diffSchemaFiles, diffSchemaObjects } from '../scripts/schemaLanguageDiff.mjs'
import { mustBeNonEmpty } from './_must'

const ROOT = resolve(__dirname, '..')

/** Draft-07。反例は ajv でも同じ dialect で流す */
const DRAFT7 = 'http://json-schema.org/draft-07/schema#'

/**
 * **直近の release tag。**版を据え置いた回はここから言語が変わっていないはずである。
 * 上げた回はここを新しい tag へ進める（進め忘れると検査が古い版を見続ける）。
 */
const LATEST_TAG = 'v0.5.1'

const tmpDirs: string[] = []
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

/** tag 時点の schema を読む。**取れなければ落とす**（skip すると検査ごと消える） */
function atTag(tag: string, path: string): Record<string, unknown> {
  let raw: string
  try {
    raw = execFileSync('git', ['show', `${tag}:${path}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 << 20 })
  } catch (e) {
    throw new Error(
      `${tag}:${path} を読めない: ${(e as Error).message}\n`
        + '  この検査は tag の実物を読む。浅い clone では tag が無いので `git fetch --tags` すること。',
    )
  }
  if (!raw.trim()) throw new Error(`${tag}:${path} が空。git show が失敗して空文字を返している`)
  return JSON.parse(raw)
}

// ---------------------------------------------------------------- ① 合成

const BASE = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['a', 'b'],
  properties: {
    a: { type: 'string', enum: ['x', 'y'] },
    b: { type: 'integer', minimum: 0, maximum: 10 },
    c: { type: 'array', minItems: 1, items: { type: 'string' } },
    e: { type: 'string', pattern: '^a' },
  },
} as const

type Mut = (s: any) => void
interface Case {
  name: string
  expect: 'BUMP' | 'HOLD_RECORD' | 'HOLD'
  /** **その経路が鳴ったか**を見るための、その検査に固有の文言 */
  phrase: string | null
  mut: Mut
}

const CASES: Case[] = [
  { name: '無変更', expect: 'HOLD', phrase: null, mut: () => {} },
  { name: 'description だけ足す', expect: 'HOLD', phrase: null, mut: (s) => { s.properties.a.description = '説明' } },
  { name: 'enum に値を足す', expect: 'BUMP', phrase: 'enum: 値が増えた', mut: (s) => { s.properties.a.enum.push('z') } },
  { name: 'enum から値を減らす', expect: 'HOLD_RECORD', phrase: 'enum: 値が減った', mut: (s) => { s.properties.a.enum = ['x'] } },
  { name: 'required な項目を足す', expect: 'BUMP', phrase: '旧は additionalProperties:false', mut: (s) => { s.properties.d = { type: 'string' }; s.required.push('d') } },
  { name: 'optional な項目を足す', expect: 'BUMP', phrase: '旧は additionalProperties:false', mut: (s) => { s.properties.d = { type: 'string' } } },
  { name: 'required を足す', expect: 'HOLD_RECORD', phrase: 'required: 値が増えた', mut: (s) => { s.required.push('c') } },
  { name: 'required を外す', expect: 'BUMP', phrase: 'required: 値が減った', mut: (s) => { s.required = ['a'] } },
  { name: 'additionalProperties を true へ', expect: 'BUMP', phrase: 'additionalProperties: false -> true', mut: (s) => { s.additionalProperties = true } },
  { name: '上限を緩める', expect: 'BUMP', phrase: 'maximum: 10 -> 100', mut: (s) => { s.properties.b.maximum = 100 } },
  { name: '上限を絞る', expect: 'HOLD_RECORD', phrase: 'maximum: 10 -> 5', mut: (s) => { s.properties.b.maximum = 5 } },
  { name: 'minItems を上げる', expect: 'HOLD_RECORD', phrase: 'minItems: 1 -> 2', mut: (s) => { s.properties.c.minItems = 2 } },
  { name: 'pattern を書き換える', expect: 'BUMP', phrase: '包含は機械判定しない', mut: (s) => { s.properties.e.pattern = '^b' } },
  { name: 'pattern を外す', expect: 'BUMP', phrase: 'pattern: 制約が外れた', mut: (s) => { delete s.properties.e.pattern } },
  { name: '項目を消す', expect: 'HOLD_RECORD', phrase: '項目の削除', mut: (s) => { delete s.properties.c } },
  { name: '未対応キーワード', expect: 'BUMP', phrase: '未対応キーワード', mut: (s) => { s.properties.a.multipleOf = 3 } },
]

describe('条文 ① 答えが分かっている合成ペア', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const o = structuredClone(BASE) as any
    const n = structuredClone(BASE) as any
    c.mut(n)
    const r = diffSchemaObjects(o, n)
    expect(r.verdict, `${c.name} の判定`).toBe(c.expect)
    if (c.phrase !== null) {
      const blob = r.facts.map((f: any) => `${f.kind} ${f.path} ${f.detail}`).join('\n')
      // **判定が合っただけでは足りない。**その経路が鳴ったかまで見る
      expect(blob, `${c.name}: 判定は合っているが、その検査が鳴っていない`).toContain(c.phrase)
    }
  })

  it('BUMP 以外へ落ちる合成例が複数ある（常に BUMP と言う判定器を弾く）', () => {
    const notBump = CASES.filter((c) => c.expect !== 'BUMP')
    mustBeNonEmpty(notBump, 'BUMP 以外の合成例')
    expect(notBump.length, '判別力の証拠になる件数').toBeGreaterThanOrEqual(5)
    // 実際に判定器がそう返すことも確かめる（期待値表が嘘でないこと）
    for (const c of notBump) {
      const n = structuredClone(BASE) as any
      c.mut(n)
      expect(diffSchemaObjects(structuredClone(BASE) as any, n).verdict, c.name).not.toBe('BUMP')
    }
  })
})

// ---------------------------------------------------------------- ①-b oneOf の反例

/**
 * **`oneOf` は枝の言語について単調でない。**
 *
 * v0.5.0 までの実装は枝を index 同士で再帰比較しており、
 * 「枝の minimum が上がった = NARROW」とだけ見て HOLD_RECORD を返していた。
 * **危険な向き (上げるべきなのに据え置く) の誤判定である。**
 * 外部監査 (2026-08-05) が ajv 付きの反例を出した。
 *
 * ここでは 3 つを同じテストで示す。
 *   ① ajv で、値 0 と 0.5 の valid/invalid が新旧で反転すること（＝包含していない事実）
 *   ② **v0.5.0 tag の実物**を読み込むと HOLD_RECORD を返すこと（修正前は落ちる）
 *   ③ 現在の実装は BUMP を返すこと（修正後）
 *
 * ②が無いと「昔からこうだった」のか「直した」のかを、記録でしか主張できない。
 */
describe('条文 ①-b oneOf の反例（外部監査 2026-08-05）', () => {
  const OLD_SCHEMA = { $schema: 'http://json-schema.org/draft-07/schema#', oneOf: [{ type: 'integer' }, { type: 'number', minimum: 0 }] }
  const NEW_SCHEMA = { $schema: 'http://json-schema.org/draft-07/schema#', oneOf: [{ type: 'integer' }, { type: 'number', minimum: 1 }] }

  it('① ajv: 値 0 と 0.5 で valid / invalid が反転する（＝新は旧に収まっていない）', () => {
    const compile = (s: object) => new Ajv({ allErrors: true, strict: false }).compile(s)
    const o = compile(OLD_SCHEMA)
    const n = compile(NEW_SCHEMA)

    // 0 は旧では 2 枝に一致するので oneOf が落ちる。新では integer だけに一致するので通る
    expect(o(0), '旧で 0 が通ってしまう（反例の前提が崩れている）').toBe(false)
    expect(n(0), '新で 0 が通らない（反例の前提が崩れている）').toBe(true)
    // 0.5 は逆向き
    expect(o(0.5)).toBe(true)
    expect(n(0.5)).toBe(false)

    // **両方向に外れている＝どちらも他方を包含しない。**保守的な判定は BUMP しかない
    const widened = [0].some((v) => n(v) && !o(v))
    const narrowed = [0.5].some((v) => o(v) && !n(v))
    expect({ widened, narrowed }).toEqual({ widened: true, narrowed: true })
  })

  it('② v0.5.0 の実装は HOLD_RECORD を返した（修正前の実測）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olddiff-'))
    tmpDirs.push(dir)
    const p = join(dir, 'schemaLanguageDiff.mjs')
    const src = execFileSync('git', ['show', 'v0.5.0:scripts/schemaLanguageDiff.mjs'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 << 20 })
    expect(src.length, 'v0.5.0 の実装が空').toBeGreaterThan(1000)
    // **昔の実装が枝を index 同士で比べていたこと自体も確かめる**（消えていたら反例が的外れになる）
    expect(src).toContain("for (const kw of ['oneOf', 'anyOf', 'allOf'])")
    writeFileSync(p, src)

    const old = await import(/* @vite-ignore */ p)
    const r = old.diffSchemaObjects(OLD_SCHEMA, NEW_SCHEMA)
    expect(r.verdict, 'v0.5.0 は HOLD_RECORD を返していたはず').toBe('HOLD_RECORD')
    expect(r.facts.map((f: { kind: string }) => f.kind)).toContain('NARROW')
  })

  it('③ 現在の実装は BUMP を返す（修正後の実測）', () => {
    const r = diffSchemaObjects(OLD_SCHEMA, NEW_SCHEMA)
    expect(r.verdict).toBe('BUMP')
    const blob = r.facts.map((f: { kind: string, pointer: string, detail: string }) => `${f.kind} ${f.pointer} ${f.detail}`).join('\n')
    // **その経路が鳴ったか**まで見る（別の理由で BUMP になっていても意味がない）
    expect(blob).toContain('/oneOf')
    expect(blob).toContain('単調でない')
    expect(blob).toContain('UNDEC')
  })

  it('④ anyOf / allOf は据え置き（和と積は枝ごとに単調なので、過剰に倒さない）', () => {
    // ここまで倒すと、狭めただけの変更まで版上げになり、条文の判別力が落ちる
    for (const kw of ['anyOf', 'allOf'] as const) {
      const o = { [kw]: [{ type: 'integer' }, { type: 'number', minimum: 0 }] }
      const n = { [kw]: [{ type: 'integer' }, { type: 'number', minimum: 1 }] }
      expect(diffSchemaObjects(o, n).verdict, `${kw} まで UNDEC へ倒している`).toBe('HOLD_RECORD')
    }
  })

  it('⑤ live な schema で oneOf が実際に使われている（机上の話ではない）', () => {
    const used: string[] = []
    const walk = (node: unknown, file: string) => {
      if (Array.isArray(node)) return node.forEach((x) => walk(x, file))
      if (node && typeof node === 'object') {
        if ('oneOf' in (node as Record<string, unknown>)) used.push(file)
        Object.values(node as Record<string, unknown>).forEach((x) => walk(x, file))
      }
    }
    const files = readdirSync(resolve(ROOT, 'schemas')).filter((f) => f.endsWith('.schema.json'))
    expect(files.length, 'schema が 1 本も無い').toBeGreaterThan(10)
    for (const f of files) walk(JSON.parse(readFileSync(resolve(ROOT, 'schemas', f), 'utf8')), f)
    mustBeNonEmpty(used, 'oneOf を使っている schema')
  })
})

// ---------------------------------------------------------------- ①-c allowlist の反例

/**
 * **`oneOf` を直した直後に、同じ形の穴が 3 つ出た（外部監査 2026-08-05・第2回）。**
 *
 * どれも「判定器が知らない／扱いきれない構文の周りで、他の keyword の意味が変わる」型である。
 * 個別に塞いでいくと、列挙漏れがそのまま危険側の穴になる。
 * **v0.5.2 で allowlist 方式へ変えた**——扱えると宣言した keyword の集合を決め、
 * それ以外が現れたら（かつ何か変わっていたら）無条件で UNDEC へ倒す。
 *
 * ②は v0.5.1 tag の実物を読み込んで**修正前の挙動**も実測する。
 * ①だけだと「昔からこうだった」のか「直した」のかを記録でしか主張できない。
 */
interface Counter { id: string, name: string, old: object, neu: object, vals: unknown[], before: string }

const COUNTEREXAMPLES: Counter[] = [
  {
    id: 'REF_WITH_SIBLING',
    name: '$ref に sibling があると参照変更を見落とす',
    old: { $schema: DRAFT7, $ref: '#/definitions/a', description: 'neutral', definitions: { a: { type: 'string' }, b: { type: 'number' } } },
    neu: { $schema: DRAFT7, $ref: '#/definitions/b', description: 'neutral', definitions: { a: { type: 'string' }, b: { type: 'number' } } },
    vals: ['text', 42],
    before: 'HOLD',
  },
  {
    id: 'SCHEMA_ADDITIONAL_PROPERTIES',
    name: 'schema 型 additionalProperties へ項目を足す',
    old: { $schema: DRAFT7, type: 'object', additionalProperties: { type: 'string' } },
    neu: { $schema: DRAFT7, type: 'object', properties: { x: {} }, additionalProperties: { type: 'string' } },
    vals: [{ x: 42 }, { x: 's' }, { y: 42 }],
    before: 'HOLD_RECORD',
  },
  {
    id: 'PATTERN_PROPERTIES',
    name: 'patternProperties があるのに項目を消す',
    old: { $schema: DRAFT7, type: 'object', properties: { x: { type: 'number' } }, patternProperties: { '^x$': {} }, additionalProperties: false },
    neu: { $schema: DRAFT7, type: 'object', patternProperties: { '^x$': {} }, additionalProperties: false },
    vals: [{ x: 'text' }, { x: 1 }, { y: 1 }],
    before: 'HOLD_RECORD',
  },
]

describe('条文 ①-c allowlist の反例（外部監査 2026-08-05・第2回）', () => {
  it.each(COUNTEREXAMPLES.map((c) => [c.name, c] as const))(
    '① ajv: %s — 新は旧に収まっていない',
    (_n, c) => {
      const compile = (s: object) => new Ajv({ allErrors: true, strict: false }).compile(s)
      const o = compile(c.old)
      const n = compile(c.neu)
      const widened = c.vals.some((v) => n(structuredClone(v)) && !o(structuredClone(v)))
      // **広がった値が実在すること。**これが無いと反例が成立していない
      expect(widened, `${c.id}: 新だけが通す値が無い（反例の前提が崩れている）`).toBe(true)
    },
  )

  it('② v0.5.1 の実装は 3 件とも危険側を返した（修正前の実測）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'v051diff-'))
    tmpDirs.push(dir)
    const p = join(dir, 'schemaLanguageDiff.mjs')
    const src = execFileSync('git', ['show', 'v0.5.1:scripts/schemaLanguageDiff.mjs'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 << 20 })
    expect(src.length, 'v0.5.1 の実装が空').toBeGreaterThan(1000)
    // **allowlist が無かったこと自体も確かめる**（消えていたら反例が的外れになる）
    expect(src).not.toContain('HANDLED')
    writeFileSync(p, src)
    const old = await import(/* @vite-ignore */ p)

    for (const c of COUNTEREXAMPLES) {
      const r = old.diffSchemaObjects(c.old, c.neu)
      expect(r.verdict, `${c.id}: v0.5.1 の判定`).toBe(c.before)
      expect(r.verdict, `${c.id}: 危険側でなければ反例になっていない`).not.toBe('BUMP')
    }
    // **3.1 は差分 0 件の HOLD だった。**何も見えていないのに「変わっていない」と言う
    const silent = old.diffSchemaObjects(COUNTEREXAMPLES[0].old, COUNTEREXAMPLES[0].neu)
    expect(silent.facts.length, 'v0.5.1 は $ref の変更で差分を 1 件も出さなかったはず').toBe(0)
  })

  it.each(COUNTEREXAMPLES.map((c) => [c.name, c] as const))(
    '③ 現在の実装は BUMP を返し、差分も出す — %s',
    (_n, c) => {
      const r = diffSchemaObjects(c.old, c.neu)
      expect(r.verdict, c.id).toBe('BUMP')
      // **判定が合っただけでは足りない。**差分 0 件の BUMP はありえない
      expect(r.facts.length, `${c.id}: 判定は BUMP だが差分が 0 件`).toBeGreaterThan(0)
      expect(r.facts.some((f: { kind: string }) => f.kind === 'UNDEC'), `${c.id}: UNDEC 以外の理由で BUMP になっている`).toBe(true)
    },
  )
})

describe('条文 ①-c2 sibling 付き $ref の参照先（v0.5.2 の実装中に見つけた 4 件目）', () => {
  /**
   * 3 反例を直す過程で、**節は同じまま参照先だけ変わる**場合が見えていないことに気づいた。
   * allowlist ゲートは「その節が変わっていれば」倒すので、節が同じだと鳴らない。
   * `deref()` も sibling があると辿らない。**どちらの網にもかからなかった。**
   */
  const OLD = {
    $schema: DRAFT7,
    properties: { x: { $ref: '#/definitions/g', description: 'sibling があるので deref が辿らない' } },
    definitions: { g: { type: 'string' } },
  }

  it('節は同じで definitions の中身だけ変わっても見える', () => {
    const neu = structuredClone(OLD) as any
    neu.definitions.g = { type: 'number' }
    const r = diffSchemaObjects(OLD, neu)
    expect(r.verdict).toBe('BUMP')
    expect(r.facts.length, '差分 0 件の BUMP はありえない').toBeGreaterThan(0)
    expect(r.facts.map((f: { pointer: string }) => f.pointer).join(' '), '参照先を辿った位置で出ていない').toContain('/$ref')
  })

  it('同一 schema 同士は HOLD のまま（倒しすぎていない）', () => {
    expect(diffSchemaObjects(OLD, structuredClone(OLD)).verdict).toBe('HOLD')
  })

  it('この構文は live な schema に実在する（机上ではない）', () => {
    const found: string[] = []
    const walk = (n: unknown, f: string) => {
      if (Array.isArray(n)) return n.forEach((x) => walk(x, f))
      if (!n || typeof n !== 'object') return
      const o = n as Record<string, unknown>
      if ('$ref' in o && Object.keys(o).length > 1) found.push(f)
      Object.values(o).forEach((x) => walk(x, f))
    }
    for (const f of readdirSync(resolve(ROOT, 'schemas')).filter((x) => x.endsWith('.schema.json'))) {
      walk(JSON.parse(readFileSync(resolve(ROOT, 'schemas', f), 'utf8')), f)
    }
    mustBeNonEmpty(found, 'sibling 付き $ref を持つ schema')
  })
})

describe('条文 ①-d allowlist そのもの', () => {
  it('宣言集合が、現行 schema の使う keyword をすべて覆っている', () => {
    const APPLICATORS = new Set(['properties', 'definitions', '$defs', 'patternProperties', 'dependencies'])
    const SUBSCHEMA = new Set(['items', 'additionalItems', 'additionalProperties', 'contains', 'not', 'propertyNames', 'if', 'then', 'else'])
    const LISTS = new Set(['oneOf', 'anyOf', 'allOf'])
    const used = new Set<string>()
    const walk = (n: unknown) => {
      if (!n || typeof n !== 'object' || Array.isArray(n)) return
      for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
        used.add(k)
        if (APPLICATORS.has(k) && v && typeof v === 'object') Object.values(v as object).forEach(walk)
        else if (SUBSCHEMA.has(k)) (Array.isArray(v) ? v : [v]).forEach(walk)
        else if (LISTS.has(k) && Array.isArray(v)) v.forEach(walk)
      }
    }
    const files = readdirSync(resolve(ROOT, 'schemas')).filter((f) => f.endsWith('.schema.json'))
    expect(files.length, 'schema が無い（走査が動いていない）').toBeGreaterThan(15)
    for (const f of files) walk(JSON.parse(readFileSync(resolve(ROOT, 'schemas', f), 'utf8')))
    expect(used.size, '使われている keyword が少なすぎる').toBeGreaterThan(15)

    // **宣言外の keyword が schema に現れたら落ちる。**
    // 落ちたら「判定器を直す」か「宣言集合へ足す」かを、その場で決めること
    const undeclared = [...used].filter((k) => !HANDLED_KEYWORDS.has(k)).sort()
    expect(undeclared, '宣言外の keyword が schema に現れている').toEqual([])
  })

  it('宣言集合は「全部入り」ではない（何も弾かない allowlist は allowlist ではない）', () => {
    for (const k of ['patternProperties', 'dependencies', 'if', 'then', 'else', 'not', 'contains', 'propertyNames', 'multipleOf', 'format']) {
      expect(HANDLED_KEYWORDS.has(k), `${k} を宣言集合へ入れてはいけない（判定器は扱えない）`).toBe(false)
    }
  })
})

// ---------------------------------------------------------------- ② 遡及

/** 版を据え置いたまま契約を変えた 7 件。**すべて条文違反である** */
const HISTORY = [
  ['v0.3.0', 'v0.4.0', 'schemas/half-plug-topology-profile.v2.schema.json', 'role の enum に input-scope'],
  ['v0.3.0', 'v0.4.0', 'schemas/event-sensitivity.v1.schema.json', 'role の enum に input-scope'],
  ['v0.3.0', 'v0.4.0', 'schemas/topology-robustness.v2.schema.json', 'role の enum に input-scope'],
  ['v0.3.0', 'v0.4.0', 'schemas/source-input-manifest.v1.schema.json', 'inputScope を追加'],
  ['v0.3.0', 'v0.4.0', 'schemas/validation-results.v1.schema.json', 'results[].schema の型に null'],
  ['v0.4.0', 'v0.4.1', 'schemas/validation-results.v1.schema.json', '4 項目追加'],
  ['v0.4.0', 'v0.4.1', 'schemas/test-counts.v1.schema.json', '8 項目追加'],
] as const

describe('条文 ② 過去へ当てる', () => {
  it.each(HISTORY.map((h) => [`${h[0]}→${h[1]} ${h[2].replace('schemas/', '')}`, h] as const))(
    '%s は「上げるべきだった」',
    (_n, [from, to, path]) => {
      const r = diffSchemaObjects(atTag(from, path) as any, atTag(to, path) as any)
      expect(r.verdict, `${from}→${to} ${path}`).toBe('BUMP')
      expect(r.facts.length, '差分が 0 件なら比較対象を間違えている').toBeGreaterThan(0)
    },
  )

  it('7 件すべてで版が据え置かれていた（違反であることの確認）', () => {
    for (const [from, to, path] of HISTORY) {
      const a = atTag(from, path) as any
      const b = atTag(to, path) as any
      const av = a.properties?.schemaVersion?.const
      const bv = b.properties?.schemaVersion?.const
      expect(av, `${path} に schemaVersion const が無い`).toBeTypeOf('number')
      expect(bv, `${to}:${path} で版が上がっている（この表の前提が崩れている）`).toBe(av)
    }
  })
})

// ---------------------------------------------------------------- ③ 対照

/** 同じ区間で中身が変わらなかった schema。**条文は黙らなければならない** */
const UNCHANGED = [
  ['v0.4.0', 'v0.4.1', 'schemas/half-plug-topology-profile.v2.schema.json'],
  ['v0.4.0', 'v0.4.1', 'schemas/event-sensitivity.v1.schema.json'],
  ['v0.4.0', 'v0.4.1', 'schemas/topology-robustness.v2.schema.json'],
  ['v0.4.0', 'v0.4.1', 'schemas/source-input-manifest.v1.schema.json'],
  ['v0.4.0', 'v0.4.1', 'schemas/trs-jack-3d-release-index.v1.schema.json'],
  ['v0.3.0', 'v0.4.1', 'schemas/topology-search.v1.schema.json'],
  ['v0.3.0', 'v0.4.1', 'schemas/real-jack-comparison.v1.schema.json'],
] as const

describe('条文 ③ 対照（何にでも鳴らないこと）', () => {
  it.each(UNCHANGED.map((u) => [`${u[0]}→${u[1]} ${u[2].replace('schemas/', '')}`, u] as const))(
    '%s は HOLD',
    (_n, [from, to, path]) => {
      const r = diffSchemaObjects(atTag(from, path) as any, atTag(to, path) as any)
      expect(r.verdict, `${from}→${to} ${path}: 差分 ${JSON.stringify(r.facts)}`).toBe('HOLD')
    },
  )

  it('対照は「読めていない」ではなく「読めて同じ」である', () => {
    // 対照が空ファイルを読んで一致していたら、③ は何も検査していない
    for (const [from, to, path] of UNCHANGED) {
      const a = atTag(from, path) as any
      const b = atTag(to, path) as any
      expect(Object.keys(a.properties ?? {}).length, `${from}:${path} が空`).toBeGreaterThan(3)
      expect(Object.keys(b.properties ?? {}).length, `${to}:${path} が空`).toBeGreaterThan(3)
    }
  })
})

// ---------------------------------------------------------------- 現行 schema への適用

describe('条文 現行 schema', () => {
  it('v0.5.0 で上げた 6 本は、旧版に対して BUMP と判定される', () => {
    const BUMPED: readonly (readonly [string, string])[] = [
      ['schemas/half-plug-topology-profile.v2.schema.json', 'schemas/half-plug-topology-profile.v3.schema.json'],
      ['schemas/event-sensitivity.v1.schema.json', 'schemas/event-sensitivity.v2.schema.json'],
      ['schemas/topology-robustness.v2.schema.json', 'schemas/topology-robustness.v3.schema.json'],
      ['schemas/source-input-manifest.v1.schema.json', 'schemas/source-input-manifest.v2.schema.json'],
      ['schemas/validation-results.v1.schema.json', 'schemas/validation-results.v2.schema.json'],
      ['schemas/test-counts.v1.schema.json', 'schemas/test-counts.v2.schema.json'],
    ]
    expect(BUMPED.length, '版を上げた schema の数').toBe(6)
    for (const [oldP, newP] of BUMPED) {
      const r = diffSchemaFiles(resolve(ROOT, oldP), resolve(ROOT, newP))
      expect(r.verdict, `${oldP} → ${newP}`).toBe('BUMP')
    }
  })

  /**
   * **v0.5.1 は版を 1 本も上げていない。**
   * 条文どおりなら、v0.5.0 にあった schema はすべて言語が変わっていないはずである。
   * ここが BUMP を返したら、**版を据え置いたまま契約を変えた**ことになる（＝過去 9 件と同じ違反）。
   */
  it('直近 tag の全 schema が、現在も言語が変わっていない（版を据え置いてよい根拠）', () => {
    const tagged = execFileSync('git', ['ls-tree', '-r', '--name-only', LATEST_TAG, '--', 'schemas/'], { cwd: ROOT, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean)
    expect(tagged.length, `${LATEST_TAG} に schema が無い（走査が動いていない）`).toBeGreaterThan(15)

    const bumped: string[] = []
    let compared = 0
    for (const p of tagged) {
      const now = resolve(ROOT, p)
      if (!existsSync(now)) {
        bumped.push(`${p}: 消えている`)
        continue
      }
      compared++
      const r = diffSchemaObjects(atTag(LATEST_TAG, p) as any, JSON.parse(readFileSync(now, 'utf8')))
      if (r.verdict === 'BUMP') bumped.push(`${p}: ${JSON.stringify(r.facts.slice(0, 2))}`)
    }
    expect(compared, '比較した本数').toBe(tagged.length)
    expect(bumped, '版を据え置いたまま言語を変えている').toEqual([])
  })

  it('据え置いた schema は tag v0.4.1 から言語が変わっていない', () => {
    const HELD = [
      'schemas/trs-jack-3d-release-index.v1.schema.json',
      'schemas/source-input-scope.v1.schema.json',
      'schemas/source-verification-result.v1.schema.json',
      'schemas/topology-search.v1.schema.json',
      'schemas/real-jack-comparison.v1.schema.json',
    ]
    for (const p of HELD) {
      const r = diffSchemaObjects(atTag('v0.4.1', p) as any, JSON.parse(readFileSync(resolve(ROOT, p), 'utf8')))
      expect(r.verdict, `${p} を据え置いたが言語が変わっている: ${JSON.stringify(r.facts)}`).not.toBe('BUMP')
    }
  })
})

/**
 * **互換性の 2 つ目の軸（v0.6.16・外部監査 2026-08-14）。**
 *
 * 条文はこれまで **producer-forward**（新しい出力が古い schema を通るか）しか見ていなかった。
 * `HOLD_RECORD`（狭まった＝据え置き可）はその軸の話で、**狭めても新しい出力は通る。**
 *
 * もう 1 つの軸は **historical-instance**——**保存した古い結果が、新しい schema を通るか。**
 * こちらは通らない。v0.6.15 で `policyId` を必須にした時点で、
 * v0.6.14 の保存済み出力は同じ v1 schema から外れた。
 *
 * 版数では解けないので、**結果ごとに突合先の schema を固定する**方針にした
 * （`docs/SCHEMA_VERSIONING_POLICY.md` 第7条 ／ release index の `verifierContract`）。
 * ここはその方針が**実際に成り立っているか**を、過去 tag の実物で確かめる。
 */
describe('条文 ⑦ 互換性の 2 軸（historical-instance）', () => {
  const TAG = 'v0.6.14'
  const SCHEMA_REL = 'schemas/source-verifier-cli-result.v1.schema.json'

  /** その tag の道具を走らせて、実際の出力を得る */
  function outputAt(tag: string): Record<string, unknown> {
    const d = mkdtempSync(join(tmpdir(), `hist-${tag}-`))
    const tool = join(d, 'verifier.mjs')
    writeFileSync(tool, execFileSync('git', ['show', `${tag}:scripts/verifyReleaseSourceInputs.mjs`],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }))
    try {
      return JSON.parse(execFileSync('node',
        [tool, '--manifest', 'artifacts/source-input-manifest.json', '--source', '.'],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }))
    } catch (e) {
      return JSON.parse(String((e as { stdout?: string }).stdout ?? '{}'))
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  }

  const compile = (s: object) => new Ajv({ allErrors: true, strict: false }).compile(s)
  const schemaAt = (tag: string) => JSON.parse(
    execFileSync('git', ['show', `${tag}:${SCHEMA_REL}`], { cwd: ROOT, encoding: 'utf8' }))

  it('**その版の出力は、その版の schema を通る**（配った組み合わせは成立している）', () => {
    expect(compile(schemaAt(TAG))(outputAt(TAG)), `${TAG} の出力が ${TAG} の schema を通らない`).toBe(true)
  })

  it('**新しい出力は、古い schema も通る**（producer-forward は保たれている）', () => {
    const now = JSON.parse(readFileSync(resolve(ROOT, SCHEMA_REL), 'utf8'))
    const out = JSON.parse(execFileSync('node',
      ['scripts/verifyReleaseSourceInputs.mjs', '--manifest', 'artifacts/source-input-manifest.json', '--source', '.'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }))
    expect(compile(now)(out), '現行の出力が現行の schema を通らない').toBe(true)
    expect(compile(schemaAt(TAG))(out), '現行の出力が古い schema を通らない（producer-forward が壊れた）').toBe(true)
  })

  /**
   * **ここが条文の本体。**「最新 schema で過去の結果を検証してはいけない」を、
   * **実際に落ちること**で示す。落ちなくなったら、方針の前提が変わったということなので
   * 第7条を書き直すこと（黙って通さない）。
   */
  it('**保存した古い出力は、最新の同じ v1 schema では通らない**（だから版ごとに固定する）', () => {
    const now = JSON.parse(readFileSync(resolve(ROOT, SCHEMA_REL), 'utf8'))
    expect(compile(now)(outputAt(TAG)),
      `${TAG} の出力が最新 schema を通ってしまった。第7条の前提が変わっている`).toBe(false)
  })

  /**
   * **索引が「どれが契約か」を名指ししている（v0.6.16）。**
   *
   * 欄を足す案は採らなかった——`additionalProperties: false` の schema へ欄を足すのは
   * 言語の拡大で、判定器が **BUMP**（索引を v2 にする）と出す。
   * **pin となる digest は既に `assets` に在る**ので、増やさず名指しする形にした。
   */
  it('**release index が、突合先と信頼の起点を名指ししている**', () => {
    const idx = JSON.parse(readFileSync(resolve(ROOT, 'artifacts/trs-jack-3d-release-index.v1.json'), 'utf8'))
    const notes = (idx.notes as string[]).join('\n')
    expect(notes, '信頼の起点を言っていない').toContain('信頼の起点')
    expect(notes, '保存した結果の突合先を言っていない').toContain('保存した検算結果は')
    /** 名指しした値が、実際に `assets` に在るものと一致すること */
    const find = (n: string) => (idx.assets as { filename: string, sha256: string }[])
      .find((a) => a.filename === n)?.sha256
    const toolSha = find('verifyReleaseSourceInputs.mjs')
    const schemaSha = find('source-verifier-cli-result.v1.schema.json')
    expect(toolSha, '道具が assets に無い').toMatch(/^[0-9a-f]{64}$/)
    expect(notes, `道具の sha256 が本文と食い違う`).toContain(String(toolSha))
    /** assets の値が、いまの実ファイルのものであること（**古い pin を名指ししていない**） */
    expect(schemaSha).toBe(createHash('sha256').update(readFileSync(resolve(ROOT, SCHEMA_REL))).digest('hex'))
  })
})
