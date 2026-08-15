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
import { CLI_RESULT_SCHEMA_PATH } from '../scripts/verifyReleaseSourceInputs.mjs'
import { mustBeNonEmpty } from './_must'

const ROOT = resolve(__dirname, '..')

/** Draft-07。反例は ajv でも同じ dialect で流す */
const DRAFT7 = 'http://json-schema.org/draft-07/schema#'

/**
 * **直前の release tag を、毎回その場で決める（v0.6.17・外部監査 P0）。**
 *
 * v0.6.16 まで、ここは `const LATEST_TAG = 'v0.5.1'` の直書きだった。
 * 「上げた回はここを進める」とコメントに書いてあったが、**11 版のあいだ進まなかった。**
 * 結果として、
 *
 *   - 母集団が **v0.5.1 に在った 21 本**に固定され、
 *   - v0.6.11 で新設した `source-verifier-cli-result.v1` は**一度も検査に入らず**、
 *   - v0.6.16 が版を据え置いたまま enum を 3 か所広げても、**57/57 全緑**だった（2026-08-15 実測）。
 *
 * 「比較した本数 === 母集団の本数」という空振り検査は付いていたが、
 * **数えていたのは古いほうの一覧**なので、新しい契約が抜けても鳴らない。
 *
 * 直す形: **準備中の版は `package.json` が知っている。**それより小さい最大の tag が直前の release。
 * tag CI（`HEAD` に tag が付いた状態）でも、自分自身は選ばれない。
 */
function previousReleaseTag(): string {
  const pkg = (JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { version: string }).version
  const num = (v: string) => v.replace(/^v/, '').split('.').map(Number)
  const lt = (a: number[], b: number[]) => a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2]
  const here = num(pkg)
  const tags = execFileSync('git', ['tag', '-l', 'v*.*.*'], { cwd: ROOT, encoding: 'utf8' })
    .trim().split('\n').filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
  const older = tags.filter((t) => lt(num(t), here)).sort((a, b) => (lt(num(a), num(b)) ? -1 : 1))
  if (older.length === 0) {
    throw new Error(`package.json の ${pkg} より小さい release tag が無い。`
      + '**この検査は tag の実物を読む。**浅い clone では tag が無いので `git fetch --tags` すること。')
  }
  return older[older.length - 1]
}

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

// ---------------------------------------------------------------- ①-c3 oneOf の枝が $ref

/**
 * **`oneOf` の枝が `$ref` のとき、参照先だけが変わっても見えなかった（5 件目）。**
 *
 * 見つけ方が今までと違う。**外部監査ではなく、ランダム生成した schema 対から出た**
 * （`test/_schemaFuzz.mjs`・計画 `docs/V060_PLAN_20260805.md` §3 が [AI] で
 * 約束したまま 10 日落ちていた property-based 試験）。961 対のうち 4 件。
 *
 * ## 何が起きていたか
 *
 * `oneOf` は枝の言語について単調でないので、**変更があれば無条件で UNDEC へ倒す**設計である。
 * その「変更があったか」を `JSON.stringify(o.oneOf) !== JSON.stringify(n.oneOf)` で見ていた。
 *
 * 枝が `{ $ref: '#/definitions/d0' }` なら、参照先が変わっても**枝の文字列は同じ**。
 * → 変更なしと見なす → 他に差分が無ければ **HOLD**（据え置き可）。
 *
 * ```
 * 旧  { oneOf: [{ type:'string' }, { $ref:'#/definitions/d0' }], definitions:{ d0:{ type:'boolean' } } }
 * 新  同じ。ただし definitions.d0.type が ['boolean','null']
 *
 * ajv   null は 旧 invalid → 新 valid   **広がっている**
 * 判定  HOLD                            ← 危険側（上げるべきなのに据え置き可）
 * ```
 *
 * **root が `$ref` の場合は正しく BUMP を返す**（`deref()` が入口で辿るため）。
 * `oneOf` の枝だけが素通りしていた。
 */
describe('条文 ①-c3 oneOf の枝が $ref・参照先だけ変わる（property-based で発見）', () => {
  const S = 'http://json-schema.org/draft-07/schema#'
  const OLD = { $schema: S, oneOf: [{ type: 'string' }, { $ref: '#/definitions/d0' }], definitions: { d0: { type: 'boolean' } } }
  const NEW = { $schema: S, oneOf: [{ type: 'string' }, { $ref: '#/definitions/d0' }], definitions: { d0: { type: ['boolean', 'null'] } } }

  it('① ajv: null が旧 invalid → 新 valid（＝新は旧に収まっていない）', () => {
    const compile = (s: object) => new Ajv({ allErrors: true, strict: false }).compile(s)
    const o = compile(OLD); const n = compile(NEW)
    expect(o(null), '旧で null が通ってしまう（反例の前提が崩れている）').toBe(false)
    expect(n(null), '新で null が通らない（反例の前提が崩れている）').toBe(true)
    // 枝の文字列は同じ＝素朴な比較では差分が見えない、という前提も固定する
    expect(JSON.stringify(OLD.oneOf)).toBe(JSON.stringify(NEW.oneOf))
  })

  it('② 判定器は BUMP を返す', () => {
    expect(diffSchemaObjects(OLD, NEW).verdict).toBe('BUMP')
  })

  it('③ **その経路が鳴っている**（別の理由で BUMP になっていない）', () => {
    const r = diffSchemaObjects(OLD, NEW)
    const blob = r.facts.map((f: { kind: string, pointer: string, detail: string }) => `${f.kind} ${f.pointer} ${f.detail}`).join('\n')
    expect(blob, 'oneOf の経路で倒れていない').toContain('oneOf')
  })

  it('④ 対照: 参照先が変わらなければ HOLD のまま（何にでも鳴らない）', () => {
    expect(diffSchemaObjects(OLD, structuredClone(OLD)).verdict).toBe('HOLD')
  })

  it('⑤ 対照: root が $ref の場合は前から正しかった', () => {
    const o = { $schema: S, $ref: '#/definitions/d0', definitions: { d0: { type: 'boolean' } } }
    const n = { $schema: S, $ref: '#/definitions/d0', definitions: { d0: { type: ['boolean', 'null'] } } }
    expect(diffSchemaObjects(o, n).verdict).toBe('BUMP')
  })
})

