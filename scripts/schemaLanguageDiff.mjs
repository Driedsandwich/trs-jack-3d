/**
 * schema の「言語」が広がったか狭まったかを機械で決める。
 *   node scripts/schemaLanguageDiff.mjs <旧schema> <新schema>
 *
 * ## 何のためか
 *
 * 版を上げるかどうかを **artifact の中身に依存させないため**である。
 *
 * 最初に書いた条文は「旧 schema を pin した consumer が**今の artifact**を拒むか」だった。
 * これを実測すると判定できるように見えるが、**同じ schema 変更でも artifact 次第で反転する**。
 *
 *   v0.3.0 schema × 現物 (role に input-scope を使う)          → 拒む   → 「上げる」
 *   v0.3.0 schema × role を input-scope から戻した同じ artifact → 受ける → 「据え置き可」
 *                                                    (書き換えたのは 1 項目だけ)
 *
 * つまり enum に値を足しても、その版の artifact がまだ使っていなければ据え置きが許され、
 * **使い始めた版で突然止まる**。破壊的変更の記録が「いつ壊したか」ではなく
 * 「いつ使い始めたか」にずれる。
 *
 * だから判定は **新旧 2 つの schema だけ**で行う。条文は docs/SCHEMA_VERSIONING_POLICY.md。
 *
 * ## 判定
 *
 *   BUMP         新 ⊄ 旧 (広がった / 決められない) → 版を上げる
 *   HOLD_RECORD  新 ⊊ 旧 (狭まった)               → 据え置き可。ただし記録する
 *   HOLD         新 = 旧                          → 据え置き可
 *
 * ## 出力の 2 つのパス
 *
 *   path     $.provenance.inputFiles[].role     人が読む位置 (instance 寄り)
 *   pointer  /properties/provenance/.../enum    **schema への JSON Pointer**
 *
 * pointer は contractMigration の記録と schema 実物を突き合わせるために要る
 * (test/contractMigration.test.ts の検査①)。
 *
 * ## 限界
 *
 * JSON Schema の言語包含は一般には決定不能なので、**これは保守的な近似**である。
 * 決められない変更 (pattern の書き換え・oneOf の枝数変更・未対応キーワード) は
 * すべて BUMP 側へ倒す。「上げなくてよいのに上げる」誤りは残るが、
 * 逆 (上げるべきなのに据え置く) は起きないようにしてある。
 *
 * $ref は辿るが、循環参照は打ち切って UNDEC にする (黙って通さない)。
 */

import { readFileSync } from 'node:fs'

export const WIDEN = 'WIDEN'
export const NARROW = 'NARROW'
export const UNDEC = 'UNDEC'

const NEUTRAL_KEYS = ['description', 'title', '$comment', '$schema', '$id', 'examples', 'default']
const LOWER_BOUNDS = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties']
const UPPER_BOUNDS = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties']
const KNOWN = new Set([
  ...NEUTRAL_KEYS,
  ...LOWER_BOUNDS,
  ...UPPER_BOUNDS,
  'type', 'enum', 'const', 'required', 'properties', 'items', 'additionalProperties',
  'pattern', 'uniqueItems', 'oneOf', 'anyOf', 'allOf', 'definitions', '$defs', '$ref',
])

const REF_LIMIT = 50

/** JSON Pointer のトークンを escape する (RFC 6901) */
const tok = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1')

class Diff {
  constructor() {
    this.facts = []
  }

  add(kind, path, pointer, detail) {
    this.facts.push({ kind, path, pointer, detail })
  }

  get verdict() {
    const kinds = new Set(this.facts.map((f) => f.kind))
    if (kinds.has(WIDEN) || kinds.has(UNDEC)) return 'BUMP'
    if (kinds.has(NARROW)) return 'HOLD_RECORD'
    return 'HOLD'
  }
}

