/**
 * 公開済み asset の無傷検査を、**GitHub を叩かずに**確かめる。
 *
 * ## なぜ注入で試験するか
 *
 * この検査そのものは `gh` を 30 回叩く。CI の毎 push で走らせると、
 * **測っている対象（公開済み asset）は push では変わらない**のに
 * 通信の揺らぎで release の関門が赤くなる。そこで
 * **判定の中身だけを CI で守り、通信は手元の `npm run check:published-assets` で行う。**
 *
 * ## 一番効く試験
 *
 * 「取得に失敗したときに**件数を出さない**」。旧版（`~/.trs_v0616_audit/check753.sh`）は
 * `gh` のタイムアウトで「公開中 0 件 / 一致 0 件 / 対照 0 件」と出していた。
 * これは asset が全部消えたときと**同じ見た目**で、しかも
 * **対照も一緒に 0 になる**ので対照が守ってくれない。2026-08-15 に実際に出た。
 */

import { describe, expect, it } from 'vitest'
import {
  BASELINE_PATH,
  EXIT_MEASUREMENT_FAILED,
  EXIT_MISMATCH,
  EXIT_OK,
  MeasurementFailure,
  compareTags,
  compareToBaseline,
  keyOf,
  main,
  measurePublished,
  mutateOneDigest,
  repoFromRemote,
} from '../scripts/publishedAssetBaseline.mjs'
import type { BaselineIo, PublishedAsset } from '../scripts/publishedAssetBaseline.mjs'

const asset = (tag: string, n: number): PublishedAsset =>
  ({ tag, name: `a${n}.json`, digest: `sha256:${tag}-${n}`.padEnd(20, '0') })

const BASE_TAGS = ['v0.1.0', 'v0.2.0']
const BASE_ASSETS = BASE_TAGS.flatMap((t) => [1, 2, 3].map((n) => asset(t, n)))

/** 基準どおりの世界を返す io。個々の試験が live だけ差し替える */
function io(live: PublishedAsset[], over: Partial<BaselineIo> = {}): BaselineIo {
  const byTag = new Map<string, PublishedAsset[]>()
  for (const a of live) byTag.set(a.tag, [...(byTag.get(a.tag) ?? []), a])
  return {
    listTags: () => JSON.stringify([...byTag.keys()].map((tagName) => ({ tagName }))),
    viewAssets: (_repo: string, tag: string) =>
      JSON.stringify({ assets: (byTag.get(tag) ?? []).map((a) => ({ name: a.name, digest: a.digest })) }),
    remoteUrl: () => 'https://github.com/Driedsandwich/trs-jack-3d.git',
    readFile: () =>
      JSON.stringify({
        schemaVersion: 1,
        schemaId: 'trs-jack-3d-published-assets-baseline.v1',
        purpose: 'test',
        repo: 'Driedsandwich/trs-jack-3d',
        takenAt: '2026-08-15',
        assets: BASE_ASSETS,
      }),
    writeFile: () => {},
    fileExists: () => true,
    now: () => '2026-08-15',
    ...over,
  }
}

const run = (live: PublishedAsset[], over: Partial<BaselineIo> = {}) =>
  main(['--check'], io(live, over), '/nowhere')

/** 件数を名乗っている行があるか。取得に失敗したときは 1 行も出てはいけない */
const namesACount = (lines: string[]) => lines.some((l) => /公開中|件と一致|対照 \d/.test(l))

