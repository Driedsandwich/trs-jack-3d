/**
 * **どの止まり方をしても、出力が自分の公開契約に収まるか（v0.6.16・外部監査 2026-08-14 P0-2）。**
 *
 * ## なぜ要るか
 *
 * v0.6.15 は `stableReasonCode` の enum を 80 種類へ狭めておきながら、
 * **名前を付け忘れた経路が `${status}_OTHER` を出し続けていた。**
 * 外部監査の反例をこちらで再現した（2026-08-14・公開した道具そのもの）:
 *
 * ```
 * --source も --tag も渡さない   SOURCE_UNAVAILABLE / SOURCE_UNAVAILABLE_OTHER → schema 不適合
 * GitHub 取得中に fetch が失敗   同じ                                          → schema 不適合
 * ```
 *
 * **道具が、自分で配った schema に反する出力を出していた。**
 *
 * v0.6.15 の到達性試験がこれを見逃したのは、**route の母集団を手で並べていた**からである。
 * 「この run で出なかった」は「出ない」の証拠にならない——
 * **その経路を踏む試験を書いていなければ、当然出ない。**
 *
 * ## この試験の考え方
 *
 * route の表は `test/_cliRoutes.mjs` に 1 つだけ置き、
 * **到達性の照合と同じ表を使う**（別に持つと、また 2 つ目の一覧になる）。
 * network や PATH の差し替えに頼らず、`--import` で `globalThis.fetch` を差し替える
 * ——**道具は 1 バイトも変えない。**
 * 出力は毎回 ajv で公開 schema に掛ける——status と code だけ見て満足しない。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Ajv from 'ajv'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CLI_RESULT_SCHEMA_PATH, CLI_STATUS_EXIT, INTERNAL_CONTRACT_FAILURE_MARKER,
  INTERNAL_FAILURE_EXIT, REASON_CODES,
} from '../scripts/verifyReleaseSourceInputs.mjs'
import { injectedRoutes } from './_cliRoutes.mjs'
import { mustBeNonEmpty } from './_must'

const ROOT = resolve(__dirname, '..')
const SCHEMA = JSON.parse(readFileSync(resolve(ROOT, CLI_RESULT_SCHEMA_PATH), 'utf8'))
const validate = new Ajv({ allErrors: true, strict: false }).compile(SCHEMA)

const tmps: string[] = []
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })))

export function runRoute(route: { args: string[], preload?: string, env?: Record<string, string> }) {
  const argv = [...(route.preload ? ['--import', route.preload] : []), 'scripts/verifyReleaseSourceInputs.mjs', ...route.args]
  try {
    const out = execFileSync('node', argv, {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ...route.env },
    })
    return { code: 0, json: JSON.parse(out) as Record<string, unknown> }
  } catch (e) {
    const err = e as { status?: number, stdout?: string }
    let json: Record<string, unknown> = {}
    try { json = JSON.parse(String(err.stdout ?? '{}')) } catch { /* JSON が出ない経路もある */ }
    return { code: err.status ?? -1, json }
  }
}

describe('CLI 結果は、どの止まり方でも公開契約に収まる', () => {
  const observed: string[] = []
  const ROUTES = injectedRoutes(tmps)

  it.each(ROUTES.map((r) => [r.label, r.code, r] as const))(
    '%s → %s（schema 適合まで）',
    (_label, want, route) => {
      const r = runRoute(route)
      expect(r.json.stableReasonCode, `期待した名前が出ていない（実際: ${String(r.json.stableReasonCode)}）`).toBe(want)
      /** **status と code だけで満足しない。**配った schema に通るところまで見る */
      expect(validate(r.json), JSON.stringify(validate.errors?.slice(0, 3))).toBe(true)
      /** catalog が宣言する status と、実際の status が一致する */
      expect(REASON_CODES[want as keyof typeof REASON_CODES].status).toBe(r.json.status)
      /** 終了コードも表どおり */
      expect(r.code).toBe(CLI_STATUS_EXIT[r.json.status as keyof typeof CLI_STATUS_EXIT])
      observed.push(want)
    },
  )

  it('**この試験が空振りしていない**（表のすべての経路を実際に踏んでいる）', () => {
    expect(mustBeNonEmpty(observed, '踏んだ経路').length).toBe(ROUTES.length)
    expect(new Set(observed).size, '同じ経路を数えている').toBe(ROUTES.length)
    expect(ROUTES.length, '表が痩せている').toBeGreaterThanOrEqual(6)
  })

  /**
   * **道具の欠陥は、検証の結果と混ぜない（v0.6.16）。**
   * 例外のまま落とすと Node は exit 1 で終わり、**`MISMATCH` と見分けが付かない。**
   * 3 はどの status の終了コードとも重ならない。
   */
  it('**道具の欠陥用の終了コードが、status のどれとも重ならない**', () => {
    expect(Object.values(CLI_STATUS_EXIT)).not.toContain(INTERNAL_FAILURE_EXIT)
    expect(INTERNAL_FAILURE_EXIT).toBe(3)
  })
})
