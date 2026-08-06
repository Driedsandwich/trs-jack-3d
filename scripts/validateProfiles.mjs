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
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkWindowInvariants } from './robustnessWindows.mjs'
import { checkRecord, evaluateGate, REQUIRED_FOR_PROFILE, GATE_DOCUMENT, LEDGER_PATH, GATE_VERSION, CLAIM_SCOPE } from './measurementGate.mjs'

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
    artifact: 'artifacts/half_plug_topology_profile.v3.trs_jack_trs.json',
    schema: 'schemas/half-plug-topology-profile.v3.schema.json',
    semantic: 'profile',
  },
  {
    artifact: 'artifacts/half_plug_topology_profile.v3.trs_jack_trrs.json',
    schema: 'schemas/half-plug-topology-profile.v3.schema.json',
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
    schema: 'schemas/test-counts.v2.schema.json',
    semantic: 'testCounts',
  },
  // 感度 artifact。**2026-08-03 まで schema が無く、下流が独自に構造検査を書いていた**
  // (非阻害フォローアップ P1-2)
  {
    artifact: 'artifacts/sensitivity.trs_jack_trs.json',
    schema: 'schemas/event-sensitivity.v2.schema.json',
    semantic: 'sensitivity',
  },
  {
    artifact: 'artifacts/sensitivity.trs_jack_trrs.json',
    schema: 'schemas/event-sensitivity.v2.schema.json',
    semantic: 'sensitivity',
  },
  // 目標トポロジーの頑健性 (非阻害フォローアップ P1-4)
  {
    artifact: 'artifacts/topology-robustness.trs_jack_trrs.json',
    schema: 'schemas/topology-robustness.v3.schema.json',
    semantic: 'robustness',
  },
  // release evidence (v0.2.0 フォローアップ §2)。
  // **validation-results と release index はここに入れない。**自分自身を記述できず、
  // 1 回の実行で収束しないため。あちらは buildReleaseEvidence が書いた直後に schema で見る
  {
    artifact: 'artifacts/source-input-manifest.json',
    schema: 'schemas/source-input-manifest.v2.schema.json',
    semantic: 'sourceInputManifest',
  },
  // 入力の範囲定義 (v0.3.0 フォローアップ P1-2)。
  // **生成側と検証側が同じこれを読む**ので、ここが壊れると両方が同時に狂う
  {
    artifact: 'source-input-scope.v1.json',
    schema: 'schemas/source-input-scope.v1.schema.json',
    semantic: 'sourceInputScope',
  },
  /**
   * オフラインの受け手のための source snapshot（v0.5.0・オーダー §2）。
   * **これは producer の申告であり、受け手の独立検証を置き換えない。**
   * 意味規則で、写しの中身と記録した sha256 が実際に一致するかまで見る。
   */
  {
    artifact: 'artifacts/source-snapshot.v1.json',
    schema: 'schemas/source-snapshot.v1.schema.json',
    semantic: 'sourceSnapshot',
  },
  /**
   * 版と契約変更の対応表の正本（v0.5.1 で schema を新設）。
   * v0.5.0 では**中央の正本だけ schema が無かった**（外部監査で指摘）。
   * 6 本の artifact に埋め込まれる値の出どころなので、ここが壊れると全部が壊れる。
   */
  {
    artifact: 'contract-migration.v1.json',
    schema: 'schemas/contract-migration.v1.schema.json',
    semantic: 'contractMigrationLedger',
  },
  /**
   * package.json ↔ package-lock.json の version 一致（v0.3.0 フォローアップ P1-1）。
   *
   * **`check:stale` ではなくここへ入れた。実測して決めた。**
   * `check:stale` が見るのは `inputDigest` で、`package.json` は入力ではない。
   * だから **package.json の version だけを上げても check:stale は「再実行は不要です」と言う**
   * （複製したリポジトリで 0.3.0 → 0.9.9 に変えて実測。rc=0・出力に一言も出ない）。
   * v0.2.0 で不一致が生まれ、v0.3.0 まで気づかなかったのは、まさにこの経路だった。
   *
   * `validate:profiles` は毎回のテストで走り、release evidence の門にもなっている。
   * **鳴らない場所に置いても意味が無い**ので、鳴る側へ置く。
   *
   * `package.json` を入力に加える案は採らなかった。scripts や依存の範囲指定を直すたびに
   * 全 artifact の digest が動いてしまい、**「中身が変わっていないのに ID が変わる」**を
   * 自分から作ることになる（統合フォローアップ P1-2 で一度直した問題の再発）。
   */
  {
    artifact: 'package.json',
    schema: null,
    semantic: 'packageVersionParity',
  },
  /**
   * 実測記録の正本（v0.6.0 で新設）。
   * **profile の verifiedPhysical はここから機械で決まる**（条文 = docs/VERIFIED_PHYSICAL_GATE.md）。
   * 台帳だけ書き換えて profile を作り直さないと、ここで落ちる。
   */
  {
    artifact: 'docs/measurements/measurement-records.v1.json',
    schema: 'schemas/measurement-record.v1.schema.json',
    semantic: 'measurementRecords',
  },
]

// ---------------------------------------------------------------------------
// semantic 検証 — schema では書けない規則
// ---------------------------------------------------------------------------

const SHA256 = /^[0-9a-f]{64}$/
const HEX40_OR_UNKNOWN = /^([0-9a-f]{40}|UNKNOWN)$/

/**
 * provenance の共通検査。profile と感度 artifact の両方から呼ぶ。
 *
 * `selfMarker` は「生成物自身が入力に混ざっていないか」を見るための語。
 * **向きが artifact ごとに逆になる**ので引数にしてある——
 * profile は感度 artifact を入力として読むので入っていて正しいが、
 * 感度 artifact に自分自身が入っていたら自己参照である。
 */
