/**
 * **公開済み release asset が、公開したときのまま在るかを見る。**
 *
 *   node scripts/publishedAssetBaseline.mjs           # 基準を取り直す（増やすだけ）
 *   node scripts/publishedAssetBaseline.mjs --check   # 基準と食い違ったら落ちる
 *
 * ## なぜ repo へ入れたか
 *
 * この検査は v0.6.16 から毎版やっていたが、**道具が repo の外にあった**
 * （`~/.trs_v0615/assets.sh` と `~/.trs_v0616_audit/check753.sh`）。
 * release notes には毎回「過去 N 件が byte 一致」と書いていたのに、
 * **受け手はそれを再現できなかった。**結果だけ配って手段を配らないのは、
 * この repo が他のところでやっていることと矛盾する。
 *
 * ## 件数をどこにも書かない
 *
 * 旧版は `base_753.tsv` と「753」という直書きの数の**両方**を持っていて、
 * 版が上がるたびに人が数を書き換えていた（663 → 693 → 723 → 753）。
 * 書き換え忘れれば、**検査は緑のまま守る範囲だけが古くなる。**
 * ここでは件数も対象 tag も**基準ファイルから数える。**版が上がっても直す所は無い。
 *
 * ## 対照を別ファイルで持たない
 *
 * 旧版は `base_753_broken.tsv`（1 文字だけ違う写し）を並べて置いていた。
 * **同じ境界を 2 つの一覧で持つ**形で、片方だけ古くなっても誰も気づかない。
 * ここでは対照を**その場で基準から作り**、変異が入ったことを毎回確かめる。
 *
 * ## 「取れなかった」と「消えた」を混ぜない
 *
 * 旧版は `for t in $(gh release list …)` の形だった。`gh` が失敗すると
 * **語リストが空になり loop が一度も回らず**、「asset が全部消えた」と
 * 同じ出力（0 件）になる。`set -e` も効かない。2026-08-15 に実際に出た。
 * ここでは取得に失敗したら**件数を出さず** `EXIT_MEASUREMENT_FAILED` で止める。
 *
 * ## 終了コード
 *
 *   0  基準の全件が公開時のまま在る
 *   1  基準の行が消えたか digest が変わった（＝要確認）
 *   2  **測れていない**（取得の失敗。asset の状態については何も言えない）
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

export const BASELINE_PATH = 'test/fixtures/published-assets-baseline.v1.json'

export const EXIT_OK = 0
export const EXIT_MISMATCH = 1
export const EXIT_MEASUREMENT_FAILED = 2

/** 取得そのものができなかったとき。**件数を出してはいけない**合図 */
export class MeasurementFailure extends Error {}

/** 1 件を一意にする鍵。3 つのどれが変わっても別物になる */
export const keyOf = (a) => `${a.tag}\t${a.name}\t${a.digest}`

/**
 * 基準の各行が、いま公開されているものの中にそのまま在るか。
 *
 * 基準に無い tag（＝基準を取ったあとに出した release）は**見ない。**
 * そうしないと release を出すたびにこの検査が落ち、
 * 「落ちたら基準を取り直す」が習慣になって検査の意味が消える。
 */
export function compareToBaseline(live, baselineAssets) {
  const liveKeys = new Set(live.map(keyOf))
  const intact = []
  const changed = []
  for (const a of baselineAssets) (liveKeys.has(keyOf(a)) ? intact : changed).push(a)
  return { intact, changed }
}

/**
 * 対照。基準の 1 件だけ digest を変えた写しを作る。
 *
 * **変異が入ったことをここで証明する。**入らなかった変異と
 * 素通りした変異は出力が同じなので、後から見分けられない。
 * 対象は「いま無傷の行」から選ぶ——既に壊れている行を変えても件数は動かない。
 */
export function mutateOneDigest(baselineAssets, intactKeys) {
  const targets = baselineAssets
    .map((a, i) => [a, i])
    .filter(([a]) => intactKeys.has(keyOf(a)))
  if (!targets.length) throw new Error('対照を作れません: 無傷の行が 1 件もありません')

  const [orig, index] = targets[Math.floor(targets.length / 2)]
  const mutated = { ...orig, digest: `${orig.digest}X` }
  if (keyOf(mutated) === keyOf(orig)) throw new Error('対照の変異が入っていません')

  const assets = baselineAssets.slice()
  assets[index] = mutated
  return { assets, index, from: orig.digest, to: mutated.digest }
}

/**
 * 版の順。`gh` は新しい順に返すので、そのまま書くと基準が `v0.6.20〜v0.1.0` になる。
 * 文字列比較だと `v0.6.9 > v0.6.10` になるので、数の列として比べる
 * （この repo は v0.6.9 → v0.6.10 の並びで一度これに当たっている）。
 */
export function compareTags(a, b) {
  const parts = (t) => t.replace(/^v/, '').split('.').map(Number)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  }
  return 0
}

/** `https://github.com/owner/name.git` → `owner/name` */
export function repoFromRemote(url) {
  const m = String(url).trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)
  if (!m) throw new Error(`remote の URL から repo を読めません: ${url}`)
  return m[1]
}

export function defaultIo() {
  const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return {
    listTags: (repo) => gh(['release', 'list', '--repo', repo, '--limit', '100', '--json', 'tagName']),
    viewAssets: (repo, tag) => gh(['release', 'view', tag, '--repo', repo, '--json', 'assets']),
    remoteUrl: () => execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }),
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, s) => writeFileSync(p, s),
    fileExists: (p) => existsSync(p),
    now: () => process.env.ARTIFACT_DATE ?? new Date().toISOString().slice(0, 10),
  }
}

