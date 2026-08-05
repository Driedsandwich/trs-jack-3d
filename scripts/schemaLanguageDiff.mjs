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
 * 決められない変更 (pattern の書き換え・oneOf の変更・未対応キーワード) は
 * すべて BUMP 側へ倒す。「上げなくてよいのに上げる」誤りは残る。
 *
 * **v0.5.0 までは「逆 (上げるべきなのに据え置く) は起きない」と書いていたが、それは嘘だった。**
 * `oneOf` の枝を index 同士で比較しており、枝を狭めたのに全体は広がる場合を
 * HOLD_RECORD と誤判定していた (外部監査で ajv 付きの反例が出た。下の oneOf の節)。
 * v0.5.1 で `oneOf` は変更があれば無条件 UNDEC へ倒すようにした。
 *
 * **同じ形の穴が他にも残っている可能性は消えていない。**
 * 「危険側の誤りは起きない」と再び書かないこと。言えるのは
 * 「**いま反例が見つかっている経路は塞いだ**」までである。
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
/**
 * **判定器が正しく扱えると宣言した keyword。allowlist である。**
 *
 * v0.5.1 までは「知らない keyword が**変わったら**倒す」形だった。
 * これでは、**変わっていない keyword が他の keyword の意味を変える**場合を取りこぼす。
 * 実際に外部監査が 3 件出した（patternProperties が居ると項目削除は狭まらない、など）。
 *
 * v0.5.2 からは **宣言外の keyword が「在る」だけで倒す**（かつその節が変わっていれば）。
 * 宣言集合は現行 schema が実際に使う keyword を機械で数えて決めた
 * (test/schemaVersioningPolicy.test.ts の ①-d が、宣言外が現れたら落とす)。
 *
 * **ここへ足すときは、判定器が本当にその keyword を扱えるようにしてから足すこと。**
 * 足すだけでは、倒れていたものが倒れなくなるだけである。
 */
