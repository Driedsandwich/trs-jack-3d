/**
 * 窓の端点の test vector（v0.3.0 フォローアップ P1-4）。
 *
 * ## このテストが守るもの
 *
 * fixture を置いただけでは意味が無い。**「不正なはずのものが本当に弾かれるか」**を
 * 実際に流して確かめないと、fixture は「不正だと自称しているだけの JSON」になる。
 *
 * さらに大事なのが**どの層が弾いたか**である。
 * `lastSampleMm == endExclusiveMm` は **schema では書けない**（draft-07 に項目どうしを
 * 比べる書き方が無い）。ここを意味検査が見ていなかったら、
 * 「schema を通ったから正しい」と読む consumer が黙って壊れる。
 * だから「弾かれた」ではなく「**schema が弾いた／意味検査が弾いた**」まで見る。
 */

import Ajv from 'ajv'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkWindow, checkWindowInvariants } from '../scripts/robustnessWindows.mjs'
import { mustBeNonEmpty } from './_must'

const ROOT = resolve(__dirname, '..')
const DIR = 'test/fixtures/topology-robustness'
const R = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))

const ajv = new Ajv({ allErrors: true, strict: false })
const validateSchema = ajv.compile(R('schemas/topology-robustness.v3.schema.json'))

/** fixture を 2 層に通して、**どちらが弾いたか**を返す */
function layers(name: string) {
  const doc = R(`${DIR}/${name}.json`)
  const schemaOk = validateSchema(doc) as boolean
  const semanticErrs = checkWindowInvariants(doc)
  return { doc, schemaOk, semanticErrs, caughtBy: !schemaOk ? 'schema' : semanticErrs.length ? 'semantic' : 'none' }
}

describe('P1-4 窓の端点の test vector', () => {
  it('**fixture が 3 件そろっている**（1 件でも欠けたら以下の検査は無意味）', () => {
    const files = readdirSync(resolve(ROOT, DIR)).filter((f) => f.endsWith('.json')).sort()
    expect(files).toEqual([
      'invalid-lastSample-equals-endExclusive.json',
      'invalid-legacy-toMm.json',
      'valid-exclusive-window.json',
    ])
  })

  it('1. 正常な窓は schema も意味検査も通る', () => {
    const r = layers('valid-exclusive-window')
    expect({ schemaOk: r.schemaOk, semantic: r.semanticErrs }).toEqual({ schemaOk: true, semantic: [] })
  })

  it('**2. 旧 v1 の toMm が残っていたら schema が弾く**', () => {
    const r = layers('invalid-legacy-toMm')
    expect(r.caughtBy).toBe('schema')
    // 通ってしまうと、下流は 1 刻みずれた値を区間の終端として読む
    expect(r.schemaOk).toBe(false)
    const errs = mustBeNonEmpty(validateSchema.errors ?? [], 'schema のエラー')
    // **弾かれた理由が窓であること。**別の理由で落ちていたら fixture が壊れている
    expect(errs.some((e) => String(e.instancePath).includes('windows'))).toBe(true)
  })

  it('**3. lastSampleMm == endExclusiveMm は schema を通り、意味検査だけが弾く**', () => {
    const r = layers('invalid-lastSample-equals-endExclusive')
    // schema が通すことを**明示的に固定する**。ここが false になったら
    // schema 側で表現できるようになったということなので、この fixture の位置づけが変わる
    expect(r.schemaOk).toBe(true)
    expect(r.caughtBy).toBe('semantic')
    const hit = r.semanticErrs.filter((e: string) => e.includes('endExclusiveMm') && e.includes('以上'))
    mustBeNonEmpty(hit, '端点の大小を指すエラー')
  })

  it('3 件が別々の層に割り当てられている（同じ層に偏っていない）', () => {
    const got = {
      valid: layers('valid-exclusive-window').caughtBy,
      legacy: layers('invalid-legacy-toMm').caughtBy,
      equal: layers('invalid-lastSample-equals-endExclusive').caughtBy,
    }
    expect(got).toEqual({ valid: 'none', legacy: 'schema', equal: 'semantic' })
  })
})

