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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { TAR_LIMITS, readArchiveBuffer } from '../scripts/verifyReleaseSourceInputs.mjs'
import { allCases, buildTar, normalTar } from './_corruptTar.mjs'

const ROOT = resolve(__dirname, '..')
const VERIFIER = 'scripts/verifyReleaseSourceInputs.mjs'

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

/**
 * **v0.6.1（外部監査 2026-08-06 の P1 3 件）。**
 *
 * どれも「壊れた tar」ではなく **v0.6.0 が黙って受理していた入力**である。
 * 26 個の材料は v0.6.0 の穴を突く形で作ったので、**同じ材料では出てこない**
 * （範囲の内側だけ叩く変異は範囲の狭さを暴けない）。
 */
describe('tar 強化 ⑤ v0.6.1 — 重複 entry・symlink ループ・圧縮入力の上限', () => {
  /** USTAR header を組む。`test/_corruptTar.mjs` と同じ組み方 */
  const hdr = (name: string, size: number, type = '0') => {
    const b = Buffer.alloc(512)
    b.write(name, 0, 100, 'utf8')
    b.write('0000644\0', 100); b.write('0000000\0', 108); b.write('0000000\0', 116)
    b.write(size.toString(8).padStart(11, '0') + '\0', 124)
    b.write('00000000000\0', 136)
    b.write('        ', 148)
    b.write(type, 156)
    b.write('ustar\0', 257); b.write('00', 263)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += b[i]
    b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    return b
  }
  const entry = (name: string, content: string) => {
    const data = Buffer.from(content)
    return Buffer.concat([hdr(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512)])
  }
  const tarOf = (...es: Buffer[]) => Buffer.concat([...es, Buffer.alloc(1024)])

  it('**同じパスの entry が 2 回あったら止まる**（v0.6.0 は後の中身が黙って勝った）', () => {
    const r = read(tarOf(entry('root/dup.txt', 'FIRST'), entry('root/dup.txt', 'SECOND')))
    expect(r.error, '重複を受理している').toBeTruthy()
    expect(r.kind).toBe('ARCHIVE_INVALID')
    expect(r.error).toContain('2 回')
    // **v0.6.0 の挙動を名指しで固定する。**後勝ちに戻ったらここで落ちる
    expect(r.files, '中身を返してしまっている').toBeUndefined()
  })

  it('中身が同じでも重複は拒む（同じ内容なら許す、にしない）', () => {
    const r = read(tarOf(entry('root/same.txt', 'X'), entry('root/same.txt', 'X')))
    expect(r.kind).toBe('ARCHIVE_INVALID')
  })

  it('対照 — 重複していなければ、これまでどおり読める', () => {
    const r = read(tarOf(entry('root/a.txt', 'A'), entry('root/b.txt', 'B')))
    expect(r.error, `塞ぎすぎている: ${r.error}`).toBeFalsy()
    expect(r.files!.size).toBe(2)
    expect(r.files!.get('a.txt')!.toString()).toBe('A')
    // 材料の組み方そのものが壊れていないこと
    expect(read(normalTar()).error).toBeFalsy()
  })

  it('圧縮された入力そのものに上限がある（展開後だけではない）', () => {
    expect(TAR_LIMITS.maxCompressedBytes).toBeGreaterThan(9_760_000)   // 実物 9.76 MB より広い
    expect(TAR_LIMITS.maxCompressedBytes).toBeLessThan(9_760_000 * 50) // **無限に広くはない**
    // 展開後の上限とは別の値である（片方だけ効いている状態にしない）
    expect(TAR_LIMITS.maxCompressedBytes).toBeLessThan(TAR_LIMITS.maxTotalBytes)
  })

  it('CLI がディレクトリの symlink ループで構造化 JSON を返す（生の例外で落ちない）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trs-loop-'))
    try {
      mkdirSync(join(dir, 'root'))
      writeFileSync(join(dir, 'root', 'a.txt'), 'x')
      symlinkSync('.', join(dir, 'root', 'loop'))
      let out = ''
      let code = 0
      try {
        out = execFileSync('node', [VERIFIER, '--manifest', 'artifacts/source-input-manifest.json', '--source', dir],
          { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 })
      } catch (e) {
        const err = e as { stdout?: string, status?: number }
        out = err.stdout ?? ''
        code = err.status ?? 0
      }
      // **JSON で返ること**が本題。status は入力が揃っていないので MISMATCH でよい
      const j = JSON.parse(out)
      expect(j.toolVersion, '構造化出力になっていない').toBeGreaterThanOrEqual(6)
      expect(typeof j.status).toBe('string')
      expect(code, '止まらずに 0 で返している').not.toBe(0)
      // symlink は追わずに読み飛ばしたことを出力に残す
      expect(String(j.origin)).toContain('symlink')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('対照 — ループが無ければ symlink の注記は出ない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trs-noloop-'))
    try {
      mkdirSync(join(dir, 'root'))
      writeFileSync(join(dir, 'root', 'a.txt'), 'x')
      let out = ''
      try {
        out = execFileSync('node', [VERIFIER, '--manifest', 'artifacts/source-input-manifest.json', '--source', dir],
          { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 })
      } catch (e) {
        out = (e as { stdout?: string }).stdout ?? ''
      }
      expect(String(JSON.parse(out).origin)).not.toContain('symlink')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
