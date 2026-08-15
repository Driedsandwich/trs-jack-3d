/**
 * **schema をランダム生成し、ajv を正解器にして判定器の危険側を探す材料。**
 *
 * 計画（`docs/V060_PLAN_20260805.md` §3）が `[AI]` で約束したまま 10 日落ちていた分。
 *
 * ## 何を確かめたいか
 *
 * 判定器の条文はこう:
 *
 * ```
 * BUMP         新 ⊄ 旧（広がった / 決められない） → 版を上げる
 * HOLD_RECORD  新 ⊊ 旧（狭まった）                → 据え置き可
 * HOLD         新 = 旧                            → 据え置き可
 * ```
 *
 * **危険なのは「新だけが通す値が実在するのに、上げろと言わない」ほう。**
 * 受け手は旧 schema を pin しているので、その値が来た瞬間に拒む。
 * 逆（上げなくてよいのに上げる）は保守的な誤りで、条文が明示的に許している。
 *
 * ## 証人（witness）が見つからないことは、証拠にならない
 *
 * この試験の一番の落とし穴は**値の作り方**である。
 * 「新だけが通す値」を探せなければ、言語が広がっていても反例が出ない。
 * そのとき試験は**緑になる**——広がりを見逃したまま。
 *
 * だから値は**その schema 対から作る**（enum の全値・const・境界の前後・
 * 型ごとの代表値）。固定の値プールだけに頼らない。
 * さらに、**証人探しが本当に働くこと**をテスト側で対照として確かめる
 * （既知の広がり対で証人が出ること・同一 schema では出ないこと）。
 */

/** 種を固定した乱数（mulberry32）。**失敗したケースを再現できる形にする** */
export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = (r, xs) => xs[Math.floor(r() * xs.length) % xs.length]
const chance = (r, p) => r() < p

const WORDS = ['a', 'b', 'c', 'input', 'scope', 'role', 'x1']

/**
 * 小さな schema を作る。
 *
 * **深いネストと `$ref` の連鎖も作る**——現行 schema に無い形を作れない生成器は、
 * 「反例が出なかった」を偽装する（テスト側で対照を取っている）。
 */
export function genSchema(r, depth = 0, refs = { defs: {}, n: 0 }) {
  // $ref の連鎖: definitions を作って、そこを指す
  if (depth > 0 && depth < 4 && chance(r, 0.22) && refs.n < 4) {
    const name = `d${refs.n++}`
    refs.defs[name] = genSchema(r, depth + 1, refs)
    return { $ref: `#/definitions/${name}` }
  }

  const kind = pick(r, ['integer', 'number', 'string', 'boolean', 'enum', 'const', 'array', 'object', 'oneOf'])

  switch (kind) {
    case 'integer':
    case 'number': {
      const s = { type: kind }
      if (chance(r, 0.6)) s.minimum = Math.floor(r() * 5)
      if (chance(r, 0.6)) s.maximum = (s.minimum ?? 0) + Math.floor(r() * 5)
      return s
    }
    case 'string': {
      const s = { type: 'string' }
      if (chance(r, 0.5)) s.minLength = Math.floor(r() * 3)
      if (chance(r, 0.5)) s.maxLength = (s.minLength ?? 0) + Math.floor(r() * 4)
      if (chance(r, 0.25)) s.pattern = pick(r, ['^a', 'b$', '^[ab]+$'])
      return s
    }
    case 'boolean':
      return { type: 'boolean' }
    case 'enum':
      return { enum: [...new Set([pick(r, WORDS), pick(r, WORDS), Math.floor(r() * 3)])] }
    case 'const':
      return { const: pick(r, WORDS) }
    case 'array': {
      const s = { type: 'array', items: depth < 3 ? genSchema(r, depth + 1, refs) : { type: 'string' } }
      if (chance(r, 0.4)) s.minItems = Math.floor(r() * 2)
      if (chance(r, 0.4)) s.maxItems = (s.minItems ?? 0) + 1 + Math.floor(r() * 2)
      if (chance(r, 0.3)) s.uniqueItems = true
      return s
    }
    case 'oneOf':
      return { oneOf: [genSchema(r, depth + 2, refs), genSchema(r, depth + 2, refs)] }
    case 'object':
    default: {
      const keys = [...new Set([pick(r, WORDS), pick(r, WORDS)])]
      const props = {}
      for (const k of keys) props[k] = depth < 3 ? genSchema(r, depth + 1, refs) : { type: 'string' }
      const s = { type: 'object', properties: props }
      if (chance(r, 0.5)) s.required = keys.slice(0, 1)
      if (chance(r, 0.4)) s.additionalProperties = chance(r, 0.5)
      return s
    }
  }
}

/** 生成のたびに definitions を束ねて 1 枚の schema にする */
export function genRoot(r) {
  const refs = { defs: {}, n: 0 }
  const body = genSchema(r, 1, refs)
  const out = { $schema: 'http://json-schema.org/draft-07/schema#', ...body }
  if (Object.keys(refs.defs).length) out.definitions = refs.defs
  return out
}

/**
 * **1 か所だけ変えた対を作る。**
 *
 * 独立に 2 枚生成すると、実測で **98% が BUMP** になる（600 対中 589）。
 * それでは「常に BUMP と言う判定器」も通ってしまい、判別力が無い。
 * 危険（広がっているのに据え置き可と言う）は**小さな変更**に潜むので、
 * 節を 1 つ選んで 1 手だけ動かす。
 *
 * 戻り値の `applied` が false のときは変異が当たっていない
 * ——**当たらなかった変異と素通りした変異は出力が同じ**なので、呼び出し側で除く。
 */
