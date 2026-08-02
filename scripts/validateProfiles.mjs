/**
 * 成果物を JSON Schema と意味規則の両方で検証する。
 *   npm run validate:profiles
 *
 * ## なぜ ajv を入れたか (統合オーダー 2026-08-03 P0-6)
 *
 * 2026-08-03 まで、schema の検証を自前で書いていた。
 * 実装していたのは required / type / enum / const / additionalProperties / $ref /
 * minItems / minimum だけで、**`pattern` を実装していなかった。**
 *
 * ところが同日の P0-1 で provenance に `pattern` 制約を 5 本足していた
 * (inputDigest の sha256、generatedFromCommit の 40 桁 hex、artifactDate の日付形式など)。
 * **そのどれも検証されていなかった。**
 * 意図的な違反 10 種で試すと、**5 種が自前の検証器を素通り**した。
 * 現物の artifact に違反は 0 件だったので誤った値は公開されていないが、
 * 「schema に書いたから守られている」は成り立っていなかった。
 *
 * ## 2 種類の検証を分ける
 *
 *   schema   … 型・必須・列挙・パターン。**ajv (draft-07 の完全実装) に任せる**
 *   semantic … schema では書けない規則。区間の連続性、ID の一意性、
 *              値どうしの整合 (profileId の末尾が inputDigest と一致するか等)
 *
 * 分ける理由は、落ちたときに**どちらの種類の問題か**が即座に分かるようにするため。
 * schema 違反は形の問題、semantic 違反は中身の問題で、直し方が違う。
 */

import Ajv from 'ajv'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = process.cwd()
const read = (p) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))
const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

// strict:false は schema の `description` 等の注釈を許すため。検証の厳しさは落ちない
const ajv = new Ajv({ allErrors: true, strict: false })

// **同じ schema を 2 回 compile しない。** ajv は $id の重複を拒否する
// (profile は 2 つの artifact が同じ schema を使う)
const compiledCache = new Map()
const compile = (schemaPath) => {
  if (!compiledCache.has(schemaPath)) compiledCache.set(schemaPath, ajv.compile(read(schemaPath)))
  return compiledCache.get(schemaPath)
}

/** 検証対象。schema が無いものは semantic だけ回す */
const TARGETS = [
  {
    artifact: 'artifacts/half_plug_topology_profile.v1.trs_jack_trs.json',
    schema: 'schemas/half-plug-topology-profile.v1.schema.json',
    semantic: 'profile',
  },
  {
    artifact: 'artifacts/half_plug_topology_profile.v1.trs_jack_trrs.json',
    schema: 'schemas/half-plug-topology-profile.v1.schema.json',
    semantic: 'profile',
  },
  {
    artifact: 'artifacts/topology_search_difference_signal.json',
    schema: 'schemas/topology-search.v1.schema.json',
    semantic: 'search',
  },
  {
    artifact: 'artifacts/real_jack_comparison.json',
    schema: 'schemas/real-jack-comparison.v1.schema.json',
    semantic: 'comparison',
  },
  {
    artifact: 'artifacts/test_counts.json',
    schema: 'schemas/test-counts.v1.schema.json',
    semantic: 'testCounts',
  },
]

// ---------------------------------------------------------------------------
// semantic 検証 — schema では書けない規則
// ---------------------------------------------------------------------------

const SHA256 = /^[0-9a-f]{64}$/
const HEX40_OR_UNKNOWN = /^([0-9a-f]{40}|UNKNOWN)$/