function checkProvenance(p, selfMarker, errs) {
  if (!p) {
    errs.push('provenance が無い')
    return
  }
  if (!SHA256.test(p.inputDigest)) errs.push(`inputDigest が sha256 の形ではない: ${p.inputDigest}`)
  if (!HEX40_OR_UNKNOWN.test(p.generatedFromCommit))
    errs.push(`generatedFromCommit が 40 桁 hex でも UNKNOWN でもない: ${p.generatedFromCommit}`)

  for (const f of p.inputFiles ?? [])
    if (f.path.includes(selfMarker)) errs.push(`生成物自身が入力に入っている: ${f.path}`)

  // **inputFiles の sha256 が実ファイルと一致するか。**
  // provenance の話は全部これに乗っている。ここが嘘なら inputDigest は無意味で、
  // 受け手の再計算も無意味になる。
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

  /**
   * **inputDigest を実際に作り直して一致するか**（2026-08-03 追加）。
   *
   * これまで digest の**形**（sha256 らしいか）しか見ておらず、
   * 「その値が inputFiles から本当に導けるか」を一度も検査していなかった。
   * inputFiles を正しく記録しても digest が別物なら、受け手の固定は成り立たない。
   */
  const lines = [
    ...Object.entries(p.inputSettings ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `setting  ${k}=${v}`),
    ...(p.inputFiles ?? []).map((f) => `${f.sha256}  ${f.path}`),
  ]
  const recomputed = createHash('sha256').update(lines.join('\n')).digest('hex')
  if (recomputed !== p.inputDigest)
    errs.push(`inputDigest を inputFiles から作り直すと違う値になる (記録 ${p.inputDigest.slice(0, 12)} / 再計算 ${recomputed.slice(0, 12)})`)

  if (p.workingTreeDirty === true && p.artifactKind === 'release')
    errs.push('dirty な入力から release artifact が作られている')
}