/**
 * ⚠️ **条文 ①-c4（v0.6.22・外部監査 P0）。**
 *
 * v0.6.21 で `oneOf` の枝の `$ref` を展開するようにしたが、**展開したのは
 * `$ref` が唯一の key のときだけ**だった（`expandRefs` の
 * `Object.keys(node).length === 1`）。枝が
 *
 * ```json
 * { "$ref": "#/definitions/d0", "description": "branch" }
 * ```
 *
 * のように **annotation の sibling を持つと展開されない。**枝の文字列は新旧同じままなので
 * 参照先の変更が見えず、他に差分が無ければ **HOLD** を返していた。
 *
 * ```text
 * 旧  definitions.d0.type = 'string'
 * 新  definitions.d0.type = ['string','null']
 * ajv  {"x":null} が旧 invalid → 新 valid   **広がっている**
 * 判定 HOLD / exit 0                        ← 危険側
 * ```
 *
 * **`compare()` には「節は同じで参照先だけ変わった」を見る仕組みが既にある**が、
 * `oneOf` の枝は `compare()` を通らない（枝ごとの再帰比較は健全でないので、
 * 文字列の一致だけを見ている）。**仕組みが在る場所と、通る経路が違っていた。**
 */
describe('条文 ①-c4 oneOf の枝が $ref + sibling・参照先だけ変わる（外部監査 P0）', () => {
  const S = 'http://json-schema.org/draft-07/schema#'
  const branch = { $ref: '#/definitions/d0', description: 'branch' }
  const body = { type: 'object', additionalProperties: false, properties: { x: { oneOf: [branch, { type: 'number' }] } } }
  const OLD = { $schema: S, definitions: { d0: { type: 'string' } }, ...body }
  const NEW = { $schema: S, definitions: { d0: { type: ['string', 'null'] } }, ...body }

  it('① ajv: {"x":null} が旧 invalid → 新 valid（＝新は旧に収まっていない）', () => {
    const compile = (s: object) => new Ajv({ allErrors: true, strict: false }).compile(s)
    const o = compile(structuredClone(OLD)); const n = compile(structuredClone(NEW))
    expect(o({ x: null }), '旧で通ってしまう（反例の前提が崩れている）').toBe(false)
    expect(n({ x: null }), '新で通らない（反例の前提が崩れている）').toBe(true)
    // 枝の文字列は同じ＝素朴な比較でも v0.6.21 の展開でも差分が見えない、という前提を固定する
    expect(JSON.stringify(OLD.properties.x.oneOf)).toBe(JSON.stringify(NEW.properties.x.oneOf))
  })

  it('② 判定器は BUMP を返す', () => {
    expect(diffSchemaObjects(OLD, NEW).verdict).toBe('BUMP')
  })

  it('③ 対照: 参照先が変わらなければ HOLD のまま（何にでも鳴らない）', () => {
    expect(diffSchemaObjects(OLD, structuredClone(OLD)).verdict).toBe('HOLD')
  })

  it('④ 対照: sibling が無い形（v0.6.21 で直した分）は今も BUMP', () => {
    const o = { $schema: S, definitions: { d0: { type: 'string' } }, oneOf: [{ type: 'number' }, { $ref: '#/definitions/d0' }] }
    const n = { $schema: S, definitions: { d0: { type: ['string', 'null'] } }, oneOf: [{ type: 'number' }, { $ref: '#/definitions/d0' }] }
    expect(diffSchemaObjects(o, n).verdict).toBe('BUMP')
  })
})

/**
 * ⚠️ **条文 ①-c5（v0.6.22・外部監査 P0）。同じ根の 2 つ目。**
 *
 * allowlist ゲートは「宣言外の keyword が在る」だけで倒すが、
 * **`JSON.stringify(o) !== JSON.stringify(n)` を条件にしている。**
 * 節そのものが変わらず、**その中の `$ref` の参照先だけが変わる**と条件を満たさない。
 *
 * ```text
 * definitions.outer = { not: { $ref: '#/definitions/inner' } }   ← 新旧まったく同じ
 * 旧  definitions.inner.type = ['string','null']
 * 新  definitions.inner.type = 'string'
 * ajv  {"x":null} が旧 invalid → 新 valid   **広がっている**（not の中が狭まると外は広がる）
 * 判定 HOLD / exit 0                        ← 危険側
 * ```
 *
 * **同じ節を同じにしておけば検査を免れる**——①-c4 と根は同じで、
 * 「節の文字列が変わっていない」ことを「意味が変わっていない」の証拠にしていた。
 */