describe('公開済み asset の無傷検査', () => {
  it('基準の全件がそのまま在れば通る', () => {
    const r = run(BASE_ASSETS)
    expect(r.code).toBe(EXIT_OK)
    expect(r.lines.join('\n')).toContain(`公開中 6 件 / 基準 6 件と一致 6 件 / 対照 5 件`)
  })

  it('基準に無い新しい release は見ない（出すたびに落ちない）', () => {
    const r = run([...BASE_ASSETS, asset('v0.3.0', 1), asset('v0.3.0', 2)])
    expect(r.code).toBe(EXIT_OK)
    expect(r.lines.join('\n')).toContain('公開中 8 件 / 基準 6 件と一致 6 件')
  })

  it('digest が変わったら落ちる', () => {
    const live = BASE_ASSETS.map((a, i) => (i === 2 ? { ...a, digest: `${a.digest}X` } : a))
    const r = run(live)
    expect(r.code).toBe(EXIT_MISMATCH)
    expect(r.lines.join('\n')).toContain('要確認')
    expect(r.lines.join('\n')).toContain(BASE_ASSETS[2].name)
  })

  it('asset が消えたら落ちる', () => {
    const r = run(BASE_ASSETS.filter((_, i) => i !== 4))
    expect(r.code).toBe(EXIT_MISMATCH)
    expect(r.lines.join('\n')).toContain('一致 5 件')
  })

  it('release ごと消えたら落ちる', () => {
    const r = run(BASE_ASSETS.filter((a) => a.tag !== 'v0.2.0'))
    expect(r.code).toBe(EXIT_MISMATCH)
    expect(r.lines.join('\n')).toContain('一致 3 件')
  })

  describe('取得に失敗したら、件数を出さずに止まる', () => {
    it('release の一覧が取れない', () => {
      const r = run(BASE_ASSETS, { listTags: () => { throw new Error('i/o timeout') } })
      expect(r.code).toBe(EXIT_MEASUREMENT_FAILED)
      expect(namesACount(r.lines)).toBe(false)
      expect(r.lines.join('\n')).toContain('測定できていません')
    })

    it('個々の release の asset が取れない', () => {
      const r = run(BASE_ASSETS, { viewAssets: () => { throw new Error('i/o timeout') } })
      expect(r.code).toBe(EXIT_MEASUREMENT_FAILED)
      expect(namesACount(r.lines)).toBe(false)
    })

    it('返ってきたものが JSON でない', () => {
      const r = run(BASE_ASSETS, { listTags: () => 'Bad credentials' })
      expect(r.code).toBe(EXIT_MEASUREMENT_FAILED)
      expect(namesACount(r.lines)).toBe(false)
    })

    it('release が 1 本も返らない', () => {
      const r = run(BASE_ASSETS, { listTags: () => '[]' })
      expect(r.code).toBe(EXIT_MEASUREMENT_FAILED)
      expect(namesACount(r.lines)).toBe(false)
    })

    it('基準そのものが無い', () => {
      const r = run(BASE_ASSETS, { fileExists: () => false })
      expect(r.code).toBe(EXIT_MEASUREMENT_FAILED)
      expect(r.lines.join('\n')).toContain(BASELINE_PATH)
    })

    it('**旧版はここで「0 件」と出していた**——同じ入力で件数が出ないことを固定する', () => {
      const r = run(BASE_ASSETS, { listTags: () => { throw new Error('i/o timeout') } })
      expect(r.lines.join('\n')).not.toContain('0 件')
      expect(r.code).not.toBe(EXIT_OK)
    })
  })

  describe('対照', () => {
    it('基準を 1 件壊すと、ちょうど 1 件だけ一致が減る', () => {
      const intactKeys = new Set(BASE_ASSETS.map(keyOf))
      const m = mutateOneDigest(BASE_ASSETS, intactKeys)
      expect(m.to).not.toBe(m.from)
      expect(keyOf(m.assets[m.index])).not.toBe(keyOf(BASE_ASSETS[m.index]))
      expect(compareToBaseline(BASE_ASSETS, m.assets).intact).toHaveLength(BASE_ASSETS.length - 1)
    })

    it('変異が入らない状況では対照を作らず落とす', () => {
      expect(() => mutateOneDigest(BASE_ASSETS, new Set<string>())).toThrow(/無傷の行が 1 件もありません/)
    })

    it('壊した行まで公開側に在れば「対照が効いていない」として落ちる', () => {
      // 実際には起きないが、対照の関門そのものが生きているかを見る
      const intactKeys = new Set(BASE_ASSETS.map(keyOf))
      const m = mutateOneDigest(BASE_ASSETS, intactKeys)
      const r = run([...BASE_ASSETS, m.assets[m.index]])
      expect(r.code).toBe(EXIT_MISMATCH)
      expect(r.lines.join('\n')).toContain('対照が効いていません')
    })
  })

  describe('部品', () => {
    it('measurePublished は空配列を返さず投げる', () => {
      const bad = io([], { listTags: () => '[]' })
      expect(() => measurePublished(bad, 'x/y')).toThrow(MeasurementFailure)
    })

    it('remote の URL から repo を読む', () => {
      expect(repoFromRemote('https://github.com/Driedsandwich/trs-jack-3d.git')).toBe('Driedsandwich/trs-jack-3d')
      expect(repoFromRemote('git@github.com:Driedsandwich/trs-jack-3d.git')).toBe('Driedsandwich/trs-jack-3d')
      expect(() => repoFromRemote('nonsense')).toThrow()
    })

    it('版は数の列として比べる（文字列だと v0.6.9 > v0.6.10 になる）', () => {
      expect(compareTags('v0.6.9', 'v0.6.10')).toBeLessThan(0)
      expect('v0.6.9' > 'v0.6.10').toBe(true) // 文字列比較だとこうなる、という対照
      expect(compareTags('v0.1.0', 'v0.1.0')).toBe(0)
      expect(['v0.6.10', 'v0.2.0', 'v0.6.9'].sort(compareTags)).toEqual(['v0.2.0', 'v0.6.9', 'v0.6.10'])
    })

    it('鍵は tag / 名前 / digest のどれが変わっても別物になる', () => {
      const a = asset('v0.1.0', 1)
      expect(keyOf({ ...a, tag: 'v0.1.1' })).not.toBe(keyOf(a))
      expect(keyOf({ ...a, name: 'b.json' })).not.toBe(keyOf(a))
      expect(keyOf({ ...a, digest: 'sha256:zzz' })).not.toBe(keyOf(a))
    })
  })
})