export const HANDLED_KEYWORDS = new Set([
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
    else if (oap === true) d.add(NARROW, `${path}.${k}`, p, '項目の追加: 旧は無制約だったが新は型が付いた')
    /**
     * **旧の additionalProperties が schema のときは「無制約」ではない。**
     * その key は additionalProperties の schema の制約下にあった。
     * 明示 property へ移すと、新しい型が旧の制約より広いことも狭いこともある。
     * v0.5.1 までは NARROW と決め打ちしていて、**広がる場合を据え置き可と誤判定した。**
     */
    else d.add(UNDEC, `${path}.${k}`, p, '項目の追加: 旧は additionalProperties の schema の制約下にあった (広狭を機械判定しない)')
  }
  for (const k of Object.keys(op).filter((x) => !(x in np)).sort()) {
    const p = `${ptr}/properties/${tok(k)}`
    if (nap === false) d.add(NARROW, `${path}.${k}`, p, '項目の削除: 新は additionalProperties:false なのでこの key は禁止になる')
    else if (nap === true) d.add(WIDEN, `${path}.${k}`, p, '項目の削除: 新では無制約になる')
    else d.add(UNDEC, `${path}.${k}`, p, '項目の削除: 新では additionalProperties の schema の制約下に入る (広狭を機械判定しない)')
  }
  for (const k of Object.keys(op).filter((x) => x in np).sort()) {
    compare(op[k], np[k], oroot, nroot, `${path}.${k}`, `${ptr}/properties/${tok(k)}`, d, seen)
  }

  /**
   * --- $ref に sibling がある節の参照先 ---
   *
   * `deref()` は `$ref` が唯一の key のときしか辿らない。
   * そのため **sibling がある節（profile v3 の evidenceGrade がこれ）は、
   * 節自体が同じまま参照先だけ変わっても何も見えなかった。**
   *
   * 節が変わっていれば下の allowlist ゲートが倒す。ここで見るのは
   * **節は同じで参照先だけ変わった**場合である。
   * `definitions` を丸ごと走査する形にすると、`deref` 経由で見えている変更と
   * 二重に出るので採らない（記録側が同じ差分を 2 か所へ書く羽目になる）。
   */
  for (const [node, isOld] of [[o, true], [n, false]]) {
    if (!('$ref' in node) || Object.keys(node).length === 1) continue
    const other = isOld ? n : o
    if (!('$ref' in other) || other.$ref !== node.$ref) continue // 参照先が違うならゲートが倒す
    if (!isOld) continue // 1 回だけ比べる
    const a = deref({ $ref: node.$ref }, oroot)
    const b = deref({ $ref: other.$ref }, nroot)
    compare(a, b, oroot, nroot, `${path}(ref)`, `${ptr}/$ref`, d, seen)
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

  /**
   * --- oneOf ---
   *
   * **枝を狭めても全体が狭まるとは限らない。**`oneOf` は「ちょうど 1 枝が一致」なので、
   * 枝の言語について単調ではない。実測した反例:
   *
   *   旧  oneOf: [{integer}, {number, minimum: 0}]
   *   新  oneOf: [{integer}, {number, minimum: 1}]
   *
   *   値 0    旧 invalid (2 枝が一致するので oneOf は落ちる) → 新 valid  **広がった**
   *   値 0.5  旧 valid                                    → 新 invalid 狭まった
   *
   * 枝を index 同士で再帰比較していた v0.5.0 までの実装は、これを
   * 「minimum が上がった = NARROW」とだけ見て **HOLD_RECORD** を返していた。
   * **危険な向き (上げるべきなのに据え置く) の誤りである。**
   *
   * 一般の包含判定を作る必要は無い。**変更があれば無条件で BUMP 側へ倒す。**
   */
  if (JSON.stringify(o.oneOf) !== JSON.stringify(n.oneOf)) {
    d.add(
      UNDEC,
      path,
      `${ptr}/oneOf`,
      'oneOf: 変わった (「ちょうど 1 枝」は枝の言語について単調でないので、枝ごとの比較では決められない)',
    )
  }

  /**
   * --- anyOf / allOf ---
   *
   * こちらは和と積なので**枝ごとに単調である**。
   * 各枝が狭まれば ∪ も ∩ も狭まり、各枝が広がれば逆も同じ。
   * 枝が混在すれば WIDEN と NARROW が両方立ち、verdict は BUMP になる (安全側)。
   * so 枝ごとの再帰比較で健全。
   */
  for (const kw of ['anyOf', 'allOf']) {
    const ol = o[kw]
    const nl = n[kw]
    if (JSON.stringify(ol) === JSON.stringify(nl)) continue
    if (!ol || !nl || ol.length !== nl.length) {
      d.add(UNDEC, path, `${ptr}/${kw}`, `${kw}: 枝の数が変わった (包含は機械判定しない)`)
    } else {
      ol.forEach((a, i) => compare(a, nl[i], oroot, nroot, `${path}.${kw}[${i}]`, `${ptr}/${kw}/${i}`, d, seen))
    }
  }

  /**
   * --- allowlist ゲート（v0.5.2）---
   *
   * **宣言外の keyword が「在る」だけで倒す。**変わったかどうかではない。
   * 変わっていない keyword が、他の keyword の意味を変えることがあるためである
   * （patternProperties が居ると、明示 property を消しても禁止にならない）。
   *
   * ただし**その節が新旧でまったく同じなら倒さない。**言語も同じだからで、
   * ここを倒すと同一 schema 同士の比較まで BUMP になり、条文が使えなくなる。
   */
  const reasons = []
  for (const k of [...new Set([...Object.keys(o), ...Object.keys(n)])].sort()) {
    if (!HANDLED_KEYWORDS.has(k)) reasons.push(`未対応キーワード ${k}`)
  }
  // **$ref に sibling があると deref が辿らない。**辿らないまま他の keyword だけ比べても意味がない
  for (const [label, node] of [['旧', o], ['新', n]]) {
    if ('$ref' in node && Object.keys(node).length > 1) reasons.push(`${label}の $ref に sibling がある`)
  }
  if (reasons.length > 0 && JSON.stringify(o) !== JSON.stringify(n)) {
    d.add(UNDEC, path, ptr, `扱えない構文があり、この節が変わっている (${[...new Set(reasons)].join(' / ')}) — 判定できないので BUMP 側へ倒す`)
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