describe('条文 ①-c5 未対応 keyword が包む $ref の参照先だけ変わる（外部監査 P0）', () => {
  const S = 'http://json-schema.org/draft-07/schema#'
  const shell = {
    type: 'object',
    additionalProperties: false,
    properties: { x: { $ref: '#/definitions/outer' } },
  }
  const OLD = { $schema: S, ...shell, definitions: { outer: { not: { $ref: '#/definitions/inner' } }, inner: { type: ['string', 'null'] } } }
  const NEW = { $schema: S, ...shell, definitions: { outer: { not: { $ref: '#/definitions/inner' } }, inner: { type: 'string' } } }

  it('① ajv: {"x":null} が旧 invalid → 新 valid', () => {
    const compile = (s: object) => new Ajv({ allErrors: true, strict: false }).compile(s)
    const o = compile(structuredClone(OLD)); const n = compile(structuredClone(NEW))
    expect(o({ x: null }), '旧で通ってしまう（反例の前提が崩れている）').toBe(false)
    expect(n({ x: null }), '新で通らない（反例の前提が崩れている）').toBe(true)
    // 未対応 keyword を包む節は新旧まったく同じ、という前提を固定する
    expect(JSON.stringify(OLD.definitions.outer)).toBe(JSON.stringify(NEW.definitions.outer))
  })

  it('② 判定器は BUMP を返す', () => {
    expect(diffSchemaObjects(OLD, NEW).verdict).toBe('BUMP')
  })

  it('③ 対照: 参照先が変わらなければ HOLD のまま', () => {
    expect(diffSchemaObjects(OLD, structuredClone(OLD)).verdict).toBe('HOLD')
  })

  it('④ 対照: 未対応 keyword の節そのものが変われば、前から倒れていた', () => {
    const n2 = structuredClone(OLD) as { definitions: { outer: { not: { $ref?: string, type?: string } } } }
    n2.definitions.outer.not = { type: 'string' }
    expect(diffSchemaObjects(OLD, n2).verdict).toBe('BUMP')
  })
})

/**
 * ⚠️ **条文 ①-c6（v0.6.22）。同じ根の 3 つ目——こちらは監査の指摘には無い。**
 *
 * ①-c4 / ①-c5 を直すとき「文字列の一致を意味の一致と置いた箇所」を数えたら、
 * `anyOf` / `allOf` の**早期 continue** が 3 つ目だった。
 *
 * ```js
 * if (JSON.stringify(ol) === JSON.stringify(nl)) continue   // ← 参照先を見ていない
 * ```
 *
 * `anyOf` / `allOf` は枝ごとの再帰比較が健全なので、**再帰へ入りさえすれば**
 * 「$ref に sibling がある節の参照先」が拾う。**入る前に打ち切っていた。**
 *
 * この節が無いと、直した 3 か所のうちここだけ**外しても落ちない行**になる
 * （変異対照で実測: 直す前は 75 件すべて通った）。
 */
describe('条文 ①-c6 anyOf/allOf の枝が $ref + sibling・参照先だけ変わる', () => {
  const S = 'http://json-schema.org/draft-07/schema#'
  const branch = { $ref: '#/definitions/d0', description: 'branch' }
  const mk = (kw: 'anyOf' | 'allOf', d0: object, other: object) => ({
    $schema: S,
    definitions: { d0 },
    type: 'object',
    additionalProperties: false,
    properties: { x: { [kw]: [branch, other] } },
  })
  const compile = (s: object) => new Ajv({ allErrors: true, strict: false }).compile(structuredClone(s))

  it('① anyOf: ajv で広がっていることを確かめ、判定器が BUMP を返す', () => {
    const OLD = mk('anyOf', { type: 'string' }, { type: 'number' })
    const NEW = mk('anyOf', { type: ['string', 'null'] }, { type: 'number' })
    expect(compile(OLD)({ x: null }), '旧で通ってしまう').toBe(false)
    expect(compile(NEW)({ x: null }), '新で通らない').toBe(true)
    expect(JSON.stringify(OLD.properties.x.anyOf), '枝の文字列が違う（前提が崩れている）')
      .toBe(JSON.stringify(NEW.properties.x.anyOf))
    expect(diffSchemaObjects(OLD, NEW).verdict).toBe('BUMP')
  })

  it('② allOf: 同じ形で BUMP を返す', () => {
    const OLD = mk('allOf', { type: ['string', 'null'] }, { type: ['string', 'null', 'number'] })
    const NEW = mk('allOf', { type: ['string', 'null', 'number'] }, { type: ['string', 'null', 'number'] })
    expect(compile(OLD)({ x: 1 }), '旧で通ってしまう').toBe(false)
    expect(compile(NEW)({ x: 1 }), '新で通らない').toBe(true)
    expect(JSON.stringify(OLD.properties.x.allOf), '枝の文字列が違う（前提が崩れている）')
      .toBe(JSON.stringify(NEW.properties.x.allOf))
    expect(diffSchemaObjects(OLD, NEW).verdict).toBe('BUMP')
  })

  it('③ 対照: 参照先が変わらなければ HOLD のまま', () => {
    const OLD = mk('anyOf', { type: 'string' }, { type: 'number' })
    expect(diffSchemaObjects(OLD, structuredClone(OLD)).verdict).toBe('HOLD')
  })
})