const SEMANTIC = {
  /**
   * 実測記録の台帳と、配布 profile の `verifiedPhysical` を突き合わせる。
   *
   * **台帳は inputDigest に入れていない**（条文 第6条）。記録が 0 件のいま入れると
   * 全 artifact の ID が動くためで、代わりに**ここで縛る。**
   * 台帳を書き換えて profile を作り直さなければ、この規則が落ちる。
   */
  measurementRecords(a, errs) {
    if (a.gateDocument !== GATE_DOCUMENT) errs.push(`gateDocument が条文と違う: ${a.gateDocument}`)
    if (a.gateVersion !== GATE_VERSION) errs.push(`gateVersion が実装と違う: ${a.gateVersion} ≠ ${GATE_VERSION}`)

    const ids = new Set()
    for (const r of a.records ?? []) {
      if (ids.has(r.recordId)) errs.push(`recordId が重複している: ${r.recordId}`)
      ids.add(r.recordId)
      if (r.retracted === true && !r.retractedReason) errs.push(`${r.recordId}: 取り下げたのに理由が無い`)
      // **schema では書けない規則。**分解能より細かいばらつきはありえない
      const c = checkRecord(r)
      if (c.rangeMm !== null && r.instrument?.resolutionMm && c.rangeMm > 0 && c.rangeMm < r.instrument.resolutionMm) {
        errs.push(`${r.recordId}: ばらつき ${c.rangeMm} mm が測定器の分解能 ${r.instrument.resolutionMm} mm より小さい`)
      }
    }

    const ledgerRaw = readFileSync(resolve(ROOT, LEDGER_PATH), 'utf8')
    const sha12 = createHash('sha256').update(ledgerRaw).digest('hex').slice(0, 12)

    for (const f of [
      'artifacts/half_plug_topology_profile.v3.trs_jack_trs.json',
      'artifacts/half_plug_topology_profile.v3.trs_jack_trrs.json',
    ]) {
      let p
      try { p = read(f) } catch { continue }
      const ref = p.modelLimitations?.physicalVerificationRef
      if (typeof ref !== 'string') { errs.push(`${f}: physicalVerificationRef が文字列でない`); continue }
      const kv = Object.fromEntries(
        ref.split(' ').map((t) => (t.includes('=') ? [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)] : ['ledger', t])),
      )
      if (kv.ledger !== `${LEDGER_PATH}@sha256:${sha12}`) {
        errs.push(`${f}: physicalVerificationRef の台帳 sha が現在の台帳と違う (${kv.ledger} ≠ ${LEDGER_PATH}@sha256:${sha12})`)
      }
      if (kv.records !== String((a.records ?? []).length)) {
        errs.push(`${f}: physicalVerificationRef の records 件数が台帳と違う (${kv.records} ≠ ${(a.records ?? []).length})`)
      }
      const required = REQUIRED_FOR_PROFILE[p.variantId] ?? []
      if (kv.required !== (required.join(',') || '-')) {
        errs.push(`${f}: physicalVerificationRef の required が条文と違う (${kv.required} ≠ ${required.join(',') || '-'})`)
      }
      // **判定そのものをやり直す。**予測はモデル側なので、ここでは「記録が足りているか」だけ見る
      const gate = evaluateGate({ ledger: a, profileVariantId: p.variantId, predictions: {} })
      const couldBeVerified = gate.verified || gate.rejected.some((r) => r.reasons.some((x) => x.includes('予測が渡されていない')))
      if (p.modelLimitations.verifiedPhysical === true && !couldBeVerified) {
        errs.push(`${f}: verifiedPhysical が true だが、現在の台帳には条件を満たす記録が無い`)
      }
      /**
       * **`false` なのに「足りない理由」がどこにも書いていない状態を作らせない（条文 v2）。**
       * v1 では `missing` だけを見ていたが、v2 は
       * 「記録はあるが一致と矛盾が併存している（`ambiguous`）」「台帳の recordId が重複している（`dupIds`）」でも
       * `false` になる。**そのとき `missing` は空になりうる。**
       */
      const notVerifiedReason = [
        kv.missing !== '-' && 'missing',
        kv.ambiguous && kv.ambiguous !== '-' && 'ambiguous',
        kv.dupIds && kv.dupIds !== '0' && 'dupIds',
      ].filter(Boolean)
      if (p.modelLimitations.verifiedPhysical === false && !notVerifiedReason.length) {
        errs.push(`${f}: verifiedPhysical が false なのに、足りない理由（missing / ambiguous / dupIds）が 1 つも書かれていない`)
      }
      if (p.modelLimitations.verifiedPhysical === true && notVerifiedReason.length) {
        errs.push(`${f}: verifiedPhysical が true なのに ${notVerifiedReason.join(' / ')} が残っている`)
      }
      // **主張の範囲を必ず書かせる（条文 v2 第9条）。**無いと「接点トポロジーを確かめた」と読まれる
      if (kv.scope !== CLAIM_SCOPE) {
        errs.push(`${f}: physicalVerificationRef の scope が条文と違う (${kv.scope} ≠ ${CLAIM_SCOPE})`)
      }
      const verdictSaysTrue = kv.verdict === 'VERIFIED'
      if (verdictSaysTrue !== (p.modelLimitations.verifiedPhysical === true)) {
        errs.push(`${f}: physicalVerificationRef の verdict (${kv.verdict}) が verifiedPhysical=${p.modelLimitations.verifiedPhysical} と噛み合っていない`)
      }
    }
  },

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

    /**
     * --- v2 契約（非阻害フォローアップ P1-5 / P2-6）---
     *
     * **改名を宣言しただけで、実際には改名していない**という食い違いを防ぐ。
     * 移行表は受け手が語彙を対応づける唯一の手がかりなので、
     * ここが嘘だと「表のとおり読んだのに合わない」が起きる。
     */
    const cm = a.contractMigration ?? {}
    const body = JSON.stringify({ intervals: a.intervals, events: a.events })
    for (const r of cm.renamedEnumValues ?? []) {
      // 旧語が本体にまだ残っていたら、改名は完了していない
      if (body.includes(`"${r.from}"`))
        errs.push(`contractMigration が ${r.from} → ${r.to} と宣言しているのに、旧語 "${r.from}" が本体に残っている`)
      if (r.from === r.to) errs.push(`contractMigration の from と to が同じ (${r.from})`)
    }
    if (a.schemaId !== cm.schemaId) errs.push(`schemaId (${a.schemaId}) が contractMigration.schemaId (${cm.schemaId}) と違う`)
    if (cm.toSchemaVersion !== a.schemaVersion)
      errs.push(`contractMigration.toSchemaVersion (${cm.toSchemaVersion}) が schemaVersion (${a.schemaVersion}) と違う`)
    if (cm.breaking === true && cm.fromSchemaVersion === cm.toSchemaVersion)
      errs.push('breaking と宣言しているのに schemaVersion が上がっていない')

    // --- 機械的な完全挿入との差（P2-6.1）---
    const mi = a.mechanicalInsertion ?? {}
    if (mi.completeAtMm !== a.fullInsertionDepthMm)
      errs.push(`mechanicalInsertion.completeAtMm (${mi.completeAtMm}) が fullInsertionDepthMm (${a.fullInsertionDepthMm}) と違う`)
    const firstMatch = (a.intervals ?? []).find(
      (x) => x.electricalTopology?.topologyClass === 'all-expected-functions-match',
    )?.nominalStartMm ?? null
    if (mi.firstAllFunctionsMatchAtMm !== firstMatch)
      errs.push(`mechanicalInsertion.firstAllFunctionsMatchAtMm (${mi.firstAllFunctionsMatchAtMm}) が実際の区間の開始 (${firstMatch}) と違う`)
    if (firstMatch !== null) {
      const gap = +(a.fullInsertionDepthMm - firstMatch).toFixed(4)
      if (Math.abs((mi.gapMm ?? NaN) - gap) > 1e-6)
        errs.push(`mechanicalInsertion.gapMm (${mi.gapMm}) が completeAtMm − firstAllFunctionsMatchAtMm (${gap}) と合わない`)
    } else if (mi.gapMm !== null) {
      errs.push('全機能が揃う区間が無いのに gapMm が null でない')
    }

    // --- normalized の射程（P2-6.2）---
    const cs = a.coordinateSystem ?? {}
    if (cs.crossProfileComparable !== false) errs.push('coordinateSystem.crossProfileComparable が false でない')
    if (cs.normalizedScope !== 'PROFILE_LOCAL') errs.push(`normalizedScope が ${cs.normalizedScope}`)

    // --- provenance ---
    const p = a.provenance
    checkProvenance(p, 'half_plug_topology_profile', errs)
    if (p) {
      if (!HEX40_OR_UNKNOWN.test(a.sourceRevision))
        errs.push(`sourceRevision が 40 桁 hex でも UNKNOWN でもない: ${a.sourceRevision}`)
      // **profileId の末尾は inputDigest の先頭 12 桁でなければならない。**
      // ここがずれると、受け手が digest で固定したつもりで別の profile を見る
      const want = p.inputDigest.slice(0, 12)
      if (!String(a.profileId).endsWith(want))
        errs.push(`profileId の末尾が inputDigest の先頭 12 桁と違う (${a.profileId} / 期待 ...${want})`)
    }

    /**
     * --- 感度の availability（非阻害フォローアップ P1-3）---
     *
     * `available` を 1 つで済ませていたため、TRS×TRRS が spread を 7 件持ちながら
     * `available: false` を名乗り、「感度情報が一切無い」と読まれていた。
     * **2 つの事実が食い違わないこと**をここで守る。
     */
    const ss = a.sensitivitySummary ?? {}
    if (ss.available !== ss.globalSummaryAvailable)
      errs.push(`available (${ss.available}) と globalSummaryAvailable (${ss.globalSummaryAvailable}) が違う。available は global summary の別名でなければならない`)
    if (ss.eventSpreadAvailable !== (ss.eventSpreadSource !== null && ss.eventSpreadSource !== undefined))
      errs.push(`eventSpreadAvailable (${ss.eventSpreadAvailable}) が eventSpreadSource の有無と食い違う`)
    const hasEventSpread = (a.events ?? []).some((e) => e.spreadStatus === 'MODEL_SWEEP_EVENT_SPECIFIC')
    if (hasEventSpread && ss.eventSpreadAvailable !== true)
      errs.push('event に MODEL_SWEEP_EVENT_SPECIFIC の幅があるのに eventSpreadAvailable が true でない')
    if (ss.eventSpreadAvailable === true && ss.basis !== 'MODEL_PARAMETER_SWEEP')
      errs.push(`event spread があるのに basis が ${ss.basis}。実測と誤認されないよう由来を明記する`)

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

  /**
   * 感度 artifact（非阻害フォローアップ P1-2）。
   *
   * この artifact は profile の spreadMm の**元データ**である。
   * ここが壊れていると、profile 側の検査を全部通っても中身が嘘になる。
   */
  sensitivity(a, errs) {
    // --- 走査そのものが成立しているか ---
    const sw = a.sweep ?? {}
    if (sw.shippedInsideSweptRange !== true)
      errs.push('既定値が走査範囲の外にある。**名目値が自分の幅の外に出る** (2026-08-03 に実際に起きた形)')
    if (sw.configurationsUsable > sw.configurationsTried)
      errs.push(`成立 ${sw.configurationsUsable} 構成が走査 ${sw.configurationsTried} 構成を超えている`)
    const accounted = (sw.configurationsUsable ?? 0) + (sw.buildFailed ?? 0) + (sw.fullInsertionNotOk ?? 0)
    if (sw.configurationsTried !== undefined && accounted !== sw.configurationsTried)
      errs.push(`構成の内訳が合わない (成立+組めず+不成立 = ${accounted} ≠ 走査 ${sw.configurationsTried})`)
    if (sw.configurationsTried !== undefined && sw.divisions !== undefined
      && sw.configurationsTried !== (sw.divisions + 1) ** 2)
      errs.push(`configurationsTried が divisions と合わない (${sw.configurationsTried} ≠ (${sw.divisions}+1)^2)`)

    // --- 幅そのものの整合 ---
    for (const [k, v] of Object.entries(a.byKind ?? {})) {
      if (v.minMm > v.maxMm) errs.push(`${k}: minMm ${v.minMm} > maxMm ${v.maxMm}`)
      const moves = +(v.maxMm - v.minMm).toFixed(4)
      if (Math.abs(v.movesMm - moves) > 1e-6)
        errs.push(`${k}: movesMm ${v.movesMm} が maxMm-minMm (${moves}) と合わない`)
    }

    // --- 記録した走査軸が、digest に混ぜた設定と一致するか ---
    const setAxes = a.provenance?.inputSettings?.sweptParameters
    if (setAxes !== undefined && setAxes !== (a.sweptParameters ?? []).join(','))
      errs.push(`sweptParameters (${(a.sweptParameters ?? []).join(',')}) が provenance.inputSettings (${setAxes}) と違う`)
    const setVariant = a.provenance?.inputSettings?.variantId
    if (setVariant !== undefined && setVariant !== a.variantId)
      errs.push(`variantId (${a.variantId}) が provenance.inputSettings (${setVariant}) と違う`)

    // --- provenance。**自分自身を入力にしていないこと** ---
    checkProvenance(a.provenance, 'artifacts/sensitivity', errs)

    /**
     * --- profile との整合 ---
     *
     * これが本題。profile が配っている幅が、本当にこの artifact の値かを突き合わせる。
     * **v0.1.0 ではここが食い違っていた**（3極の幅が 4極 profile に付いていた）が、
     * 突き合わせる検査がどこにも無かったので通ってしまった。
     */
    const slug = String(a.variantId).toLowerCase().replace(/[^a-z0-9]+/g, '_')
    const profilePath = `artifacts/half_plug_topology_profile.v3.${slug}.json`
    if (!existsSync(resolve(ROOT, profilePath))) return
    const prof = read(profilePath)
    if (prof.variantId !== a.variantId)
      errs.push(`${profilePath} の variantId (${prof.variantId}) と違う`)
    const src = prof.sensitivitySummary?.eventSpreadSource
    if (src && src.inputDigest && src.inputDigest !== a.provenance?.inputDigest)
      errs.push(`profile が参照している感度の inputDigest と違う (profile を作り直していない疑い)`)
    for (const e of prof.events ?? []) {
      if (e.spreadStatus !== 'MODEL_SWEEP_EVENT_SPECIFIC' || !e.spreadMm) continue
      const b = a.byKind?.[e.kind]
      if (!b) {
        errs.push(`profile の ${e.eventId} が幅を持つが、byKind に ${e.kind} が無い`)
        continue
      }
      if (e.spreadMm.minMm !== b.minMm || e.spreadMm.maxMm !== b.maxMm)
        errs.push(`profile の ${e.eventId} の幅 ${e.spreadMm.minMm}〜${e.spreadMm.maxMm} が byKind の ${b.minMm}〜${b.maxMm} と違う`)
    }
  },

  /**
   * 入力ファイル一覧（v0.2.0 フォローアップ §2）。
   *
   * **この artifact は「受け手が独立検算するための材料」である。**
   * 件数が中身と食い違っていると、受け手は 0 件を「問題なし」と読んでしまう。
   */
  sourceInputManifest(a, errs) {
    const files = a.inputFiles ?? []
    if (a.inputFilesTotal !== files.length)
      errs.push(`inputFilesTotal ${a.inputFilesTotal} が inputFiles の実数 ${files.length} と違う`)
    const inconsistent = files.filter((x) => !x.consistentAcrossArtifacts).length
    if (a.inconsistentAcrossArtifacts !== inconsistent)
      errs.push(`inconsistentAcrossArtifacts ${a.inconsistentAcrossArtifacts} が実数 ${inconsistent} と違う`)
    const mismatched = files.filter((x) => !x.matchesWorkingTree).length
    if (a.mismatchedWithWorkingTreeAtBuild !== mismatched)
      errs.push(`mismatchedWithWorkingTreeAtBuild ${a.mismatchedWithWorkingTreeAtBuild} が実数 ${mismatched} と違う`)
    for (const x of files) {
      if (Array.isArray(x.recordedSha256) !== !x.consistentAcrossArtifacts)
        errs.push(`${x.path}: consistentAcrossArtifacts と recordedSha256 の形が食い違う`)
      // **記録した sha256 が実ファイルと一致するか。**ここが嘘なら受け手の検算は無意味
      const abs = resolve(ROOT, x.path)
      if (!existsSync(abs) || Array.isArray(x.recordedSha256)) continue
      const actual = sha256File(abs)
      if (x.matchesWorkingTree && actual !== x.recordedSha256)
        errs.push(`${x.path}: matchesWorkingTree が true なのに実ファイルの sha256 と違う`)
      if (x.actualSha256AtBuild !== null && x.actualSha256AtBuild !== actual)
        errs.push(`${x.path}: actualSha256AtBuild が現在の実ファイルと違う`)
    }
  },

  /**
   * 入力の範囲定義（v0.3.0 フォローアップ P1-2）。
   *
   * **この定義が壊れると、生成側と検証側が同時に狂う。**片方だけ直しても気づけないのが
   * 元の問題だったので、1 か所にした代わりに、その 1 か所を強く検査する。
   *
   * いちばん大事なのは最後の突き合わせ——**範囲から導いた集合と、実際に記録された入力が
   * ちょうど一致すること。**ここがずれていたら、範囲定義は飾りになっている。
   */
  /**
   * source snapshot（v0.5.0・オーダー §2）。
   *
   * **schema は「そう書いてある」ことしか見ない。**
   * 写しの中身と記録した sha256 が実際に一致するかは、ここで計算して確かめる。
   * ここを回さないと、**中身が壊れた写しでも `isSelfConsistencyOnly: true` と
   * 書いてあるだけで通ってしまう。**
   */
  /**
   * 対応表の正本（v0.5.1）。
   *
   * **schema は形しか見ない。**キーと中身の一致、版の連番、履歴の並びは意味規則で見る。
   * 記録が schema 実物とずれていないことは test/contractMigration.test.ts が別に見る
   * （こちらは release evidence の門としても回る）。
   */
  contractMigrationLedger(a, errs) {
    const ms = Object.entries(a.migrations ?? {})
    if (ms.length === 0) {
      errs.push('migrations が空。対応表として意味がない')
      return
    }
    for (const [key, m] of ms) {
      if (m.schemaId !== key) errs.push(`キー ${key} と schemaId ${m.schemaId} が違う`)
      if (m.toSchemaVersion !== m.fromSchemaVersion + 1)
        errs.push(`${key}: ${m.fromSchemaVersion} → ${m.toSchemaVersion} が連番でない`)
      // 版を上げたのだから、id の版数も上がっているはず
      const v = (id) => Number(String(id).match(/\.v(\d+)$/)?.[1])
      if (v(m.schemaId) !== m.toSchemaVersion) errs.push(`${key}: schemaId の版数が toSchemaVersion と違う`)
      if (v(m.previousSchemaId) !== m.fromSchemaVersion) errs.push(`${key}: previousSchemaId の版数が fromSchemaVersion と違う`)

      const h = m.history ?? []
      // **古い順に並んでいること。**並んでいないと「いつ壊したか」を辿れない
      const rel = h.map((x) => x.shippedIn)
      const sorted = [...rel].sort()
      if (JSON.stringify(rel) !== JSON.stringify(sorted)) errs.push(`${key}: history が古い順に並んでいない (${rel.join(' ')})`)

      for (const e of h) {
        if (e.versionWasHeld) {
          // 据え置いた回は「本来の版」と「いつ遡って書いたか」を必ず持つ
          if (typeof e.schemaVersionShouldHaveBeen !== 'number')
            errs.push(`${key} ${e.shippedIn}: 据え置いた回に schemaVersionShouldHaveBeen が無い`)
          if (typeof e.recordedRetroactivelyIn !== 'string')
            errs.push(`${key} ${e.shippedIn}: 据え置いた回に recordedRetroactivelyIn が無い`)
          if (e.policyVerdict !== 'BUMP')
            errs.push(`${key} ${e.shippedIn}: 据え置いたのに policyVerdict が ${e.policyVerdict}`)
        }
        if (e.previousRelease >= e.shippedIn)
          errs.push(`${key}: previousRelease ${e.previousRelease} が shippedIn ${e.shippedIn} より後`)
      }
      // 最後の回は「この版で出した」ものであること
      const last = h[h.length - 1]
      if (last && last.schemaVersionAtTheTime !== m.toSchemaVersion)
        errs.push(`${key}: history の最後が toSchemaVersion で終わっていない`)
    }
  },

  sourceSnapshot(a, errs) {
    const files = a.files ?? []
    if (files.length === 0) {
      errs.push('files が 0 件。写しとして意味がない')
      return
    }
    if (files.length !== a.filesTotal) errs.push(`filesTotal ${a.filesTotal} と files の実数 ${files.length} が違う`)

    let mismatched = 0
    for (const f of files) {
      const h = createHash('sha256').update(Buffer.from(f.content, 'utf8')).digest('hex')
      if (h !== f.sha256) {
        mismatched++
        if (mismatched <= 5) errs.push(`写しの中身と sha256 が合わない: ${f.path}`)
      }
      if (f.bytes !== Buffer.byteLength(f.content, 'utf8'))
        errs.push(`bytes が中身の長さと合わない: ${f.path}`)
    }
    if (mismatched > 5) errs.push(`ほかにも ${mismatched - 5} 件、写しと sha256 が合わない`)

    const recorded = files.filter((f) => f.isRecordedInput)
    if (recorded.length !== a.recordedInputsTotal)
      errs.push(`recordedInputsTotal ${a.recordedInputsTotal} と実数 ${recorded.length} が違う`)

    // --- manifest に載っている入力を取りこぼしていないか -------------------
    // ここが抜けると、受け手は inputDigest を再計算できないのに「全部入り」と読む
    const manifestPath = 'artifacts/source-input-manifest.json'
    if (existsSync(resolve(ROOT, manifestPath))) {
      const m = JSON.parse(readFileSync(resolve(ROOT, manifestPath), 'utf8'))
      const have = new Set(files.map((f) => f.path))
      const missing = (m.inputFiles ?? []).map((f) => f.path).filter((p) => !have.has(p))
      if (missing.length > 0) errs.push(`manifest の入力が写しに無い (${missing.length} 件): ${missing.slice(0, 3).join(', ')}`)
      for (const f of m.inputFiles ?? []) {
        const s = files.find((x) => x.path === f.path)
        const rec = Array.isArray(f.recordedSha256) ? f.recordedSha256 : [f.recordedSha256]
        if (s && !rec.includes(s.sha256))
          errs.push(`写しの sha256 が manifest の記録と違う: ${f.path}`)
      }
    }

    // --- 限界の申告が消えていないか ---------------------------------------
    if (a.isSelfConsistencyOnly !== true) errs.push('isSelfConsistencyOnly が true でない。限界の申告を外してはいけない')
    if (a.replacesRecipientVerification !== false) errs.push('replacesRecipientVerification が false でない')
    if (a.isSourceOfTruthForInputDigest !== false) errs.push('isSourceOfTruthForInputDigest が false でない')
  },

  sourceInputScope(a, errs) {
    const required = new Set(a.requiredExactFiles ?? [])

    // --- 範囲定義自身が入力になっていること -------------------------------
    // ここを外すと、範囲を書き換えても digest が変わらない＝定義が効かなくなる
    if (!required.has('source-input-scope.v1.json'))
      errs.push('範囲定義自身が requiredExactFiles に無い。範囲を変えても inputDigest が変わらなくなる')

    // --- generators は requiredExactFiles の射影であること -----------------
    for (const [key, g] of Object.entries(a.generators ?? {})) {
      for (const [what, p] of [['schema', g.schema], ['generator', g.generator]])
        if (!required.has(p)) errs.push(`generators.${key}.${what} (${p}) が requiredExactFiles に無い`)
    }
    for (const p of a.commonInputs ?? [])
      if (!required.has(p)) errs.push(`commonInputs の ${p} が requiredExactFiles に無い`)

    // --- 例外は本当に例外の位置にあるか -----------------------------------
    // allowedGeneratedInputs は excludedOutputs の下にあってこそ「例外」になる。
    // そうでないなら、そもそも除外対象ではないので例外として書く意味がない
    for (const p of a.allowedGeneratedInputs ?? [])
      if (!(a.excludedOutputs ?? []).some((d) => p.startsWith(`${d}/`)))
        errs.push(`allowedGeneratedInputs の ${p} が excludedOutputs のどの接頭辞の下にも無い（例外になっていない）`)

    // --- 実在するか -------------------------------------------------------
    for (const p of required) if (!existsSync(resolve(ROOT, p))) errs.push(`requiredExactFiles の ${p} が存在しない`)
    for (const d of a.recursiveDirectories ?? [])
      if (!existsSync(resolve(ROOT, d))) errs.push(`recursiveDirectories の ${d} が存在しない`)

    // --- **範囲と実際の入力が一致するか（本題）** --------------------------
    const mfPath = 'artifacts/source-input-manifest.json'
    if (!existsSync(resolve(ROOT, mfPath))) return
    const recorded = new Set((read(mfPath).inputFiles ?? []).map((f) => f.path))

    const expected = new Set()
    for (const d of a.recursiveDirectories ?? []) {
      const abs = resolve(ROOT, d)
      if (!existsSync(abs)) continue
      const walk = (rel) => {
        for (const n of readdirSync(resolve(ROOT, rel)).sort()) {
          const r = `${rel}/${n}`
          if (statSync(resolve(ROOT, r)).isDirectory()) walk(r)
          else expected.add(r)
        }
      }
      walk(d)
    }
    for (const p of [...required, ...(a.allowedGeneratedInputs ?? [])])
      if (existsSync(resolve(ROOT, p))) expected.add(p)

    const notRecorded = [...expected].filter((p) => !recorded.has(p)).sort()
    const notInScope = [...recorded].filter((p) => !expected.has(p)).sort()
    if (notRecorded.length)
      errs.push(`範囲内なのに ${mfPath} へ記録されていない入力が ${notRecorded.length} 件: ${notRecorded.join(', ')}`)
    if (notInScope.length)
      errs.push(`${mfPath} に記録されているのに範囲定義の外にある入力が ${notInScope.length} 件: ${notInScope.join(', ')}`)

    // --- 出力を入力にしていないか（自己参照） -----------------------------
    const allowed = new Set(a.allowedGeneratedInputs ?? [])
    const selfRef = [...recorded]
      .filter((p) => (a.excludedOutputs ?? []).some((d) => p.startsWith(`${d}/`)) && !allowed.has(p))
      .sort()
    if (selfRef.length) errs.push(`出力を入力として記録している (自己参照): ${selfRef.join(', ')}`)
  },

  /**
   * package.json ↔ package-lock.json の version 一致（v0.3.0 フォローアップ P1-1）。
   *
   * v0.2.0 で `package.json` だけを 0.2.0 へ上げ、lockfile は 0.1.0 のまま残った。
   * v0.3.0 まで 2 版にわたって気づかなかった。`npm ci` は止まらないので実害は出ないが、
   * SBOM・provenance 表示・release tooling が食い違う版数を見ることになる。
   *
   * **なぜ気づけなかったか。**当時「package.json の version が配布版と揃っている」という名前の
   * テストがあったが、見ていたのは `stageRelease.mjs` の既定値だけで lockfile を参照していなかった。
   * 名前のほうが検査範囲より広く、**その名前を根拠に「守られている」と判断していた。**
   */
  packageVersionParity(a, errs) {
    const lockPath = 'package-lock.json'
    if (!existsSync(resolve(ROOT, lockPath))) {
      errs.push(`${lockPath} が無い`)
      return
    }
    const lock = read(lockPath)
    // **3 か所すべてを見る。**root だけ直して packages[""] を忘れる形が実際にありうる
    const self = lock.packages?.['']
    if (!self) {
      errs.push(`${lockPath} に packages[""] が無い（lockfileVersion ${lock.lockfileVersion}）`)
      return
    }
    for (const [what, got] of [['root の version', lock.version], ['packages[""].version', self.version]])
      if (got !== a.version)
        errs.push(`package.json の version (${a.version}) と ${lockPath} の ${what} (${got}) が違う`)
    if (lock.name !== a.name) errs.push(`package.json の name (${a.name}) と ${lockPath} の name (${lock.name}) が違う`)
  },

  /**
   * 目標トポロジーの頑健性（非阻害フォローアップ P1-4）。
   *
   * この artifact は「どの仮定を動かしても目標が残るか」を主張する。
   * **数え間違いや切り捨てがあると、頑健さを過大にも過小にも見せられる。**
   * 数の内訳と、載せた件数・落とした件数を機械で突き合わせる。
   */
  robustness(a, errs) {
    // --- 構成の数が合うか ---
    const accounted = a.configurationsUsable + a.configurationsBuildFailed + a.configurationsFullInsertionNotOk
    if (accounted !== a.configurationsTotal)
      errs.push(`構成の内訳が合わない (成立+組めず+不成立 = ${accounted} ≠ 走査 ${a.configurationsTotal})`)
    if (a.configurationsWithTarget > a.configurationsUsable)
      errs.push(`目標ありの構成 ${a.configurationsWithTarget} が成立構成 ${a.configurationsUsable} を超えている`)
    const frac = +(a.configurationsWithTarget / a.configurationsUsable).toFixed(6)
    if (Math.abs(a.presenceFractionWithinConstructedSweep - frac) > 1e-6)
      errs.push(`presenceFraction が件数と合わない (${a.presenceFractionWithinConstructedSweep} ≠ ${frac})`)

    // --- 軸の記録 ---
    const axisNames = Object.keys(a.parameterRanges ?? {})
    if (JSON.stringify([...(a.sweptParameters ?? [])].sort()) !== JSON.stringify([...axisNames].sort()))
      errs.push('sweptParameters と parameterRanges のキーが一致しない')
    for (const [name, r] of Object.entries(a.parameterRanges ?? {})) {
      // **既定値が水準に無いと「無改造で成立するか」を一度も評価しないまま報告してしまう**
      if (!r.levels.includes(r.shipped))
        errs.push(`${name}: 既定値 ${r.shipped} が水準 ${r.levels.join('/')} に入っていない`)
      if (r.compound !== (r.keys.length > 1))
        errs.push(`${name}: compound (${r.compound}) が keys の本数 ${r.keys.length} と食い違う`)
    }

    // --- 水準ごとの内訳が総数と合うか ---
    for (const [name, levels] of Object.entries(a.presenceByLevel ?? {})) {
      const range = a.parameterRanges?.[name]
      if (!range) {
        errs.push(`presenceByLevel に parameterRanges の無い軸 ${name} がある`)
        continue
      }
      if (JSON.stringify(levels.map((x) => x.level)) !== JSON.stringify(range.levels))
        errs.push(`${name}: presenceByLevel の水準が parameterRanges と違う`)
      const sumUsable = levels.reduce((s, x) => s + x.configurationsUsable, 0)
      if (sumUsable !== a.configurationsUsable)
        errs.push(`${name}: 水準ごとの成立数の合計 ${sumUsable} が全体 ${a.configurationsUsable} と違う`)
      const sumHit = levels.reduce((s, x) => s + x.configurationsWithTarget, 0)
      if (sumHit !== a.configurationsWithTarget)
        errs.push(`${name}: 水準ごとの目標ありの合計 ${sumHit} が全体 ${a.configurationsWithTarget} と違う`)
      for (const x of levels)
        if (x.configurationsWithTarget > x.configurationsUsable)
          errs.push(`${name} の水準 ${x.level}: 目標あり ${x.configurationsWithTarget} が成立 ${x.configurationsUsable} を超えている`)
    }

    // --- 区間幅 ---
    const w = a.intervalWidthMm ?? {}
    if (a.configurationsWithTarget === 0) {
      if (w.min !== null || w.median !== null || w.max !== null)
        errs.push('目標が 0 件なのに区間幅が入っている')
    } else {
      if (w.min === null || w.median === null || w.max === null)
        errs.push('目標があるのに区間幅が null')
      else if (!(w.min <= w.median && w.median <= w.max))
        errs.push(`区間幅の順序が壊れている (${w.min} / ${w.median} / ${w.max})`)
    }

    /**
     * --- necessaryConditions が内訳と矛盾しないか ---
     *
     * **「その水準では一度も現れない」と書いたなら、内訳もそうなっているはず。**
     * ここを見ないと、書き手の主張と数字が食い違ったまま公開できてしまう。
     */
    for (const c of a.necessaryConditions ?? []) {
      const levels = a.presenceByLevel?.[c.parameter]
      if (!levels) {
        errs.push(`necessaryConditions の軸 ${c.parameter} が presenceByLevel に無い`)
        continue
      }
      for (const lv of c.levelsWhereTargetNeverAppears) {
        const row = levels.find((x) => x.level === lv)
        if (!row) errs.push(`${c.parameter}: 水準 ${lv} が presenceByLevel に無い`)
        else if (row.configurationsWithTarget !== 0)
          errs.push(`${c.parameter}: 水準 ${lv} を「一度も現れない」としているが、内訳では ${row.configurationsWithTarget} 件現れている`)
      }
    }
    // 逆向き。内訳が 0 件なのに条件として書かれていない軸は取りこぼし
    for (const [name, levels] of Object.entries(a.presenceByLevel ?? {}))
      for (const x of levels)
        if (x.configurationsUsable > 0 && x.configurationsWithTarget === 0) {
          const listed = (a.necessaryConditions ?? []).some(
            (c) => c.parameter === name && c.levelsWhereTargetNeverAppears.includes(x.level),
          )
          if (!listed) errs.push(`${name} の水準 ${x.level} は目標が 0 件なのに necessaryConditions に無い`)
        }

    // --- 反対証拠を落としていないか ---
    const real = (a.counterExamples ?? []).filter((c) => c.kind === 'REAL_PART_DRAWING')
    if (!real.length)
      errs.push('実在部品の図面による反対証拠 (REAL_PART_DRAWING) が 1 件も無い。構成した仮定より重い証拠を落としてはならない')
    const s = a.counterExampleSampling ?? {}
    if (s.absentConfigurationsTotal !== a.configurationsUsable - a.configurationsWithTarget)
      errs.push(`目標なしの構成数 ${s.absentConfigurationsTotal} が 成立-目標あり (${a.configurationsUsable - a.configurationsWithTarget}) と違う`)
    if (s.modelSweepSamplesListed + s.omitted !== s.absentConfigurationsTotal)
      errs.push(`載せた ${s.modelSweepSamplesListed} + 落とした ${s.omitted} が 目標なし総数 ${s.absentConfigurationsTotal} と合わない`)
    const listedSweep = (a.counterExamples ?? []).filter((c) => c.kind === 'MODEL_SWEEP_ABSENT').length
    if (listedSweep !== s.modelSweepSamplesListed)
      errs.push(`counterExamples に載っている走査例 ${listedSweep} 件が modelSweepSamplesListed ${s.modelSweepSamplesListed} と違う`)
    for (const c of a.counterExamples ?? [])
      if (c.targetPresent === true) errs.push(`${c.label}: 反対証拠なのに targetPresent が true`)

    // --- 主張の境界 ---
    if (a.physicalProbabilityClaim !== false) errs.push('physicalProbabilityClaim が false でない')
    if (a.empiricalEvidence !== null) {
      // 実測を入れるなら profile の verifiedPhysical も動くはず。片方だけ動かせない
      const prof = existsSync(resolve(ROOT, 'artifacts/half_plug_topology_profile.v3.trs_jack_trrs.json'))
        ? read('artifacts/half_plug_topology_profile.v3.trs_jack_trrs.json')
        : null
      if (prof && prof.modelLimitations?.verifiedPhysical === false)
        errs.push('empiricalEvidence が入っているのに profile の verifiedPhysical が false のまま')
    }

    /**
     * --- 窓の端点（v0.2.0 フォローアップ §4）---
     *
     * v1 では `toMm` が最後に当たった標本位置なのに「終わり」と読める名前だった。
     * profile の区間終端と 1 刻み分ずれて見え、**同じ語で 2 つの違う量を指していた。**
     */
    // **本番の検証と fixture の実演が同じ関数を呼ぶ**（scripts/robustnessWindows.mjs）。
    // 別々に書くと、fixture が落ちても本番が落ちるとは限らなくなる
    errs.push(...checkWindowInvariants(a))

    /**
     * **無改造の窓は profile の区間そのものでなければならない。**
     * ここがずれていたら、頑健性 artifact は別のモデルの話をしている。
     * v1 では `toMm` と `nominalEndMm` が 1 刻みずれていて、突き合わせようがなかった。
     */
    const rprof = existsSync(resolve(ROOT, 'artifacts/half_plug_topology_profile.v3.trs_jack_trrs.json'))
      ? read('artifacts/half_plug_topology_profile.v3.trs_jack_trrs.json')
      : null
    const nomW = a.nominalConfiguration?.windows?.[0]
    if (rprof && nomW) {
      const iv = (rprof.intervals ?? []).find((x) => x.electricalTopology?.topologyClass === a.targetTopologyClass)
      if (!iv) errs.push(`profile に ${a.targetTopologyClass} の区間が無いのに無改造の窓がある`)
      else {
        if (Math.abs(nomW.startMm - iv.nominalStartMm) > 1e-6)
          errs.push(`無改造の startMm ${nomW.startMm} が profile の ${iv.intervalId} の開始 ${iv.nominalStartMm} と違う`)
        if (Math.abs(nomW.endExclusiveMm - iv.nominalEndMm) > 1e-6)
          errs.push(`無改造の endExclusiveMm ${nomW.endExclusiveMm} が profile の ${iv.intervalId} の終端 ${iv.nominalEndMm} と違う`)
      }
    }

    // --- 移行表（項目名を変えたのに宣言していない、を防ぐ）---
    const rcm = a.contractMigration ?? {}
    if (rcm.toSchemaVersion !== a.schemaVersion)
      errs.push(`contractMigration.toSchemaVersion (${rcm.toSchemaVersion}) が schemaVersion (${a.schemaVersion}) と違う`)
    const rbody = JSON.stringify({ n: a.nominalConfiguration, c: a.counterExamples })
    for (const r of rcm.renamedFields ?? []) {
      if (rbody.includes(`"${r.from}":`))
        errs.push(`contractMigration が ${r.from} → ${r.to} と宣言しているのに、旧項目 "${r.from}" が本体に残っている`)
      if (!rbody.includes(`"${r.to}":`))
        errs.push(`contractMigration が ${r.to} へ改名したと宣言しているのに、本体に "${r.to}" が無い`)
    }

    // --- provenance。**自分自身を入力にしていないこと** ---
    checkProvenance(a.provenance, 'artifacts/topology-robustness', errs)
    const setAxes = a.provenance?.inputSettings?.axes
    if (setAxes !== undefined) {
      const want = axisNames.map((n) => `${n}[${a.parameterRanges[n].levels.join('|')}]`).join(';')
      if (setAxes !== want) errs.push('軸の定義が provenance.inputSettings.axes と違う')
    }
  },
}