const SEMANTIC = {
  profile(a, errs) {
    // --- 区間が穴も重複もなく連なっているか ---
    const iv = a.intervals ?? []
    if (!iv.length) errs.push('intervals が空')
    for (let i = 1; i < iv.length; i++)
      if (iv[i].nominalStartMm !== iv[i - 1].nominalEndMm)
        errs.push(`区間の境界が繋がっていない: ${iv[i - 1].intervalId} の終わり ${iv[i - 1].nominalEndMm} ≠ ${iv[i].intervalId} の始まり ${iv[i].nominalStartMm}`)
    if (iv.length) {
      if (iv[0].nominalStartMm !== 0) errs.push(`最初の区間が 0 から始まっていない (${iv[0].nominalStartMm})`)
      if (iv[iv.length - 1].nominalEndMm !== a.fullInsertionDepthMm)
        errs.push(`最後の区間が完全挿入深度で終わっていない (${iv[iv.length - 1].nominalEndMm} ≠ ${a.fullInsertionDepthMm})`)
    }
    // **2026-08-03 追加分。** それまで「記録された値どうしが矛盾しないか」を
    // ほとんど見ていなかった。候補 12 件を変異させて実測したところ **11 件が素通り**した。
    // 構造 (一意性・連続性・存在) は見ていたが、値どうしの整合を見ていなかった。
    for (const x of iv) {
      if (x.nominalEndMm <= x.nominalStartMm) errs.push(`${x.intervalId}: 幅が 0 以下`)
      // normalized は Start と End の両方を見る。**Start だけ見ていた** (非対称なのは単なる抜け)
      for (const [k, mm] of [['normalizedStart', x.nominalStartMm], ['normalizedEnd', x.nominalEndMm]]) {
        const n = mm / a.fullInsertionDepthMm
        if (Math.abs(x[k] - n) > 1e-5) errs.push(`${x.intervalId}: ${k} が mm と合わない (${x[k]} ≠ ${n.toFixed(6)})`)
      }
      // 区間の evidenceGrade は、その区間の接点のうち最も弱いものでなければならない。
      // **合成量は弱いほうへ合わせる**というこのリポジトリの規則そのもの
      const ORDER = ['FACT', 'DERIVED', 'ASSUMPTION', 'UNKNOWN']
      const weakest = (x.contacts ?? []).reduce(
        (acc, c) => (ORDER.indexOf(c.evidenceGrade) > ORDER.indexOf(acc) ? c.evidenceGrade : acc),
        'FACT',
      )
      if (x.contacts?.length && x.evidenceGrade !== weakest)
        errs.push(`${x.intervalId}: evidenceGrade が ${x.evidenceGrade} だが、接点の最弱は ${weakest}`)
    }

    // --- 事象の座標が自己整合か ---
    let prev = -Infinity
    for (const e of a.events ?? []) {
      const n = e.depthMm / a.fullInsertionDepthMm
      if (Math.abs(e.normalized - n) > 1e-5)
        errs.push(`${e.eventId}: normalized が depthMm と合わない (${e.normalized} ≠ ${n.toFixed(6)})`)
      if (e.depthMm < 0 || e.depthMm > a.fullInsertionDepthMm)
        errs.push(`${e.eventId}: depthMm ${e.depthMm} が 0〜${a.fullInsertionDepthMm} の外`)
      if (e.depthMm < prev) errs.push(`${e.eventId}: events が深さ順に並んでいない (${prev} の後に ${e.depthMm})`)
      prev = e.depthMm
    }

    // --- 「探した」と言っているクラスの一覧が、実際に現れたものを覆っているか ---
    for (const t of new Set(iv.map((x) => x.electricalTopology?.topologyClass)))
      if (t && !(a.absentTopologies?.searched ?? []).includes(t))
        errs.push(`区間に現れている ${t} が absentTopologies.searched に無い（探索対象の記録漏れ）`)
    // --- intervalId が一意か ---
    const ivIds = iv.map((x) => x.intervalId)
    if (new Set(ivIds).size !== ivIds.length) errs.push('intervalId が重複している')

    // --- eventId が一意か ---
    const evIds = (a.events ?? []).map((e) => e.eventId)
    if (new Set(evIds).size !== evIds.length) {
      const dup = evIds.filter((x, i) => evIds.indexOf(x) !== i)
      errs.push(`eventId が重複している: ${[...new Set(dup)].join(', ')}`)
    }
    // eventId が label から作られていないこと (文言を変えただけで ID が変わってはいけない)
    for (const e of a.events ?? [])
      if (e.eventId.includes(e.label)) errs.push(`eventId に label の文言が入っている: ${e.eventId}`)

    // --- spreadMm と spreadStatus が矛盾していないか ---
    const HAS_SPREAD = new Set(['MEASURED', 'MODEL_SWEEP_EVENT_SPECIFIC'])
    for (const e of a.events ?? []) {
      if (HAS_SPREAD.has(e.spreadStatus) && e.spreadMm === null)
        errs.push(`${e.eventId}: ${e.spreadStatus} なのに spreadMm が null`)
      if (!HAS_SPREAD.has(e.spreadStatus) && e.spreadMm !== null)
        errs.push(`${e.eventId}: ${e.spreadStatus} なのに spreadMm がある`)

      // **名目値は自分の幅の中に無ければならない (統合フォローアップ P0-3)。**
      //
      // 2026-08-03 の Half-Plug 側 fixture import で見つかった。
      // TRS×TRRS profile の FIRST_BREAK_OPEN は名目 8.48mm なのに、
      // 付いていた幅は 8.06〜8.06mm だった。**自分の幅の外にある。**
      // 原因は感度解析が TRS|JACK-TRS 固定で、その結果を variant を問わず
      // 配っていたこと。幅が本当にその variant のものなら、名目値は必ず幅に入る。
      //
      // 意味規則を 45 本書いておきながら、この基本的な自己整合を落としていた。
      if (HAS_SPREAD.has(e.spreadStatus) && e.spreadMm)
        if (e.depthMm < e.spreadMm.minMm || e.depthMm > e.spreadMm.maxMm)
          errs.push(
            `${e.eventId}: 名目値 ${e.depthMm} が自分の幅 ${e.spreadMm.minMm}〜${e.spreadMm.maxMm} の外にある`
              + `（別 variant の解析を流用した疑い）`,
          )
    }

    // --- provenance ---
    const p = a.provenance
    if (!p) errs.push('provenance が無い')
    else {
      if (!SHA256.test(p.inputDigest)) errs.push(`inputDigest が sha256 の形ではない: ${p.inputDigest}`)
      if (!HEX40_OR_UNKNOWN.test(p.generatedFromCommit))
        errs.push(`generatedFromCommit が 40 桁 hex でも UNKNOWN でもない: ${p.generatedFromCommit}`)
      if (!HEX40_OR_UNKNOWN.test(a.sourceRevision))
        errs.push(`sourceRevision が 40 桁 hex でも UNKNOWN でもない: ${a.sourceRevision}`)
      // **profileId の末尾は inputDigest の先頭 12 桁でなければならない。**
      // ここがずれると、受け手が digest で固定したつもりで別の profile を見る
      const want = p.inputDigest.slice(0, 12)
      if (!String(a.profileId).endsWith(want))
        errs.push(`profileId の末尾が inputDigest の先頭 12 桁と違う (${a.profileId} / 期待 ...${want})`)
      // 生成物自身を入力に混ぜていないこと (自己参照になる)
      for (const f of p.inputFiles ?? [])
        if (f.path.includes('half_plug_topology_profile'))
          errs.push(`生成物自身が入力に入っている: ${f.path}`)

      // **inputFiles の sha256 が実ファイルと一致するか。**
      // provenance の話は全部これに乗っている。ここが嘘なら inputDigest は無意味で、
      // 受け手の再計算も無意味になる。**それを一度も検査していなかった。**
      // 手元にファイルがある場合だけ見る (release asset を受け取った側では原理的に見られない)
      let mismatched = 0
      for (const f of p.inputFiles ?? []) {
        const abs = resolve(ROOT, f.path)
        if (!existsSync(abs)) continue
        if (sha256File(abs) !== f.sha256) {
          mismatched++
          if (mismatched <= 3) errs.push(`inputFiles の sha256 が実ファイルと違う: ${f.path}`)
        }
      }
      if (mismatched > 3) errs.push(`inputFiles の sha256 不一致は他に ${mismatched - 3} 件`)
      if (p.workingTreeDirty === true && p.artifactKind === 'release')
        errs.push('dirty な入力から release artifact が作られている')
    }

    // --- 根拠件数が台帳と一致するか (テストにはあったが検証器には無かった) ---
    try {
      const dims = read('src/data/dimensions.json').entries
      const counts = { FACT: 0, DERIVED: 0, ASSUMPTION: 0, UNKNOWN: 0 }
      for (const v of Object.values(dims)) counts[v.grade]++
      for (const [g, n] of Object.entries(counts))
        if ((a.assumptionSummary?.counts ?? {})[g] !== n)
          errs.push(`assumptionSummary.counts.${g} が台帳と違う (${a.assumptionSummary?.counts?.[g]} ≠ ${n})`)
    } catch {
      /* 台帳が読めない環境 (release asset だけ受け取った側) では見ない */
    }

    // --- 主張の一貫性 ---
    if (a.modelLimitations?.verifiedPhysical !== false)
      errs.push('verifiedPhysical が false でない (実測していない)')
    const present = new Set(iv.map((x) => x.electricalTopology?.topologyClass))
    for (const t of a.absentTopologies?.absent ?? [])
      if (present.has(t)) errs.push(`absent と言っているクラスが区間に現れている: ${t}`)
    for (const t of present)
      if ((a.absentTopologies?.absent ?? []).includes(t)) errs.push(`現れているクラスが absent に入っている: ${t}`)
  },

  search(a, errs) {
    // --- 内訳と合計が一致するか ---
    const sum = (o) => Object.values(o ?? {}).reduce((x, y) => x + y, 0)
    if (sum(a.witnessCountByVariant) !== a.witnessCount)
      errs.push(`witnessCountByVariant の合計が witnessCount と違う (${sum(a.witnessCountByVariant)} ≠ ${a.witnessCount})`)
    if (sum(a.usableWitnesses?.byVariant) !== a.usableWitnesses?.total)
      errs.push('usableWitnesses の内訳が合計と違う')
    if (a.usableWitnessCount !== a.usableWitnesses?.total)
      errs.push('usableWitnessCount と usableWitnesses.total が違う')

    // --- found と件数が食い違っていないか ---
    if (a.found !== a.witnessCount > 0) errs.push('found と witnessCount が食い違っている')
    if (a.foundWithWorkingJack !== a.usableWitnessCount > 0)
      errs.push('foundWithWorkingJack と usableWitnessCount が食い違っている')

    // --- 件数を出した分類は標本も出しているか ---
    for (const [name, cat] of [
      ['usableWitnesses', a.usableWitnesses],
      ['brokenJackWitnesses', a.brokenJackWitnesses],
    ]) {
      if (!cat) continue
      if (cat.total > 0 && cat.samples.length === 0) errs.push(`${name}: ${cat.total} 件あるのに標本が 0 件`)
      if (cat.droppedFromListing !== cat.total - cat.samples.length)
        errs.push(`${name}: 切り捨て件数が合わない`)
      // 成立した variant が標本から消えていないこと
      const shown = new Set(cat.samples.map((w) => w.variantId))
      for (const [v, n] of Object.entries(cat.byVariant ?? {}))
        if (n > 0 && !shown.has(v)) errs.push(`${name}: ${v} が ${n} 件あるのに標本に 1 件も無い`)
    }

    // --- 走査軸が variant に効く形か ---
    for (const [v, keys] of Object.entries(a.searchSpace?.axesUsedPerVariant ?? {})) {
      if (!keys.length) errs.push(`${v}: 走査軸が 0 件`)
      const isTrrs = v.endsWith('JACK-TRRS')
      for (const k of keys.filter((x) => x.includes('contact') && !x.includes('complianceMm')))
        if (isTrrs !== k.startsWith('trrs.')) errs.push(`${v}: 軸 ${k} が variant と噛み合っていない`)
    }
    // 既定値が水準に入っているか (入っていないと「無改造」を数え損なう)
    for (const axes of Object.values(a.searchSpace?.axesByJack ?? {}))
      for (const ax of axes)
        if (!ax.levels.includes(ax.shipped)) errs.push(`軸 ${ax.key}: 水準に既定値 ${ax.shipped} が無い`)

    // --- variantBasis が全 variant を覆っているか ---
    for (const v of a.searchSpace?.variants ?? [])
      if (!a.searchSpace?.variantBasis?.[v]) errs.push(`variantBasis に ${v} が無い`)

    // --- 表現が強すぎないか ---
    if (a.realizability?.heuristic?.manufacturingVerified !== false)
      errs.push('manufacturingVerified が false でない (製造可能性は確認していない)')
    // 旧名が復活していないこと。
    // **removedMeasures は除いて見る。** そこには廃止した名前が載っているのが正しく、
    // 全文検索すると「廃止の記録」そのものを違反として拾ってしまう (実際に拾った)。
    const withoutRecord = { ...a, removedMeasures: undefined }
    const whole = JSON.stringify(withoutRecord)
    for (const old of ['realizablePadWidth', 'needsNoModification', 'strictDifferenceSignal'])
      if (whole.includes(old)) errs.push(`廃止した名前が復活している: ${old}`)
    // 廃止の記録そのものは残っていること
    if (!(a.removedMeasures ?? []).some((r) => r.key === 'strictDifferenceSignal'))
      errs.push('strictDifferenceSignal の廃止記録が消えている')
    // 反対証拠が残っていること
    if (!a.realizability?.counterEvidence) errs.push('反対証拠 (counterEvidence) が無い')
  },

  comparison(a, errs) {
    // **この artifact の核心。図面値では区間が出ないという反証を消させない。**
    if ((a.result?.drawing?.differenceWindows ?? []).length !== 0)
      errs.push('図面値で左右差分の区間が出ている (反証が消えている)')
    if ((a.result?.assumed?.differenceWindows ?? []).length === 0)
      errs.push('仮定値で区間が出ていない (比較が成立していない)')
    // 実在資料 2 件が逆を指していることを保つ
    if ((a.lumbergTerminalScenario?.differenceWindows ?? []).length === 0)
      errs.push('Lumberg 端子位置で区間が出ていない (2 件が逆を指すという記録が崩れている)')
    if (a.decision?.chosen !== 'compare-only')
      errs.push(`decision.chosen が compare-only でない (${a.decision?.chosen})`)
    // 窓の向きが正しいこと
    for (const side of ['assumed', 'drawing'])
      for (const w of a.result?.[side]?.differenceWindows ?? [])
        if (w.toMm < w.fromMm) errs.push(`${side}: 窓の始点と終点が逆 (${w.fromMm} → ${w.toMm})`)
    if (!(a.limitations ?? []).length) errs.push('limitations が空 (未確認事項を消している)')
  },

  testCounts(a, errs) {
    const sum = Object.values(a.byFile ?? {}).reduce((x, y) => x + y, 0)
    if (sum !== a.total) errs.push(`byFile の合計が total と違う (${sum} ≠ ${a.total})`)
    if (a.skipped !== 0) errs.push(`飛ばされたテストが ${a.skipped} 件ある (skip は「見ていない」)`)
  },
}

