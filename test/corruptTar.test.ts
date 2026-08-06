/**
 * **壊れた tar を作る道具そのものを試す。**
 *
 * parser を直す前に、**試験材料が本当に「違うもの」になっていること**を確かめる。
 * ここが空振りしていると、parser の試験は「同じ 1 個を 26 回通した」になる。
 */
import { describe, expect, it } from 'vitest'
import { allCases, buildTar, header, normalTar } from './_corruptTar.mjs'

const cases = allCases()

describe('壊れた tar の生成器 ① 種類ごとに複数個ある', () => {
  it.each(Object.entries(cases))('%s は 4 個以上ある（1 個だけで通さない）', (_k, list) => {
    expect(list.length).toBeGreaterThanOrEqual(4)
  })

  it('id が全部ちがう', () => {
    const ids = Object.values(cases).flat().map((c) => c.id)
    expect(new Set(ids).size, 'id が重複している').toBe(ids.length)
  })

  it('**中身が全部ちがう**（同じ tar を名前だけ変えて並べていない）', () => {
    const hex = Object.values(cases).flat().map((c) => c.tar.toString('hex'))
    expect(new Set(hex).size, '同じ byte 列の材料がある').toBe(hex.length)
  })
})

describe('壊れた tar の生成器 ② checksum の細工が効いている', () => {
  const sumOf = (h: Buffer) => {
    const copy = Buffer.from(h)
    copy.fill(0x20, 148, 156)
    let s = 0
    for (const b of copy) s += b
    return s
  }
  // **制御文字をそのまま正規表現へ書かない**（eslint no-control-regex）。
  // checksum 欄は「8 進数字のあと NUL と空白」なので、数字だけを取る
  const stored = (h: Buffer) => {
    const m = /^[0-7]+/.exec(h.subarray(148, 156).toString('ascii'))
    return m ? parseInt(m[0], 8) : -1
  }

  it('valid は一致し、bad は一致しない（対照つき）', () => {
    const good = header({ name: 'a.txt', size: 0, checksum: 'valid' })
    const bad = header({ name: 'a.txt', size: 0, checksum: 'bad' })
    expect(stored(good), 'valid なのに合っていない').toBe(sumOf(good))
    expect(stored(bad), 'bad なのに合ってしまっている').not.toBe(sumOf(bad))
  })

  it('blank は checksum 欄が空白のまま', () => {
    const h = header({ name: 'a.txt', size: 0, checksum: 'blank' })
    expect(h.subarray(148, 156).toString('ascii')).toBe(' '.repeat(8))
  })
})

describe('壊れた tar の生成器 ③ 正常な tar も作れる（塞ぎすぎの検出に要る）', () => {
  it('正常 tar は 512 の倍数で、終端ブロックを持つ', () => {
    const t = normalTar()
    expect(t.length % 512).toBe(0)
    expect(t.subarray(t.length - 1024).every((b: number) => b === 0), '終端ブロックが無い').toBe(true)
  })

  it('entry を足すと長さが増える（生成器が入力を無視していない）', () => {
    const a = buildTar([{ name: 'x/a.txt', data: 'A' }])
    const b = buildTar([{ name: 'x/a.txt', data: 'A' }, { name: 'x/b.txt', data: 'B' }])
    expect(b.length).toBeGreaterThan(a.length)
  })
})

describe('壊れた tar の生成器 ④ 狙った細工が実際に入っている', () => {
  const flat = Object.values(cases).flat()
  const has = (id: string, needle: string) => {
    const c = flat.find((x) => x.id === id)
    expect(c, `${id} が無い`).toBeTruthy()
    return c!.tar.toString('binary').includes(needle)
  }

  it.each([
    ['trav-dotdot', '../evil.txt'],
    ['trav-absolute', '/etc/passwd'],
    ['link-symlink-escape', '../../../etc/passwd'],
    ['pax-g-global', 'pax_global_header'],
    ['gnu-L-traversal', '../../etc/passwd'],
  ])('%s に "%s" が入っている', (id, needle) => {
    expect(has(id, needle), `${id} に細工が入っていない`).toBe(true)
  })

  it('**正常な tar には細工が入っていない**（対照）', () => {
    const t = normalTar().toString('binary')
    for (const needle of ['../', '/etc/passwd', 'pax_global_header']) {
      expect(t.includes(needle), `正常 tar に ${needle} が混ざっている`).toBe(false)
    }
  })
})