/**
 * ⚠️ **条文 ①-c7〜①-c10（v0.6.23・外部監査 P0）。根は 1 つで、逃げ道が 6 本あった。**
 *
 * v0.6.22 は「**節の文字列が変わっていない**」を「**意味が変わっていない**」の証拠に
 * していた 3 か所を直した。今回の根はその隣にある——
 * **「解決できなかった／扱えなかった」を「変わっていない」と同じ扱いにしていた**（fail-open）。
 *
 * ```text
 * E1 expandRefs 深さ上限を超えた          → return node（諦めたことを誰にも伝えない）
 * E2 expandRefs 循環を見つけた            → return node
 * E3 expandRefs 参照先を解決できない       → return node
 * E4 expandRefs 参照先が object でない     → return node（boolean schema は正当な schema）
 * E5 deref が RFC 6901 の ~0 / ~1 を復号しない → E3 へ落ちる
 * E6 compare() が schema object でない節を素の文字列でしか比べない（tuple 形式の items）
 * ```
 *
 * **諦めた側と諦めなかった側の出力が同じ**なので、新旧そろって諦めると「同じ」に見える。
 *
 * 監査の反例 4 件は E6 / E5 / E1 / E4 に当たる。E2 と E3 は反例をもらっていないが、
 * **同じ根なので一緒に倒す**（数え直して見つけた分。①-c6 と同じ手順）。
 *
 * **現行 schema にこの 4 形は 1 件も無い**（tuple items 0 / `$ref`→boolean 0 /
 * `~0~1` を含む `$ref` 0 / 循環 0 / `$ref` 連鎖の最長 1 段。実測 2026-08-16）。
 */
describe('条文 ①-c7 tuple 形式の items の参照先だけ変わる（外部監査 P0）', () => {
  const S = 'http://json-schema.org/draft-07/schema#'
  const shell = { type: 'array', items: [{ $ref: '#/definitions/d0' }] }
  const OLD = { $schema: S, ...shell, definitions: { d0: { type: 'string' } } }
  const NEW = { $schema: S, ...shell, definitions: { d0: { type: ['string', 'null'] } } }

  it('① ajv: [null] が旧 invalid → 新 valid', () => {
    const compile = (s: object) => new Ajv({ allErrors: true, strict: false }).compile(structuredClone(s))
    expect(compile(OLD)([null]), '旧で通ってしまう').toBe(false)
    expect(compile(NEW)([null]), '新で通らない').toBe(true)
    expect(JSON.stringify(OLD.items), 'items の文字列が違う（前提が崩れている）').toBe(JSON.stringify(NEW.items))
  })

  it('② 判定器は BUMP を返す', () => {
    expect(diffSchemaObjects(OLD, NEW).verdict).toBe('BUMP')
  })

  it('③ 対照: 参照先が変わらなければ HOLD のまま', () => {
    expect(diffSchemaObjects(OLD, structuredClone(OLD)).verdict).toBe('HOLD')
  })

  it('④ 対照: items が単一 schema の形は前から正しかった', () => {
    const o = { $schema: S, type: 'array', items: { $ref: '#/definitions/d0' }, definitions: { d0: { type: 'string' } } }
    const n = { $schema: S, type: 'array', items: { $ref: '#/definitions/d0' }, definitions: { d0: { type: ['string', 'null'] } } }
    expect(diffSchemaObjects(o, n).verdict).toBe('BUMP')
  })

  it('⑤ 対照: tuple の長さが変わったら決められない（BUMP 側へ倒す）', () => {
    const n = structuredClone(OLD) as { items: object[] }
    n.items = [...n.items, { type: 'number' }]
    expect(diffSchemaObjects(OLD, n).verdict).toBe('BUMP')
  })
})

/**
 * ⚠️ **条文 ①-c8。`$ref` の RFC 6901 escape（v0.6.23・外部監査 P0）。**
 *
 * `#/definitions/a~1b` は `definitions["a/b"]` を指す（`~1` = `/`・`~0` = `~`）。
 * 復号していなかったので `definitions["a~1b"]` を探しに行って解決できず、
 * **解決できないまま「変わっていない」と答えていた。**
 */