/** $ref を辿る。辿れない・深すぎるときは目印を返し、呼び出し側で UNDEC にする */
function deref(node, root) {
  let n = 0
  while (node && typeof node === 'object' && !Array.isArray(node) && '$ref' in node && Object.keys(node).length === 1) {
    const ref = node.$ref
    if (typeof ref !== 'string' || !ref.startsWith('#/')) return { __unresolvable__: String(ref) }
    let cur = root
    for (const part of ref.slice(2).split('/')) {
      cur = cur && typeof cur === 'object' ? cur[part] : undefined
      if (cur === undefined) return { __unresolvable__: ref }
    }
    node = cur
    if (++n > REF_LIMIT) return { __unresolvable__: `${ref} (循環している可能性)` }
  }
  return node
}

const typesOf = (node) => {
  const t = node.type
  if (t === undefined) return null
  return new Set(Array.isArray(t) ? t : [t])
}

const isSuperset = (a, b) => [...b].every((x) => a.has(x))
const sorted = (s) => [...s].sort()

/**
 * 集合の包含で widen / narrow を決める。
 * widenIfSuperset=false は「集合が増えると狭まる」もの (required がこれ)。
 */
function cmpSets(d, path, ptr, kw, oldSet, newSet, widenIfSuperset = true) {
  const p = `${ptr}/${kw}`
  if (oldSet.size === newSet.size && isSuperset(oldSet, newSet)) return
  const grew = isSuperset(newSet, oldSet)
  const shrank = isSuperset(oldSet, newSet)
  const added = () => sorted(new Set([...newSet].filter((x) => !oldSet.has(x))))
  const removed = () => sorted(new Set([...oldSet].filter((x) => !newSet.has(x))))
  if (grew) {
    d.add(widenIfSuperset ? WIDEN : NARROW, path, p, `${kw}: 値が増えた ${JSON.stringify(added())}`)
  } else if (shrank) {
    d.add(widenIfSuperset ? NARROW : WIDEN, path, p, `${kw}: 値が減った ${JSON.stringify(removed())}`)
  } else {
    d.add(UNDEC, path, p, `${kw}: 入れ替わった -${JSON.stringify(removed())} +${JSON.stringify(added())}`)
  }
}