/**
 * いま公開されている asset を全部数える。
 *
 * **どこで失敗しても `MeasurementFailure` を投げる。**呼び出し側が
 * 空配列を「0 件」として受け取れる経路を作らないため。
 */
export function measurePublished(io, repo) {
  let tags
  try {
    tags = JSON.parse(io.listTags(repo)).map((r) => r.tagName)
  } catch (e) {
    throw new MeasurementFailure(`release の一覧を取れません: ${e.message}`)
  }
  if (!Array.isArray(tags) || tags.length === 0) {
    throw new MeasurementFailure('release が 1 本も返りませんでした')
  }

  const live = []
  for (const tag of tags) {
    let assets
    try {
      assets = JSON.parse(io.viewAssets(repo, tag)).assets
    } catch (e) {
      throw new MeasurementFailure(`${tag} の asset を取れません: ${e.message}`)
    }
    for (const a of assets) live.push({ tag, name: a.name, digest: a.digest })
  }
  return live
}

const readBaseline = (io, root) => JSON.parse(io.readFile(resolve(root, BASELINE_PATH)))

export function main(args = [], io = defaultIo(), root = process.cwd()) {
  const lines = []
  const say = (s) => lines.push(s)
  const path = resolve(root, BASELINE_PATH)
  const hasBaseline = io.fileExists(path)

  const baseline = hasBaseline ? readBaseline(io, root) : null
  let repo
  try {
    repo = baseline?.repo ?? repoFromRemote(io.remoteUrl())
  } catch (e) {
    say(`  → **測定できていません**（${e.message}）`)
    return { code: EXIT_MEASUREMENT_FAILED, lines }
  }

  let live
  try {
    live = measurePublished(io, repo)
  } catch (e) {
    if (!(e instanceof MeasurementFailure)) throw e
    say(`  **${e.message}**`)
    say('  → **測定できていません**（asset の状態については何も言えません）')
    return { code: EXIT_MEASUREMENT_FAILED, lines }
  }

  if (!hasBaseline) {
    if (args.includes('--check')) {
      say(`  → **測定できていません**（基準がありません: ${BASELINE_PATH}）`)
      return { code: EXIT_MEASUREMENT_FAILED, lines }
    }
    return { code: EXIT_OK, lines, write: buildBaseline(io, repo, live), live }
  }

  const { intact, changed } = compareToBaseline(live, baseline.assets)
  const intactKeys = new Set(intact.map(keyOf))

  // 対照は基準の側を 1 件壊して作る。件数がちょうど 1 減らなければ、
  // この検査は「壊れていても気づかない」状態にある
  let control = null
  if (intact.length) {
    const m = mutateOneDigest(baseline.assets, intactKeys)
    control = { count: compareToBaseline(live, m.assets).intact.length, expected: intact.length - 1 }
  }

  const tags = [...new Set(baseline.assets.map((a) => a.tag))]
  say(`  基準 ${BASELINE_PATH}（${baseline.takenAt} / ${tags.length} tag: ${tags[0]}〜${tags[tags.length - 1]}）`)
  say(`  公開中 ${live.length} 件 / 基準 ${baseline.assets.length} 件と一致 ${intact.length} 件`
    + (control ? ` / 対照 ${control.count} 件` : ' / 対照なし'))

  if (changed.length) {
    say('  → **要確認: 基準の行が消えたか digest が変わっています**')
    for (const a of changed.slice(0, 5)) say(`      ${a.tag}  ${a.name}`)
    if (changed.length > 5) say(`      … 他 ${changed.length - 5} 件`)
    return { code: EXIT_MISMATCH, lines }
  }
  if (control && control.count !== control.expected) {
    say(`  → **要確認: 対照が効いていません**（${control.expected} 件になるはずが ${control.count} 件）`)
    return { code: EXIT_MISMATCH, lines }
  }
  say('  → 過去の asset はすべて無傷（対照も効いている）')

  if (args.includes('--check')) return { code: EXIT_OK, lines }
  return { code: EXIT_OK, lines, write: buildBaseline(io, repo, live), live }
}

function buildBaseline(io, repo, live) {
  return {
    schemaVersion: 1,
    schemaId: 'trs-jack-3d-published-assets-baseline.v1',
    purpose:
      '**公開済み release asset が、公開したときのまま在ることを確かめるための基準。**'
      + '件数も対象 tag もこのファイルから数える——道具の側に数を書くと、'
      + '版が上がったとき書き換え忘れて「守る範囲だけが古い」状態になる。',
    repo,
    takenAt: io.now(),
    assets: live.slice().sort((a, b) => compareTags(a.tag, b.tag) || a.name.localeCompare(b.name)),
  }
}

if (resolve(process.argv[1] ?? '') === resolve(import.meta.filename)) {
  const r = main(process.argv.slice(2))
  for (const l of r.lines) console.log(l)

  if (r.write) {
    // 取り直しは**増やすだけ**。基準の行が 1 つでも欠けていたら上書きしない——
    // 壊れた状態を基準として焼き付けてしまうと、以後それが「正しい」になる
    if (r.code !== EXIT_OK) {
      console.log('  基準は上書きしていません（いまの状態が基準と食い違っています）')
      process.exit(r.code)
    }
    const io = defaultIo()
    io.writeFile(resolve(process.cwd(), BASELINE_PATH), JSON.stringify(r.write, null, 1) + '\n')
    const tags = [...new Set(r.live.map((a) => a.tag))]
    console.log(`  ${BASELINE_PATH} に ${r.live.length} 件（${tags.length} tag）を記録しました。`)
  }
  process.exit(r.code)
}