describe('条文 ①-c8 $ref の RFC 6901 escape を復号していない（外部監査 P0）', () => {
  const S = 'http://json-schema.org/draft-07/schema#'
  const branch = [{ $ref: '#/definitions/a~1b' }, { type: 'number' }]
  const OLD = { $schema: S, oneOf: branch, definitions: { 'a/b': { type: 'string' } } }
  const NEW = { $schema: S, oneOf: branch, definitions: { 'a/b': { type: ['string', 'null'] } } }

  it('① ajv: null が旧 invalid → 新 valid', () => {
    const compile = (s: object) => new Ajv({ allErrors: true, strict: false }).compile(structuredClone(s))
    expect(compile(OLD)(null), '旧で通ってしまう').toBe(false)
    expect(compile(NEW)(null), '新で通らない').toBe(true)
  })

  it('② 判定器は BUMP を返す', () => {
    expect(diffSchemaObjects(OLD, NEW).verdict).toBe('BUMP')
  })

  it('③ 対照: 参照先が変わらなければ HOLD のまま', () => {
    expect(diffSchemaObjects(OLD, structuredClone(OLD)).verdict).toBe('HOLD')
  })

  it('④ ~0（チルダ）も復号する', () => {
    const b = [{ $ref: '#/definitions/a~0b' }, { type: 'number' }]
    const o = { $schema: S, oneOf: b, definitions: { 'a~b': { type: 'string' } } }
    const n = { $schema: S, oneOf: b, definitions: { 'a~b': { type: ['string', 'null'] } } }
    expect(diffSchemaObjects(o, n).verdict).toBe('BUMP')
  })

  /**
   * ⚠️ **復号は「安全のため」ではなく「精度のため」である。**
   *
   * 復号しなくても解決に失敗して諦めるので、下の root 比較へ落ちて **BUMP にはなる**
   * （危険側の誤りは出ない）。**だが escaped `$ref` を使う schema は、
   * 参照先が変わっていなくても、無関係な definition が動くたびに BUMP になる。**
   * 復号して初めて「変わっていない」と言えるようになる。
   *
   * この試験が無いと、復号を消しても何も落ちない（実測: 変異で 93 件すべて通った）。
   */
  it('⑤ **復号できると、無関係な definition が増えても HOLD のまま**（誤検出しない）', () => {
    const b = [{ $ref: '#/definitions/a~1b' }, { type: 'number' }]
    const o = { $schema: S, oneOf: b, definitions: { 'a/b': { type: 'string' } } }
    const n = { $schema: S, oneOf: b, definitions: { 'a/b': { type: 'string' }, zz: { type: 'number' } } }
    expect(diffSchemaObjects(o, n).verdict, '参照先は変わっていないのに BUMP になっている').toBe('HOLD')
  })
})

/**
 * ⚠️ **条文 ①-c11。展開の深さ上限より奥にある `$ref`（v0.6.23）。**
 *
 * 監査の反例（55 段の連鎖）は `deref()` の反復上限を踏むので、
 * **`expandRefs` の深さ上限とは別の経路**である。実測して分かった
 * ——反例 ①-c9 は `expandRefs` の `depth` を消しても落ちなかった。
 *
 * こちらは `oneOf` の枝の中で 60 段ネストし、その奥に `$ref` を置く。
 * `oneOf` の枝は `compare()` を通らない（枝ごとの再帰が健全でないため）ので、
 * **`expandRefs` が諦めた時点で誰も参照先を見ない。**
 */
describe('条文 ①-c11 展開の深さ上限より奥にある $ref（数え直して見つけた）', () => {
  const S = 'http://json-schema.org/draft-07/schema#'
  const nest = (inner: object) => {
    let n: object = inner
    for (let i = 0; i < 60; i++) n = { type: 'object', properties: { a: n } }
    return n
  }
  const mk = (d0: object) => ({ $schema: S, oneOf: [nest({ $ref: '#/definitions/d0' }), { type: 'number' }], definitions: { d0 } })
  const OLD = mk({ type: 'string' })
  const NEW = mk({ type: ['string', 'null'] })
  const deepVal = (v: unknown) => { let x: unknown = v; for (let i = 0; i < 60; i++) x = { a: x }; return x }

  it('① ajv: 奥が null の値が旧 invalid → 新 valid', () => {
    const compile = (s: object) => new Ajv({ allErrors: true, strict: false }).compile(structuredClone(s))
    expect(compile(OLD)(deepVal(null)), '旧で通ってしまう').toBe(false)
    expect(compile(NEW)(deepVal(null)), '新で通らない').toBe(true)
    expect(JSON.stringify(OLD.oneOf), '枝の文字列が違う（前提が崩れている）').toBe(JSON.stringify(NEW.oneOf))
  })

  it('② 判定器は BUMP を返す', () => {
    expect(diffSchemaObjects(OLD, NEW).verdict).toBe('BUMP')
  })

  it('③ 対照: 参照先が変わらなければ HOLD のまま', () => {
    expect(diffSchemaObjects(OLD, structuredClone(OLD)).verdict).toBe('HOLD')
  })
})

/**
 * ⚠️ **条文 ①-c12。循環を見つけたら保守側へ倒す（v0.6.23）。**
 *
 * 監査の指摘には無い。**「諦めた」経路を数え直したときに残った 1 つ**である。
 *
 * 循環がある schema は、その先を確かめられない。だから
 * **「変わっていない」とは言えない。**この版からは root どうしを比べて、
 * まったく同じでなければ決められない側（BUMP）へ倒す。
 *
 * 保守側なので**誤って上げる**ことはある（循環がある schema は、
 * 無関係な definition が動くだけで BUMP になる）。現行 schema に循環は
 * **0 件**なので、いまの版に影響しない（実測 2026-08-16）。
 */
describe('条文 ①-c12 循環がある schema は保守側へ倒す（数え直して見つけた）', () => {
  const S = 'http://json-schema.org/draft-07/schema#'
  const mk = (unused: object) => ({
    $schema: S,
    oneOf: [{ $ref: '#/definitions/d0' }, { type: 'number' }],
    definitions: { d0: { oneOf: [{ $ref: '#/definitions/d0' }, { type: 'string' }] }, dUnused: unused },
  })

  it('① 循環の先を確かめられないので、無関係な変更でも BUMP へ倒す', () => {
    expect(diffSchemaObjects(mk({ type: 'string' }), mk({ type: 'number' })).verdict).toBe('BUMP')
  })

  it('② **対照: まったく同じなら HOLD**（循環を一律 BUMP にしていない）', () => {
    const o = mk({ type: 'string' })
    expect(diffSchemaObjects(o, structuredClone(o)).verdict).toBe('HOLD')
  })
})