function compare(o, n, oroot, nroot, path, ptr, d, seen) {
  o = deref(o, oroot)
  n = deref(n, nroot)
  const obj = (x) => x && typeof x === 'object' && !Array.isArray(x)
  if (!obj(o) || !obj(n)) {
    if (JSON.stringify(o) !== JSON.stringify(n)) {
      d.add(UNDEC, path, ptr, `schema でない値が変わった: ${JSON.stringify(o)} -> ${JSON.stringify(n)}`)
    }
    return
  }
  if ('__unresolvable__' in o || '__unresolvable__' in n) {
    d.add(UNDEC, path, ptr, `$ref を解決できない (${o.__unresolvable__ ?? n.__unresolvable__})`)
    return
  }
  if (seen.has(ptr)) return
  seen.add(ptr)

  // --- type ---
  const ot = typesOf(o)
  const nt = typesOf(n)
  if (JSON.stringify(ot && sorted(ot)) !== JSON.stringify(nt && sorted(nt))) {
    if (ot === null) d.add(NARROW, path, `${ptr}/type`, `type: 制約が付いた ${JSON.stringify(sorted(nt))}`)
    else if (nt === null) d.add(WIDEN, path, `${ptr}/type`, 'type: 制約が外れた')
    else cmpSets(d, path, ptr, 'type', ot, nt)
  }

  // --- enum / const ---
  if ('enum' in o || 'enum' in n) {
    if (!('enum' in o)) d.add(NARROW, path, `${ptr}/enum`, `enum: 制約が付いた ${JSON.stringify(n.enum)}`)
    else if (!('enum' in n)) d.add(WIDEN, path, `${ptr}/enum`, 'enum: 制約が外れた')
    else cmpSets(d, path, ptr, 'enum', new Set(o.enum.map((v) => JSON.stringify(v))), new Set(n.enum.map((v) => JSON.stringify(v))))
  }
  if ('const' in o || 'const' in n) {
    const p = `${ptr}/const`
    if (!('const' in o)) d.add(NARROW, path, p, `const: 固定された ${JSON.stringify(n.const)}`)
    else if (!('const' in n)) d.add(WIDEN, path, p, 'const: 固定が外れた')
    else if (JSON.stringify(o.const) !== JSON.stringify(n.const)) {
      d.add(UNDEC, path, p, `const: 値が変わった ${JSON.stringify(o.const)} -> ${JSON.stringify(n.const)}`)
    }
  }

  // --- required: 増えると狭まる ---
  cmpSets(d, path, ptr, 'required', new Set(o.required ?? []), new Set(n.required ?? []), false)

  // --- additionalProperties ---
  const oap = o.additionalProperties ?? true
  const nap = n.additionalProperties ?? true
  const apPtr = `${ptr}/additionalProperties`
  if (typeof oap === 'boolean' && typeof nap === 'boolean') {
    if (oap !== nap) d.add(nap ? WIDEN : NARROW, path, apPtr, `additionalProperties: ${oap} -> ${nap}`)
  } else if (typeof oap === 'boolean' || typeof nap === 'boolean') {
    d.add(UNDEC, path, apPtr, 'additionalProperties: bool と schema が入れ替わった')
  } else {
    compare(oap, nap, oroot, nroot, `${path}.additionalProperties`, apPtr, d, seen)
  }

  // --- properties ---
  const op = o.properties ?? {}
  const np = n.properties ?? {}
  for (const k of Object.keys(np).filter((x) => !(x in op)).sort()) {
    const p = `${ptr}/properties/${tok(k)}`
    if (oap === false) d.add(WIDEN, `${path}.${k}`, p, '項目の追加: 旧は additionalProperties:false なのでこの key は禁止だった')
    else d.add(NARROW, `${path}.${k}`, p, '項目の追加: 旧は無制約だったが新は型が付いた')
  }
  for (const k of Object.keys(op).filter((x) => !(x in np)).sort()) {
    const p = `${ptr}/properties/${tok(k)}`
    if (nap === false) d.add(NARROW, `${path}.${k}`, p, '項目の削除: 新は additionalProperties:false なのでこの key は禁止になる')
    else d.add(WIDEN, `${path}.${k}`, p, '項目の削除: 新では無制約になる')
  }
  for (const k of Object.keys(op).filter((x) => x in np).sort()) {
    compare(op[k], np[k], oroot, nroot, `${path}.${k}`, `${ptr}/properties/${tok(k)}`, d, seen)
  }

  // --- items ---
  if ('items' in o || 'items' in n) {
    const p = `${ptr}/items`
    if (!('items' in o)) d.add(NARROW, path, p, 'items: 要素に制約が付いた')
    else if (!('items' in n)) d.add(WIDEN, path, p, 'items: 要素の制約が外れた')
    else compare(o.items, n.items, oroot, nroot, `${path}[]`, p, d, seen)
  }

  // --- 数値境界 ---
  for (const kw of LOWER_BOUNDS) {
    const ov = o[kw]
    const nv = n[kw]
    if (ov === nv) continue
    const p = `${ptr}/${kw}`
    if (ov === undefined) d.add(NARROW, path, p, `${kw}: 下限が付いた (${nv})`)
    else if (nv === undefined) d.add(WIDEN, path, p, `${kw}: 下限が外れた (${ov})`)
    else d.add(nv > ov ? NARROW : WIDEN, path, p, `${kw}: ${ov} -> ${nv}`)
  }
  for (const kw of UPPER_BOUNDS) {
    const ov = o[kw]
    const nv = n[kw]
    if (ov === nv) continue
    const p = `${ptr}/${kw}`
    if (ov === undefined) d.add(NARROW, path, p, `${kw}: 上限が付いた (${nv})`)
    else if (nv === undefined) d.add(WIDEN, path, p, `${kw}: 上限が外れた (${ov})`)
    else d.add(nv > ov ? WIDEN : NARROW, path, p, `${kw}: ${ov} -> ${nv}`)
  }

  // --- pattern / uniqueItems ---
  if (o.pattern !== n.pattern) {
    const p = `${ptr}/pattern`
    if (o.pattern === undefined) d.add(NARROW, path, p, `pattern: 制約が付いた ${JSON.stringify(n.pattern)}`)
    else if (n.pattern === undefined) d.add(WIDEN, path, p, `pattern: 制約が外れた ${JSON.stringify(o.pattern)}`)
    else d.add(UNDEC, path, p, `pattern: 書き換わった (包含は機械判定しない) ${JSON.stringify(o.pattern)} -> ${JSON.stringify(n.pattern)}`)
  }
  const ou = o.uniqueItems ?? false
  const nu = n.uniqueItems ?? false
  if (ou !== nu) d.add(nu ? NARROW : WIDEN, path, `${ptr}/uniqueItems`, `uniqueItems: ${ou} -> ${nu}`)

  // --- oneOf / anyOf / allOf ---
  for (const kw of ['oneOf', 'anyOf', 'allOf']) {
    const ol = o[kw]
    const nl = n[kw]
    if (JSON.stringify(ol) === JSON.stringify(nl)) continue
    if (!ol || !nl || ol.length !== nl.length) {
      d.add(UNDEC, path, `${ptr}/${kw}`, `${kw}: 枝の数が変わった (包含は機械判定しない)`)
    } else {
      ol.forEach((a, i) => compare(a, nl[i], oroot, nroot, `${path}.${kw}[${i}]`, `${ptr}/${kw}/${i}`, d, seen))
    }
  }

  // --- 未対応キーワード: 黙って通さない ---
  for (const k of [...new Set([...Object.keys(o), ...Object.keys(n)])].sort()) {
    if (KNOWN.has(k)) continue
    if (JSON.stringify(o[k]) !== JSON.stringify(n[k])) {
      d.add(UNDEC, path, `${ptr}/${tok(k)}`, `未対応キーワード ${k} が変わった (判定できないので BUMP 側へ倒す)`)
    }
  }
}

