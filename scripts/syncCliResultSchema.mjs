/**
 * **配布 schema のうち、道具から決まる部分を生成する（v0.6.16・外部監査 P0-2 / P1-A）。**
 *
 *   node scripts/syncCliResultSchema.mjs          # 書き換える
 *   node scripts/syncCliResultSchema.mjs --check  # ずれていたら落ちる
 *
 * ## なぜ要るか
 *
 * v0.6.15 で schema を狭めたとき、`stableReasonCode.enum` は catalog から作ったが、
 * **`reasonCodeFamilies` と `notMachineReadableHere` の enum は手で貼った。**
 * v0.6.16 で `usage` 族の code を 1 つ足したら、**道具の出力が自分の schema に落ちた**
 * ——`OK` の正常な出力までもが不適合になった（2026-08-14 実測・6 経路すべて）。
 *
 * **同じ境界を 2 か所で持つと、片方だけ動く。**ここを唯一の作り方にする。
 * 試験（`test/reasonCodeCatalog.test.ts`）が `--check` 相当を毎 run 回すので、
 * 生成し忘れたまま配ることはできない。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ARCHIVE_POLICY, REASON_CODES, TAR_LIMITS } from './verifyReleaseSourceInputs.mjs'

const ROOT = process.cwd()
export const CLI_RESULT_SCHEMA_PATH = 'schemas/source-verifier-cli-result.v1.schema.json'

/** 道具から決まる部分だけを差し替えた schema を返す（元の説明文は保つ） */
export function syncedSchema(root = ROOT) {
  const s = JSON.parse(readFileSync(resolve(root, CLI_RESULT_SCHEMA_PATH), 'utf8'))
  const ap = s.properties.archivePolicy.properties
  const cov = ARCHIVE_POLICY.coverage

  s.properties.stableReasonCode.enum = [...Object.keys(REASON_CODES).sort(), null]
  ap.policyId.const = ARCHIVE_POLICY.policyId
  ap.acceptedTypeflags.items.enum = [...ARCHIVE_POLICY.acceptedTypeflags]
  ap.acceptedHeaderFormats.items.enum = [...ARCHIVE_POLICY.acceptedHeaderFormats]
  ap.endOfArchiveConvention.const = ARCHIVE_POLICY.endOfArchiveConvention
  ap.limits.required = Object.keys(TAR_LIMITS)
  ap.limits.properties = Object.fromEntries(Object.keys(TAR_LIMITS).map((k) => [k, { type: 'integer', minimum: 1 }]))
  ap.coverage.properties.machineReadable.items.enum = [...cov.machineReadable]
  ap.coverage.properties.notMachineReadableHere.items.enum = [...cov.notMachineReadableHere]
  ap.coverage.properties.reasonCodeFamilies.items.enum = [...cov.reasonCodeFamilies]
  /** v0.6.14 の名前。値は coverage から導出しているので、enum も同じものを使う */
  ap.notMachineReadableHere.items.enum = [...cov.notMachineReadableHere]
  ap.reasonCodeFamilies.items.enum = [...cov.reasonCodeFamilies]
  return s
}

const text = (o) => JSON.stringify(o, null, 2) + '\n'

if (resolve(process.argv[1] ?? '') === resolve(import.meta.filename)) {
  const want = text(syncedSchema())
  const have = readFileSync(resolve(ROOT, CLI_RESULT_SCHEMA_PATH), 'utf8')
  if (process.argv.includes('--check')) {
    if (want === have) {
      console.log(`  ${CLI_RESULT_SCHEMA_PATH} は道具と一致しています。`)
      process.exit(0)
    }
    console.log(`**${CLI_RESULT_SCHEMA_PATH} が道具とずれています。**`)
    console.log('  node scripts/syncCliResultSchema.mjs で作り直すこと。')
    process.exit(1)
  }
  writeFileSync(resolve(ROOT, CLI_RESULT_SCHEMA_PATH), want)
  console.log(`  ${CLI_RESULT_SCHEMA_PATH} を道具から作り直した`
    + `（code ${Object.keys(REASON_CODES).length} 種類 / 族 ${ARCHIVE_POLICY.coverage.reasonCodeFamilies.length} 種類）`)
}