export function mutate(r, schema) {
  const clone = structuredClone(schema)
  /** 変異できる節を集める（親と鍵を持って回る） */
  const spots = []
  const walk = (n) => {
    if (!n || typeof n !== 'object' || Array.isArray(n)) return
    spots.push(n)
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(walk)
      else walk(v)
    }
  }
  walk(clone)
  if (!spots.length) return { schema: clone, applied: false, op: 'none' }

  const before = JSON.stringify(clone)
  const s = pick(r, spots)
  const ops = []
  if (Array.isArray(s.enum)) ops.push('enum-add', 'enum-drop')
  if (typeof s.minimum === 'number') ops.push('min-down', 'min-up')
  if (typeof s.maximum === 'number') ops.push('max-up', 'max-down')
  if (typeof s.minLength === 'number') ops.push('minlen-down')
  if (typeof s.maxLength === 'number') ops.push('maxlen-up')
  if (Array.isArray(s.required)) ops.push('req-drop', 'req-add')
  if ('additionalProperties' in s) ops.push('addl-flip')
  if (s.properties) ops.push('prop-drop', 'prop-add')
  if (s.type) ops.push('type-widen')
  if (!ops.length) return { schema: clone, applied: false, op: 'none' }

  const op = pick(r, ops)
  switch (op) {
    case 'enum-add': s.enum = [...s.enum, `zz${Math.floor(r() * 9)}`]; break
    case 'enum-drop': if (s.enum.length > 1) s.enum = s.enum.slice(0, -1); break
    case 'min-down': s.minimum -= 1; break
    case 'min-up': s.minimum += 1; break
    case 'max-up': s.maximum += 1; break
    case 'max-down': s.maximum -= 1; break
    case 'minlen-down': s.minLength = Math.max(0, s.minLength - 1); break
    case 'maxlen-up': s.maxLength += 1; break
    case 'req-drop': if (s.required.length) s.required = s.required.slice(0, -1); break
    case 'req-add': if (s.properties) s.required = [...new Set([...s.required, Object.keys(s.properties)[0]])].filter(Boolean); break
    case 'addl-flip': s.additionalProperties = !s.additionalProperties; break
    case 'prop-drop': { const k = Object.keys(s.properties)[0]; if (k) delete s.properties[k]; break }
    case 'prop-add': s.properties[`zz${Math.floor(r() * 9)}`] = { type: 'string' }; break
    case 'type-widen': s.type = Array.isArray(s.type) ? s.type : [s.type, 'null']; break
  }
  return { schema: clone, applied: JSON.stringify(clone) !== before, op }
}

/** schema の最大ネスト深さ（対照で「深い形を作れている」ことを見るため） */
export function depthOf(node, d = 0) {
  if (!node || typeof node !== 'object') return d
  let max = d
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') max = Math.max(max, depthOf(v, d + 1))
  }
  return max
}

/** `$ref` を 1 つでも含むか（対照用） */
export const hasRef = (node) => JSON.stringify(node).includes('"$ref"')

/**
 * **その schema 対から候補値を作る。**固定プールだけに頼らない
 * ——値が貧しいと「新だけが通す値」を見つけられず、広がりを見逃す。
 */
export function candidates(oldS, newS) {
  const out = [null, true, false, 0, 1, -1, 0.5, '', 'a', 'b', 'ab', [], [1], ['a'], ['a', 'a'], {}, { a: 1 }, { a: 'a', b: 'b' }]
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n.enum)) out.push(...n.enum)
    if ('const' in n) out.push(n.const)
    for (const k of ['minimum', 'maximum']) {
      if (typeof n[k] === 'number') out.push(n[k], n[k] - 1, n[k] + 1, n[k] + 0.5)
    }
    for (const k of ['minLength', 'maxLength']) {
      if (typeof n[k] === 'number') out.push('x'.repeat(Math.max(0, n[k])), 'x'.repeat(Math.max(0, n[k] + 1)))
    }
    for (const k of ['minItems', 'maxItems']) {
      if (typeof n[k] === 'number') out.push(Array.from({ length: Math.max(0, n[k]) }, (_, i) => i))
    }
    if (n.properties) {
      const keys = Object.keys(n.properties)
      out.push(Object.fromEntries(keys.map((k) => [k, 'a'])))
      out.push(Object.fromEntries(keys.map((k) => [k, 1])))
      if (keys.length) out.push(Object.fromEntries(keys.slice(1).map((k) => [k, 'a'])))
      out.push({ ...Object.fromEntries(keys.map((k) => [k, 'a'])), zzExtra: 1 })
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(walk)
      else walk(v)
    }
  }
  walk(oldS); walk(newS)
  // 重複を潰す（JSON で見た同一性でよい）
  const seen = new Set(); const uniq = []
  for (const v of out) {
    const k = JSON.stringify(v) ?? 'undefined'
    if (!seen.has(k)) { seen.add(k); uniq.push(v) }
  }
  return uniq
}

/**
 * **ajv を正解器にして、包含関係の真値を出す。**
 *
 * `widenWitness` … 新だけが通す値（在れば「新 ⊄ 旧」＝広がっている or 交差）
 * `narrowWitness`… 旧だけが通す値
 */
export function witnesses(compile, oldS, newS) {
  let o, n
  try { o = compile(oldS); n = compile(newS) } catch { return { compileFailed: true } }
  let widen, narrow
  for (const v of candidates(oldS, newS)) {
    let ov, nv
    try { ov = o(v); nv = n(v) } catch { continue }
    if (nv && !ov && widen === undefined) widen = v
    if (ov && !nv && narrow === undefined) narrow = v
    if (widen !== undefined && narrow !== undefined) break
  }
  return { compileFailed: false, widenWitness: widen, narrowWitness: narrow }
}
