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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { diffSchemaFiles, diffSchemaObjects } from '../scripts/schemaLanguageDiff.mjs'
import { mustBeNonEmpty } from './_must'

const ROOT = resolve(__dirname, '..')

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