describe('P1-4 意味検査そのもの', () => {
  const W = { startMm: 13.3, lastSampleMm: 13.5, endExclusiveMm: 13.52, widthMm: 0.22 }
  const STEP = 0.02

  it('正常な窓は 0 件', () => {
    expect(checkWindow(W, STEP, 'w')).toEqual([])
  })

  /**
   * **1 つずつ壊して、全部が別々に捕まることを見る。**
   * まとめて壊すと、1 つの条件だけが効いていても全部通ったように見える。
   */
  const BREAKS: [string, Record<string, number>, string][] = [
    ['lastSample が start より手前', { lastSampleMm: 13.2, endExclusiveMm: 13.22 }, 'より小さい'],
    ['lastSample == endExclusive', { lastSampleMm: 13.52 }, '以上'],
    ['lastSample > endExclusive', { lastSampleMm: 13.6 }, '以上'],
    ['endExclusive が刻みと合わない', { endExclusiveMm: 13.6, widthMm: 0.3 }, 'stepMm'],
    ['widthMm が端点と合わない', { widthMm: 0.5 }, 'widthMm'],
  ]
  for (const [name, patch, marker] of BREAKS)
    it(`壊すと落ちる: ${name}`, () => {
      const errs = checkWindow({ ...W, ...patch }, STEP, 'w')
      mustBeNonEmpty(errs, `${name} のエラー`)
      expect(errs.join(' / ')).toContain(marker)
    })

  it('旧 v1 の項目が残っていたら落ちる', () => {
    const errs = checkWindow({ ...W, toMm: 13.5 } as never, STEP, 'w')
    expect(errs.join(' / ')).toContain('toMm')
  })

  /**
   * **counterExamples 側の窓は実データでは 1 件も無い**（9 件中 0 件・2026-08-03 実測）。
   * 目標が現れない構成には窓ができないので、当然といえば当然だが、
   * **実データで一度も通らない枝は、壊れていても気づけない。**だから合成して通す。
   */
  it('**counterExamples の窓も見ている**（実データでは 0 件なので合成して確かめる）', () => {
    const base = R(`${DIR}/valid-exclusive-window.json`)
    expect(checkWindowInvariants(base)).toEqual([])
    expect((base.counterExamples ?? []).filter((c: { windows?: unknown[] }) => c.windows?.length)).toHaveLength(0)

    const withBadCounterWindow = {
      ...base,
      counterExamples: [{ ...base.counterExamples[0], windows: [{ ...W, lastSampleMm: 13.52 }] }],
    }
    const errs = checkWindowInvariants(withBadCounterWindow)
    mustBeNonEmpty(errs, 'counterExamples の窓のエラー')
    expect(errs.join(' / ')).toContain('以上')
  })

  it('windowEndConvention が EXCLUSIVE でなければ落ちる', () => {
    const base = R(`${DIR}/valid-exclusive-window.json`)
    const errs = checkWindowInvariants({ ...base, windowEndConvention: 'INCLUSIVE' })
    expect(errs.join(' / ')).toContain('windowEndConvention')
  })
})

describe('P1-4 fixture と本番が同じ検査を使っている', () => {
  it('**validateProfiles が自前で窓を見ていない**（二重実装だと片方だけ直る）', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/validateProfiles.mjs'), 'utf8')
    expect(src).toContain('checkWindowInvariants')
    // 窓の規則を validateProfiles 側へ書き戻していないこと
    expect(src).not.toMatch(/lastSampleMm \+ a\.stepMm/)
  })

  it('実データの窓も同じ検査を通る', () => {
    const real = R('artifacts/topology-robustness.trs_jack_trrs.json')
    expect(checkWindowInvariants(real)).toEqual([])
  })
})