// ---------------------------------------------------------------------------

/**
 * 全対象を検証して結果を返す。**CLI と release evidence の両方がここを使う。**
 *
 * 別実装にすると「コマンドは通るのに evidence は古い」がいつか起きる。
 * 判定は 1 か所しか持たない。
 */
export function validateAll() {
  return TARGETS.map((t) => {
    if (!existsSync(resolve(ROOT, t.artifact)))
      return { artifact: t.artifact, schema: t.schema, missing: true, schemaErrors: [], semanticErrors: [] }
    const a = read(t.artifact)
    const schemaErrors = []
    const semanticErrors = []
    // schema が無い対象は意味規則だけ回す（package.json のように、こちらが形を決めていないもの）
    if (t.schema) {
      const v = compile(t.schema)
      if (!v(a))
        for (const e of v.errors) schemaErrors.push(`${e.instancePath || '(root)'}: ${e.keyword} — ${e.message}`)
    }
    SEMANTIC[t.semantic](a, semanticErrors)
    return { artifact: t.artifact, schema: t.schema, missing: false, schemaErrors, semanticErrors }
  })
}

export const TARGET_COUNT = TARGETS.length

function main() {
  const results = validateAll()
  let failed = 0
  for (const r of results) {
    if (r.missing) {
      console.log(`  ✗ ${r.artifact} — 存在しない`)
      failed++
      continue
    }
    const n = r.schemaErrors.length + r.semanticErrors.length
    if (n === 0) {
      console.log(`  ✓ ${r.artifact}`)
      continue
    }
    failed++
    console.log(`  ✗ ${r.artifact} — ${n} 件`)
    for (const [label, errs] of [['schema', r.schemaErrors], ['semantic', r.semanticErrors]]) {
      if (!errs.length) continue
      console.log(`      [${label}] ${errs.length} 件 — ${label === 'schema' ? '形' : '中身'}の問題`)
      for (const e of errs.slice(0, 12)) console.log(`        ${e}`)
      if (errs.length > 12) console.log(`        ... 他 ${errs.length - 12} 件`)
    }
  }
  console.log(
    failed === 0
      ? `\n${TARGETS.length} 件すべてが schema と意味規則の両方に適合しています。`
      : `\n**${failed} / ${TARGETS.length} 件が不適合です。**`,
  )
  process.exit(failed === 0 ? 0 : 1)
}

/**
 * CLI として起動されたときだけ走らせる。
 *
 * **realpath で比べる。**単純なパス比較にすると、symlink 経由で起動したときに
 * 一致せず **`main()` が走らないまま exit 0** になる。
 * 何も検証していないのに成功に見えるのは、このリポジトリが一番嫌う壊れ方である。
 * (2026-08-03、変異試験を symlink 構成で回して実際に踏んだ)
 */
const isCli = (() => {
  try {
    return realpathSync(resolve(process.argv[1] ?? '')) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isCli) main()