/**
 * ⚠️ **条文 ①-c9。`$ref` の連鎖が長すぎて解決できない（v0.6.23・外部監査 P0）。**
 *
 * 55 段の連鎖は `deref()` の反復上限（`REF_LIMIT`）を超え、解決できない目印を返す。
 * `expandRefs` はそれを見て元の節を返していた。**新旧そろって同じ位置で諦める**ので
 * 写しは一致し、「変わっていない」と読めてしまう。**諦めたのなら、決められないと言うべき。**
 *
 * > **`expandRefs` の `depth` 上限とは別の経路である。**実測で分かった
 * > ——この反例は `depth` の記録を消しても落ちない。そちらは条文 ①-c11 で見る。
 *
 * ⚠️ **同一 schema 同士は HOLD のままでなければならない**（深いだけで BUMP にすると条文が使えない）。
 * 諦めが起きたときは**root どうしを比べて**、まったく同じなら HOLD、違えば決められない、とする。
 */
describe('条文 ①-c9 $ref の連鎖が長すぎて解決できない（外部監査 P0）', () => {
  const S = 'http://json-schema.org/draft-07/schema#'
  const N = 55
  const chain = (tail: object) => {
    const defs: Record<string, object> = {}
    for (let i = 0; i < N; i++) defs[`d${i}`] = { $ref: `#/definitions/d${i + 1}` }
    defs[`d${N}`] = tail
    return defs
  }
  const OLD = { $schema: S, oneOf: [{ $ref: '#/definitions/d0' }, { type: 'number' }], definitions: chain({ type: 'string' }) }
  const NEW = { $schema: S, oneOf: [{ $ref: '#/definitions/d0' }, { type: 'number' }], definitions: chain({ type: ['string', 'null'] }) }

  it('① ajv: null が旧 invalid → 新 valid', () => {
    const compile = (s: object) => new Ajv({ allErrors: true, strict: false }).compile(structuredClone(s))
    expect(compile(OLD)(null), '旧で通ってしまう').toBe(false)
    expect(compile(NEW)(null), '新で通らない').toBe(true)
  })

  it('② 判定器は BUMP を返す', () => {
    expect(diffSchemaObjects(OLD, NEW).verdict).toBe('BUMP')
  })

  it('③ **対照: 深いだけで同一なら HOLD のまま**（諦めを一律 BUMP にしていない）', () => {
    expect(diffSchemaObjects(OLD, structuredClone(OLD)).verdict).toBe('HOLD')
  })
})

/**
 * ⚠️ **条文 ①-c10。参照先が boolean schema（v0.6.23・外部監査 P0）。**
 *
 * Draft-07 では `true` / `false` も正当な schema である（`true` は全部通し、`false` は全部拒む）。
 * `expandRefs` は参照先が object でなければ展開せず元の節を返していたので、
 * **`false` → `true` という最大級の変更が見えなかった。**
 */
