/**
 * **自己申告 artifact（`source-verification-result.v1`）が表現できる status（v0.6.12）。**
 *
 * ## なぜ切り出したか
 *
 * v0.6.11 まで、この境界は 2 か所にあった——`schemas/source-verification-result.v1.schema.json`
 * の `status.enum` と、`buildReleaseEvidence.mjs` に手書きされた `STATUS_EXPRESSIBLE_IN_V1`。
 * **試験は 2 つ目をソースの正規表現で拾って比べていた。**書き方を変えれば拾えなくなるし、
 * 「止まる経路が在ること」も `process.exit(1)` という文字列を grep しているだけだった。
 *
 * **enum を正本にし、関門は投げる関数にした。**投げるなら試験が実際に踏める。
 * 生成器はそれを受けて exit する（**丸めない**——「archive が壊れていた」を
 * 「取れなかった」に化けさせると、受け手が読み分けられなくなる）。
 *
 * **これは CLI の一覧（`CLI_STATUSES`）とは別の境界である。**
 * あちらは「道具が何を返すか」、こちらは「この artifact の schema が何を書けるか」。
 * v0.6.11 時点で 3 個ずれている（`ARCHIVE_INVALID` / `ARCHIVE_UNSUPPORTED` /
 * `VERIFICATION_INCOMPLETE`）。**ずれを消すには schema を v2 へ上げることになり、下流が止まる。**
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SCHEMA = 'schemas/source-verification-result.v1.schema.json'

/** schema の enum をそのまま返す。**別に並べない** */
export function expressibleStatuses(root = process.cwd()) {
  return JSON.parse(readFileSync(resolve(root, SCHEMA), 'utf8')).properties.status.enum
}

/**
 * 表現できない status なら投げる。生成器はこれを捕まえて止まる。
 * **戻り値で可否を返さない**——呼び手が見落とすと、丸めた値が出荷される。
 */
export function assertExpressibleInSelfReport(status, root = process.cwd()) {
  const allowed = expressibleStatuses(root)
  if (allowed.includes(status)) return status
  throw new Error(
    `検算ツールが status=${status} を返したが、source-verification-result.v1 はこの値を表現できない。\n`
    + '    **別の値へ丸めて出さない。**schema を v2 へ上げるか（＝下流が止まる。要判断）、\n'
    + '    archive のほうを直してから作り直すこと。',
  )
}