/** 2 つの schema オブジェクトを比べる */
export function diffSchemaObjects(oldSchema, newSchema) {
  const d = new Diff()
  compare(oldSchema, newSchema, oldSchema, newSchema, '$', '', d, new Set())
  return { verdict: d.verdict, facts: d.facts }
}

/** 2 つの schema ファイルを比べる */
export function diffSchemaFiles(oldPath, newPath) {
  return diffSchemaObjects(JSON.parse(readFileSync(oldPath, 'utf8')), JSON.parse(readFileSync(newPath, 'utf8')))
}

/**
 * JSON Pointer を解決する。**存在しなければ undefined**（呼び出し側で落とすこと）。
 *
 * 途中で `$ref` に当たったら辿る。**diff が出す pointer は展開後の位置**なので、
 * 辿らないと `/properties/provenance/properties/...` のような位置が
 * 「実在しない」と誤判定される（provenance は #/definitions/provenance への $ref）。
 */
export function resolvePointer(root, pointer) {
  if (pointer === '') return root
  if (!pointer.startsWith('/')) return undefined
  let cur = root
  for (const raw of pointer.slice(1).split('/')) {
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    cur = deref(cur, root)
    if (cur === null || typeof cur !== 'object' || '__unresolvable__' in cur) return undefined
    cur = Array.isArray(cur) ? cur[Number(part)] : cur[part]
    if (cur === undefined) return undefined
  }
  return deref(cur, root)
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())
if (invokedDirectly && process.argv.length >= 4) {
  const r = diffSchemaFiles(process.argv[2], process.argv[3])
  console.log(r.verdict)
  for (const f of r.facts) console.log(`  ${f.kind.padEnd(6)} ${f.path}\n         ${f.pointer}\n         ${f.detail}`)
  process.exit(r.verdict === 'BUMP' ? 1 : 0)
}
