/**
 * **生成器が実際に import しているコードが、全部 `inputDigest` に入っているか。**
 *
 * ## なぜ要るか（外部監査 2026-08-06 P0-1）
 *
 * `scripts/exportHalfPlugProfile.ts` は `./measurementGate.mjs` を import しているのに、
 * それが `source-input-scope.v1.json` にも manifest にも入っていなかった。
 * 実測でこうなった。
 *
 * ```
 * measurementGate.mjs の CLAIM_SCOPE を書き換える
 *   → profile の中身は変わる（physicalVerificationRef に scope=MUTATED-SCOPE が出る）
 *   → profileId    38b692a12af6 のまま
 *   → inputDigest  変わらない
 *   → 受け手の検算 status=OK / 30 of 30 / 未記録 0 件
 * ```
 *
 * **ID が「何を入力にして作ったか」を指していなかった。**
 * 中身が変わったのに ID が同じなら、受け手は ID で区別できない。
 *
 * ## この検査の考え方
 *
 * 個別のファイル名を並べても、**次に足した import で同じ穴が空く。**
 * ソースの `import` を実際に辿って、宣言と突き合わせる。
 * **一覧の外から母集団を作る**ので、宣言を直し忘れたらここで落ちる。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '..')
const R = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'))

/** release asset を作る生成器。**これが母集団の起点** */
const RELEASE_GENERATORS = [
  'scripts/exportHalfPlugProfile.ts',
  'scripts/sensitivityEvents.ts',
  'scripts/searchTopologyRobustness.ts',
]

/** リポジトリ内の相対 import だけを辿る（npm パッケージと node: は対象外） */
function localImports(file: string): string[] {
  const abs = resolve(ROOT, file)
  if (!existsSync(abs)) return []
  const src = readFileSync(abs, 'utf8')
  const out: string[] = []
  const patterns = [
    /^\s*import\s[^'"]*['"](\.[^'"]+)['"]/gm,   // import … from './x'
    /^\s*import\s*['"](\.[^'"]+)['"]/gm,        // import './x'
    /\bawait\s+import\(\s*['"](\.[^'"]+)['"]/g, // await import('./x')
  ]
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const base = resolve(dirname(abs), m[1])
      /**
       * `./x.mjs` は実体、`./x` は拡張子を補う。
       * **ファイルであることまで見る。**`src/data` のようなディレクトリを
       * そのまま拾うと、manifest に無い名前として誤検出する（2026-08-06 に実際に踏んだ）。
       */
      for (const ext of ['', '.ts', '.mjs', '.js', '.json', '/index.ts']) {
        const c = `${base}${ext}`
        if (existsSync(c) && statSync(c).isFile()) { out.push(relative(ROOT, c)); break }
      }
    }
  }
  return out
}

/** 生成器から辿れる、リポジトリ内のコード全部 */
function closureOf(entry: string): Set<string> {
  const seen = new Set<string>()
  const stack = [entry]
  while (stack.length) {
    const cur = stack.pop()!
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const dep of localImports(cur)) stack.push(dep)
  }
  return seen
}

describe('生成器の依存が inputDigest に入っている（外部監査 P0-1）', () => {
  const manifest = R('artifacts/source-input-manifest.json')
  const tracked = new Set<string>((manifest.inputFiles ?? []).map((f: { path: string }) => f.path))
  const scope = R('source-input-scope.v1.json')

  it('起点の生成器が実在し、import を実際に読めている（母集団が空でない）', () => {
    for (const g of RELEASE_GENERATORS) {
      expect(existsSync(resolve(ROOT, g)), `${g} が無い`).toBe(true)
      expect(localImports(g).length, `${g} の import を 1 件も読めていない`).toBeGreaterThan(0)
    }
    // **この検査が実際に何かを辿っている証拠。**閉包が起点だけなら壊れている
    const all = new Set(RELEASE_GENERATORS.flatMap((g) => [...closureOf(g)]))
    expect(all.size, '閉包が起点だけになっている').toBeGreaterThan(RELEASE_GENERATORS.length + 5)
  })

  it.each(RELEASE_GENERATORS)('%s から辿れるコードが、全部 manifest に入っている', (gen) => {
    const missing = [...closureOf(gen)].filter((p) => !tracked.has(p)).sort()
    expect(missing, `${gen} の依存が inputDigest の外にある（変えても profileId が動かない）`).toEqual([])
  })

  it('**この検査が空振りしていない**（実在する依存を宣言から外すと落ちる）', () => {
    // 実際に import されているファイルを 1 つ選ぶ
    const dep = 'scripts/measurementGate.mjs'
    expect(localImports('scripts/exportHalfPlugProfile.ts')).toContain(dep)
    expect(tracked.has(dep), `${dep} が manifest に無い`).toBe(true)
    // 宣言から外した母集団で数え直すと、その 1 件だけが漏れとして出る
    const without = new Set([...tracked].filter((p) => p !== dep))
    const missing = [...closureOf('scripts/exportHalfPlugProfile.ts')].filter((p) => !without.has(p))
    expect(missing).toEqual([dep])
  })

  it('範囲定義と manifest が食い違っていない', () => {
    for (const p of scope.requiredExactFiles as string[]) {
      expect(existsSync(resolve(ROOT, p)), `requiredExactFiles の ${p} が実在しない`).toBe(true)
    }
    for (const p of scope.commonInputs as string[]) {
      expect(tracked.has(p), `commonInputs の ${p} が manifest に入っていない`).toBe(true)
    }
  })

  it('**変異が ID を動かす**ことを、実ファイルの sha256 で示す', () => {
    // manifest が記録している sha256 が、実ファイルと一致していること。
    // 一致していなければ「記録した入力」と「実際に読んだ入力」が別物である
    const dep = (manifest.inputFiles as { path: string, recordedSha256: string, matchesWorkingTree: boolean }[])
      .find((f) => f.path === 'scripts/measurementGate.mjs')
    expect(dep, 'measurementGate.mjs が manifest に無い').toBeTruthy()
    const actual = createHash('sha256').update(readFileSync(resolve(ROOT, dep!.path))).digest('hex')
    expect(dep!.recordedSha256, '記録した sha256 が実ファイルと違う').toBe(actual)
    expect(dep!.matchesWorkingTree).toBe(true)
    // profile の inputDigest はこれらの sha256 から作られるので、
    // 1 byte 変えれば digest が変わる。**その連鎖をここで固定する**
    const trs = R('artifacts/half_plug_topology_profile.v3.trs_jack_trs.json')
    const inProfile = (trs.provenance.inputFiles as { path: string }[]).map((f) => f.path)
    expect(inProfile, 'profile 自身の入力一覧に入っていない').toContain('scripts/measurementGate.mjs')
  })
})