describe('条文 ①-c10 参照先が boolean schema（外部監査 P0）', () => {
  const S = 'http://json-schema.org/draft-07/schema#'
  const branch = [{ $ref: '#/definitions/d0' }, { type: 'number' }]
  const OLD = { $schema: S, oneOf: branch, definitions: { d0: false } }
  const NEW = { $schema: S, oneOf: branch, definitions: { d0: true } }

  it('① ajv: 広がりと狭まりが両方ある（oneOf は「ちょうど 1 枝」なので）', () => {
    const compile = (s: object) => new Ajv({ allErrors: true, strict: false }).compile(structuredClone(s))
    const o = compile(OLD); const n = compile(NEW)
    expect(o('x'), '旧で文字列が通ってしまう').toBe(false)
    expect(n('x'), '新で文字列が通らない').toBe(true)     // 広がった
    expect(o(1), '旧で数値が通らない').toBe(true)
    expect(n(1), '新で数値が通ってしまう').toBe(false)    // 狭まった（2 枝が一致するので oneOf は落ちる）
  })

  it('② 判定器は BUMP を返す', () => {
    expect(diffSchemaObjects(OLD, NEW).verdict).toBe('BUMP')
  })

  it('③ 対照: 参照先が変わらなければ HOLD のまま', () => {
    expect(diffSchemaObjects(OLD, structuredClone(OLD)).verdict).toBe('HOLD')
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
   * **母集団は「いま配る schema の全部」。**（v0.6.17・外部監査 P0）
   *
   * 前の版は「直前 release に在った schema」を数えていた。そちらを母集団にすると、
   * **後から新設した契約は永久に検査へ入らない**——実際 `source-verifier-cli-result` が
   * 5 版のあいだ素通りし、版を据え置いたまま言語が 3 か所広がった。
   *
   * 判定は 4 つだけ:
   *
   * ```
   * 直前に同じ path があり、名乗る版も同じ   → BUMP なら違反
   * 直前に同じ path があり、名乗る版が違う   → migration の history が要る
   * 直前に同じ path が無い（改名）           → migration の renamedAssets が要る
   * 直前に同じ path が無い（新設）           → 直前に同じ $id/schemaId が無いこと
   * ```
   */
  const PREV = previousReleaseTag()

  /**
   * 現行の配布 schema。**まだ `git add` していないものも数える。**
   * `--cached` だけにすると、**新設した契約が add 忘れのあいだ検査から消える**
   * ——それは前の版で起きたこと（母集団に入らない = 何をしても緑）と同じ形になる。
   */
  const CURRENT_SCHEMAS = execFileSync(
    'git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'schemas/*.schema.json'],
    { cwd: ROOT, encoding: 'utf8' },
  ).trim().split('\n').filter(Boolean).sort()

  const prevSchemas = execFileSync('git', ['ls-tree', '-r', '--name-only', PREV, '--', 'schemas/'], { cwd: ROOT, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean)

  const MIGRATIONS = JSON.parse(readFileSync(resolve(ROOT, 'contract-migration.v1.json'), 'utf8')).migrations as Record<string, any>
  const renamedTo = new Set<string>(
    Object.values(MIGRATIONS).flatMap((m: any) => (m.renamedAssets ?? []).map((r: any) => r.to as string)),
  )
  /** 改名**元**の名前。消えた schema を許すかどうかは、こちらで見る（`to` ではない） */
  const renamedFrom = new Set<string>(
    Object.values(MIGRATIONS).flatMap((m: any) => (m.renamedAssets ?? []).map((r: any) => r.from as string)),
  )
  const declared = (s: any): unknown => s?.properties?.schemaVersion?.const
  const identityOf = (s: any): string => String(s?.$id ?? s?.properties?.schemaId?.const ?? '')

  /**
   * 1 本を判定して、違反の文言を返す（空なら合格）。
   * **反例を作って当てられるよう、検査本体と切り離してある。**
   */
  function judge(path: string, prevTag: string, cur: any, prevList: readonly string[]): string[] {
    const bad: string[] = []
    const basename = path.split('/').pop() as string
    if (prevList.includes(path)) {
      const old = atTag(prevTag, path) as any
      if (declared(old) === declared(cur)) {
        const r = diffSchemaObjects(old, cur)
        if (r.verdict === 'BUMP') {
          bad.push(`${path}: 版 ${String(declared(cur))} を据え置いたまま言語が変わっている `
            + `${JSON.stringify((r.facts as any[]).map((f) => `${f.kind} ${f.pointer}`))}`)
        }
      } else if (!Object.values(MIGRATIONS).some((m: any) => (m.history ?? [])
        .some((h: any) => h.currentSchemaPath === path && h.schemaVersionAtTheTime === declared(cur)))) {
        bad.push(`${path}: 版を ${String(declared(old))} → ${String(declared(cur))} へ上げたのに migration の history が無い`)
      }
      return bad
    }
    // 直前に同じ path が無い
    if (renamedTo.has(basename)) return bad
    const ids = new Set(prevList.map((p) => identityOf(atTag(prevTag, p))))
    if (ids.has(identityOf(cur))) {
      bad.push(`${path}: 新設のはずだが、直前 release に同じ $id/schemaId が在る（改名なら renamedAssets へ書くこと）`)
    }
    return bad
  }

  it(`直前 release（自動選択）と、現行の全 schema を突き合わせる`, () => {
    expect(prevSchemas.length, `${PREV} に schema が無い（走査が動いていない）`).toBeGreaterThan(15)
    mustBeNonEmpty(CURRENT_SCHEMAS, '現行の配布 schema')
    /** **母集団が現行側であること**を名指しで確かめる（前の版はここが古い一覧だった） */
    expect(CURRENT_SCHEMAS, '新しく作った契約が母集団に入っていない')
      .toContain('schemas/source-verifier-cli-result.v2.schema.json')

    const bad: string[] = []
    for (const p of CURRENT_SCHEMAS) bad.push(...judge(p, PREV, JSON.parse(readFileSync(resolve(ROOT, p), 'utf8')), prevSchemas))
    expect(bad, `条文違反（直前 release = ${PREV}）`).toEqual([])
  })

  it('直前 release に在った schema が、黙って消えていない', () => {
    /**
     * **対照。**`renamedFrom` が空だと、この検査は「消えていれば必ず落ちる」だけになり、
     * 改名を許す経路が死ぬ。逆に `renamedTo` を見ていると（v0.6.17 で一度そう書いた）、
     * **改名元は決して載らない**ので、こちらも死ぬ。
     */
    expect(renamedFrom.size, '改名の記録が 1 件も無い').toBeGreaterThan(0)
    expect([...renamedFrom].some((n) => !renamedTo.has(n)), 'from と to が同じ集合になっている').toBe(true)
    const gone = prevSchemas.filter((p) => !existsSync(resolve(ROOT, p))
      && !renamedFrom.has(p.split('/').pop() as string))
    expect(gone, '配っていた schema が消えている（改名なら renamedAssets へ書くこと）').toEqual([])
  })

  /**
   * **この検査が、実際にあの反例を捕まえるか（v0.6.17）。**
   *
   * v0.6.16 は `source-verifier-cli-result.v1` を v1 のまま 3 か所広げて公開した。
   * 前の版の検査は**その schema を母集団に含めていなかった**ので 57/57 全緑だった。
   * ここでは当時の 2 版を実物で当てて、**いまの判定が違反として鳴る**ことを見る。
   */
  it('**反例: v0.6.15 → v0.6.16 の CLI result（版据え置きのまま WIDEN）を違反として捕まえる**', () => {
    const REL = 'schemas/source-verifier-cli-result.v1.schema.json'
    const prevList = execFileSync('git', ['ls-tree', '-r', '--name-only', 'v0.6.15', '--', 'schemas/'], { cwd: ROOT, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean)
    expect(prevList, '当時の母集団にその schema が在る').toContain(REL)
    const bad = judge(REL, 'v0.6.15', atTag('v0.6.16', REL), prevList)
    expect(bad.length, '違反として鳴らなかった').toBe(1)
    expect(bad[0]).toContain('版 1 を据え置いたまま言語が変わっている')
    expect(bad[0]).toContain('/properties/stableReasonCode/enum')
  })

  /** 対照: 同じ判定器が、**変えていない組み合わせでは鳴らない** */
  it('対照: v0.6.15 → v0.6.15 の同じ schema では鳴らない', () => {
    const REL = 'schemas/source-verifier-cli-result.v1.schema.json'
    expect(judge(REL, 'v0.6.15', atTag('v0.6.15', REL), [REL]), '何にでも鳴っている').toEqual([])
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
  /** 過去の版が配っていた schema。**作業ツリーにも残してある**（保存済みの結果の突合先） */
  const HIST_REL = 'schemas/source-verifier-cli-result.v1.schema.json'
  /** いま配る schema。道具から引く（手で書くと版を上げたときにここだけ古くなる） */
  const SCHEMA_REL = CLI_RESULT_SCHEMA_PATH

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
  const schemaAt = (tag: string, rel = HIST_REL) => JSON.parse(
    execFileSync('git', ['show', `${tag}:${rel}`], { cwd: ROOT, encoding: 'utf8' }))
  /**
   * いまの道具の出力。**status は問わない。**
   * 契約は「どの status でも schema に収まる」なので、`MISMATCH` で終わる状態
   * （再生成の途中など）でも同じ検査が成り立つ必要がある。
   * `execFileSync` は非 0 で投げるため、stdout を拾い直す。
   */
  const currentOutput = () => {
    try {
      return JSON.parse(execFileSync('node',
        ['scripts/verifyReleaseSourceInputs.mjs', '--manifest', 'artifacts/source-input-manifest.json', '--source', '.'],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }))
    } catch (e) {
      const out = String((e as { stdout?: string }).stdout ?? '')
      if (!out.trim()) throw new Error('道具が JSON を出さずに落ちた（契約の外）')
      return JSON.parse(out)
    }
  }

  it('**その版の出力は、その版の schema を通る**（配った組み合わせは成立している）', () => {
    expect(compile(schemaAt(TAG))(outputAt(TAG)), `${TAG} の出力が ${TAG} の schema を通らない`).toBe(true)
  })

  it('**いまの出力は、いまの schema を通る**', () => {
    const now = JSON.parse(readFileSync(resolve(ROOT, SCHEMA_REL), 'utf8'))
    expect(compile(now)(currentOutput()), '現行の出力が現行の schema を通らない').toBe(true)
  })

  /**
   * **producer-forward が壊れたなら、版が上がっていること（v0.6.17・外部監査 P0）。**
   *
   * v0.6.16 まで、ここは「新しい出力は古い schema も通る」と**断定**していた。
   * だが v0.6.16 の出力は v0.6.15 の schema を通らなかった——`usage` 族は
   * `archivePolicy` に載るので、**`OK` の正常な出力までも落ちる。**
   * 検査は v1 を母集団に含めていなかったので、その事実に一度も触れなかった。
   *
   * 通らないこと自体は違反ではない。**通らないのに版を据え置くこと**が違反である。
   * だから「通るか」ではなく、**通らないなら版が違うか**を見る。
   */
  it('**古い schema を通らないなら、版が上がっている**', () => {
    const out = currentOutput()
    const prevSchema = schemaAt(previousReleaseTag(), HIST_REL)
    if (compile(prevSchema)(out)) return // 通るなら据え置いてよい
    expect(out.schemaVersion, '直前 release の schema を通らないのに、版が同じ')
      .not.toBe(prevSchema.properties.schemaVersion.const)
  })

  /**
   * **ここが条文の本体。**「最新 schema で過去の結果を検証してはいけない」を、
   * **実際に落ちること**で示す。落ちなくなったら、方針の前提が変わったということなので
   * 第7条を書き直すこと（黙って通さない）。
   */
  it('**保存した古い出力は、いまの schema では通らない**（だから版ごとに固定する）', () => {
    const now = JSON.parse(readFileSync(resolve(ROOT, SCHEMA_REL), 'utf8'))
    expect(compile(now)(outputAt(TAG)),
      `${TAG} の出力が最新 schema を通ってしまった。第7条の前提が変わっている`).toBe(false)
  })

  /** **過去の突合先が作業ツリーに残っていること。**消すと保存済みの結果を検証できなくなる */
  it('過去の版が配った schema を、作業ツリーから消していない', () => {
    expect(existsSync(resolve(ROOT, HIST_REL)), `${HIST_REL} が無い`).toBe(true)
    expect(compile(schemaAt(TAG))(outputAt(TAG)), '過去の組み合わせが成立しない').toBe(true)
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
    const schemaSha = find(SCHEMA_REL.split('/').pop() as string)
    expect(toolSha, '道具が assets に無い').toMatch(/^[0-9a-f]{64}$/)
    expect(notes, `道具の sha256 が本文と食い違う`).toContain(String(toolSha))
    /** assets の値が、いまの実ファイルのものであること（**古い pin を名指ししていない**） */
    expect(schemaSha).toBe(createHash('sha256').update(readFileSync(resolve(ROOT, SCHEMA_REL))).digest('hex'))
  })
})