// ---------------------------------------------------------------------------

let failed = 0
for (const t of TARGETS) {
  if (!existsSync(resolve(ROOT, t.artifact))) {
    console.log(`  ✗ ${t.artifact} — 存在しない`)
    failed++
    continue
  }
  const a = read(t.artifact)
  const schemaErrs = []
  const semanticErrs = []

  // --- schema ---
  const v = compile(t.schema)
  if (!v(a))
    for (const e of v.errors) schemaErrs.push(`${e.instancePath || '(root)'}: ${e.keyword} — ${e.message}`)

  // --- semantic ---
  SEMANTIC[t.semantic](a, semanticErrs)

  const n = schemaErrs.length + semanticErrs.length
  if (n === 0) {
    console.log(`  ✓ ${t.artifact}`)
  } else {
    failed++
    console.log(`  ✗ ${t.artifact} — ${n} 件`)
    if (schemaErrs.length) {
      console.log(`      [schema] ${schemaErrs.length} 件 — 形の問題`)
      for (const e of schemaErrs.slice(0, 12)) console.log(`        ${e}`)
      if (schemaErrs.length > 12) console.log(`        ... 他 ${schemaErrs.length - 12} 件`)
    }
    if (semanticErrs.length) {
      console.log(`      [semantic] ${semanticErrs.length} 件 — 中身の問題`)
      for (const e of semanticErrs.slice(0, 12)) console.log(`        ${e}`)
      if (semanticErrs.length > 12) console.log(`        ... 他 ${semanticErrs.length - 12} 件`)
    }
  }
}

console.log(
  failed === 0
    ? `\n${TARGETS.length} 件すべてが schema と意味規則の両方に適合しています。`
    : `\n**${failed} / ${TARGETS.length} 件が不適合です。**`,
)
process.exit(failed === 0 ? 0 : 1)
