/**
 * **信頼できない archive に対して parser が止まることを、実物の壊れた tar で試す。**
 *
 * 材料は `test/_corruptTar.mjs`（26 個・6 種類）。
 * **変異は parser の外側から入れる。**parser の中の定数をいじると、
 * 「その定数を読んでいること」しか確かめられない。
 *
 * **塞ぎすぎていないことも同じファイルで見る。**正常な tar と実物の GitHub tarball が
 * 通らなくなったら、この強化は失敗である。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { TAR_LIMITS, readArchiveBuffer } from '../scripts/verifyReleaseSourceInputs.mjs'
import { allCases, buildTar, normalTar } from './_corruptTar.mjs'

const cases = allCases()
const read = (buf: Buffer, gzip = false) => readArchiveBuffer(buf, { gzip })

/** 期待する結末。`invalid` = 止まる ／ `safe` = 読めるが危険な entry を含まない */
const EXPECTED: Record<string, 'invalid' | 'safe'> = {
  pax: 'safe',        // 拾わなければよい。止める必要は無い
  longName: 'safe',   // 正常な GNU long name は通る。危険なものだけ止まる
  checksum: 'invalid',
  traversal: 'invalid',
  link: 'safe',       // リンクは読み飛ばす。止める必要は無い
  resource: 'invalid',
}

describe('tar 強化 ① 26 個すべてについて、どうなるかを実測する', () => {
  const table: { id: string, kind: string, outcome: string, files: number }[] = []

  it.each(Object.entries(cases).flatMap(([k, list]) => list.map((c) => [k, c.id] as const)))(
    '%s / %s',
    (kind, id) => {
      const c = cases[kind].find((x) => x.id === id)!
      const r = read(c.tar)
      const outcome = r.error ? 'ARCHIVE_INVALID' : 'READ'
      table.push({ id: c.id, kind, outcome, files: r.files ? r.files.size : 0 })

      if (EXPECTED[kind] === 'invalid') {
        expect(r.error, `${c.id}: 止まっていない`).toBeTruthy()
        expect(r.kind).toBe('ARCHIVE_INVALID')
      } else if (['gnu-L-very-long', 'gnu-L-traversal', 'gnu-L-size-lie'].includes(c.id)) {
        // 同じ種類でも、危険なものは止まる
        expect(r.error, `${c.id}: 止まっていない`).toBeTruthy()
      } else {
        // 止まらない場合でも、**危険な名前が Map に入っていないこと**が要件
        expect(r.error, `${c.id}: 止まってしまった（塞ぎすぎ）`).toBeFalsy()
        for (const name of r.files!.keys()) {
          expect(name.split('/').includes('..'), `${c.id}: .. が残っている (${name})`).toBe(false)
          expect(name.startsWith('/'), `${c.id}: 絶対パスが残っている (${name})`).toBe(false)
        }
      }
    },
  )

  it('一覧を出す（何がどう止まったかを記録に残す）', () => {
    expect(table.length, '前の it が走っていない').toBeGreaterThanOrEqual(26)
    const lines = table.map((t) => `  ${t.kind.padEnd(10)} ${t.id.padEnd(26)} ${t.outcome.padEnd(16)} files=${t.files}`)
    console.log(`\n26 個の実測\n${lines.join('\n')}`)
  })
})

describe('tar 強化 ② 種類ごとに「なぜ止まったか」まで見る', () => {
  const find = (id: string) => Object.values(cases).flat().find((c) => c.id === id)!

  it.each([
    ['cksum-bad-first', 'checksum'],
    ['cksum-blank', 'checksum'],
    ['trav-dotdot', '..'],
    ['trav-absolute', '絶対パス'],
    ['trav-backslash', 'バックスラッシュ'],
    ['res-many-entries', 'entry が多すぎる'],
    ['res-huge-entry', 'entry が大きすぎる'],
    ['res-long-path', 'パスが長すぎる'],
  ])('%s は「%s」で止まる', (id, needle) => {
    const r = read(find(id).tar)
    expect(r.error, `${id}: 止まっていない`).toBeTruthy()
    expect(r.error, `${id}: 鳴った理由が違う`).toContain(needle)
  })

  it('PAX の中身をファイルとして拾わない', () => {
    for (const c of cases.pax) {
      const r = read(c.tar)
      if (r.error) continue
      for (const name of r.files!.keys()) {
        expect(name, `${c.id}: PAX ヘッダを拾っている`).not.toMatch(/PaxHeaders|pax_global_header/)
      }
    }
  })

  it('symlink と hardlink をファイルとして拾わない', () => {
    for (const c of cases.link) {
      const r = read(c.tar)
      expect(r.error, `${c.id}: 止まってしまった`).toBeFalsy()
      expect([...r.files!.keys()].some((n) => n.includes('link')), `${c.id}: リンクを拾っている`).toBe(false)
    }
  })
})

describe('tar 強化 ③ 塞ぎすぎていない', () => {
  it('正常な tar は通る（対照）', () => {
    const r = read(normalTar())
    expect(r.error).toBeFalsy()
    expect([...r.files!.keys()].sort()).toEqual(['a.txt', 'src/b.txt'])
  })

  it('gzip をかけても通る', () => {
    const r = read(gzipSync(normalTar()), true)
    expect(r.error).toBeFalsy()
    expect(r.files!.size).toBe(2)
  })

  it('**上限のすぐ内側は通る**（境界を 1 方向でしか試さない状態にしない）', () => {
    const near = buildTar([{ name: `x/${'a/'.repeat(400)}f.txt`, data: 'x' }])
    const r = read(near)
    expect(r.error, 'パス長の上限内なのに止まった').toBeFalsy()
  })

  it('**実物の GitHub tarball（v0.5.2）が通り、entry 数が実測と合う**', () => {
    const cached = '/tmp/src.tar.gz'
    let gz: Buffer
    if (existsSync(cached)) gz = readFileSync(cached)
    else {
      try {
        gz = execFileSync('curl', ['-sL', 'https://github.com/Driedsandwich/trs-jack-3d/archive/refs/tags/v0.5.2.tar.gz'],
          { maxBuffer: 1 << 28 })
      } catch {
        console.log('  実物の tarball を取れないので飛ばす（network 無し）')
        return
      }
    }
    const r = read(gz, true)
    expect(r.error, `実物が止まった: ${r.error}`).toBeFalsy()
    // 2026-08-06 実測: ファイル 246 / ディレクトリ 21 / pax global 1
    expect(r.files!.size, '実物の件数が変わっている').toBe(246)
    expect(r.files!.has('package.json'), '先頭階層が剥がれていない').toBe(true)
  })
})

describe('tar 強化 ④ 上限の値が実測に基づいている', () => {
  it('上限は実測（entry 268 / 最大 1.33 MB / 最長パス 95 / tar 15.09 MB）より広い', () => {
    expect(TAR_LIMITS.maxEntries).toBeGreaterThan(268)
    expect(TAR_LIMITS.maxEntryBytes).toBeGreaterThan(1_331_055)
    expect(TAR_LIMITS.maxPathLength).toBeGreaterThan(95)
    expect(TAR_LIMITS.maxTotalBytes).toBeGreaterThan(15_093_760)
  })

  it('**無限に広くはない**（上限が意味を持っている）', () => {
    expect(TAR_LIMITS.maxEntries).toBeLessThan(268 * 100)
    expect(TAR_LIMITS.maxEntryBytes).toBeLessThan(1_331_055 * 100)
    expect(TAR_LIMITS.maxPathLength).toBeLessThan(95 * 100)
  })
})
