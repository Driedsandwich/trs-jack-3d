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
  pax: 'safe',        // **中身を拾わないだけでは足りない。**意味を変える鍵があれば止める（下の個別指定）
  longName: 'safe',   // 正常な GNU long name は通る。危険なものだけ止まる
  checksum: 'invalid',
  traversal: 'invalid',
  link: 'safe',       // リンクは読み飛ばす。止める必要は無い
  resource: 'invalid',
}

/**
 * **種類ごとの既定より個別 id を優先する。**
 *
 * ## この表そのものが 2026-08-06 まで間違っていた
 *
 * `pax-x-path` と `pax-x-size-override` は**最初から材料としてあった**のに、
 * 期待値が `pax: 'safe'`（＝「PAX ヘッダをファイルとして拾わなければよい」）だった。
 * その基準では通ってしまう——**拾わないことと、上書き指示を無視してよいことは別**である。
 *
 * ```
 * ヘッダ名 root/file.txt ／ PAX path=root/other.txt
 *   検算器 : file.txt を検証して OK        ← 「拾っていない」ので当時の基準では合格
 *   実展開 : root/other.txt ができる       ← 検算した名前は存在しない
 * ```
 *
 * **材料は正しく、判定基準のほうが間違っていた。**
 * 手で書いた期待値は、コードと同じ思い違いを共有しうる。
 * だから `test/tarExtractionOracle.test.ts` で、
 * **期待値を手で書かずにふつうの tar 展開から作る**検査を別に置いた。
 */
const EXPECTED_BY_ID: Record<string, 'invalid' | 'safe'> = {
  // 'pax-x-path' は **safe**。v0.6.3 で `path=` を解釈するようにしたので、展開結果と一致する
  'pax-x-size-override': 'invalid',  // size 上書き → 読む長さが食い違う
  'gnu-L-very-long': 'invalid',
  'gnu-L-traversal': 'invalid',
  'gnu-L-size-lie': 'invalid',
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

      const want = EXPECTED_BY_ID[c.id] ?? EXPECTED[kind]
      if (want === 'invalid') {
        expect(r.error, `${c.id}: 止まっていない`).toBeTruthy()
        expect(r.kind).toBe('ARCHIVE_INVALID')
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

  /**
   * **この試験は 2026-08-06 まで空振りしていた。**
   *
   * `buildTar` へ 807 文字の名前を渡していたが、**素の USTAR header の name 欄は 100 バイト**しかない。
   * 実際に組まれた tar のパスは 100 文字へ切り詰められ、しかも末尾が `a/` になっていた——
   * つまり「上限 1024 のすぐ内側」ではなく「100 文字の壊れたパス」を試していた。
   *
   * v0.6.2 で末尾スラッシュを拒むようにしたら、この材料が引っかかって発覚した。
   * **長いパスは GNU long name (`L`) を通さないと表現できない**（`res-long-path` と同じ落とし穴）。
   */
  it('**上限のすぐ内側は通る**（境界を 1 方向でしか試さない状態にしない）', () => {
    const long = `x/${'a/'.repeat(400)}f.txt`
    expect(long.length, '材料が上限の内側でない').toBeLessThan(TAR_LIMITS.maxPathLength)
    expect(long.length, '材料が短すぎて境界を試せていない').toBeGreaterThan(700)
    const near = buildTar([
      { name: '././@LongLink', type: 'L', data: `${long}\0` },
      { name: 'ignored-because-longlink', data: 'x' },
    ])
    const r = read(near)
    expect(r.error, 'パス長の上限内なのに止まった').toBeFalsy()
    /**
     * **材料が本当にその長さで届いているか。**切り詰められていたらここで落ちる。
     * 先頭の `x/` は `stripTopLevel` が剥がす（GitHub の tarball と同じ扱い。単一の親だから）。
     */
    expect([...r.files!.keys()]).toEqual([long.slice('x/'.length)])
    expect([...r.files!.keys()][0].length, '100 文字へ切り詰められている').toBeGreaterThan(700)
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

/**
 * **v0.6.2（外部監査 2026-08-06 の P0-2）。**
 *
 * v0.6.1 は「文字列として同じパスか」だけを見ていた。
 * そのため**検算が見た中身と、ふつうに展開してできる中身が食い違う** archive が `OK` で通った。
 * checksum を通す意味そのものが無くなるので、これは P0 である。
 *
 * ここでの oracle は**ふつうの tar 展開**である。「展開したらどうなるか」と
 * 「検算は何を見たか」がずれたら不合格、という基準で試験する。
 */
describe('tar 強化 ⑥ v0.6.2 — 同じ場所を指す別の綴り', () => {
  const hdr = (name: string, size: number, type = '0', link = '') => {
    const b = Buffer.alloc(512)
    b.write(name, 0, 100, 'utf8')
    b.write('0000644\0', 100); b.write('0000000\0', 108); b.write('0000000\0', 116)
    b.write(size.toString(8).padStart(11, '0') + '\0', 124)
    b.write('00000000000\0', 136)
    b.write('        ', 148)
    b.write(type, 156)
    if (link) b.write(link, 157, 100, 'utf8')
    b.write('ustar\0', 257); b.write('00', 263)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += b[i]
    b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    return b
  }
  const entry = (n: string, c: string, t = '0', l = '') => {
    const d = Buffer.from(c)
    const isLink = t === '2' || t === '1'
    return Buffer.concat([
      hdr(n, isLink ? 0 : d.length, t, l),
      isLink ? Buffer.alloc(0) : d,
      isLink ? Buffer.alloc(0) : Buffer.alloc((512 - (d.length % 512)) % 512),
    ])
  }
  const tarOf = (...es: Buffer[]) => Buffer.concat([...es, Buffer.alloc(1024)])

  it('**`root/./file.txt` は止まる**（v0.6.1 は別ファイルとして受理していた）', () => {
    const r = read(tarOf(entry('root/file.txt', 'FIRST'), entry('root/./file.txt', 'SECOND')))
    expect(r.error, '同じ場所の別の綴りを受理している').toBeTruthy()
    expect(r.kind).toBe('ARCHIVE_INVALID')
    // **v0.6.1 の挙動を名指しで固定する。**両方拾って返す形に戻ったらここで落ちる
    expect(r.files, '中身を返してしまっている').toBeUndefined()
  })

  it('`//` と末尾の `/` も止まる', () => {
    for (const bad of ['root//file.txt', 'root/file.txt/']) {
      const r = read(tarOf(entry(bad, 'X')))
      expect(r.kind, bad).toBe('ARCHIVE_INVALID')
    }
  })

  it('制御文字を含むパスは止まる', () => {
    const r = read(tarOf(entry(`root/${String.fromCharCode(1)}file.txt`, 'X')))
    expect(r.kind).toBe('ARCHIVE_INVALID')
    expect(r.error).toContain('制御文字')
  })

  it('**通常ファイルと同名の symlink は止まる**（v0.6.1 はリンクを無視して OK を返した）', () => {
    const r = read(tarOf(
      entry('root/file.txt', 'FIRST'),
      entry('root/file.txt', '', '2', 'target.txt'),
      entry('root/target.txt', 'SECOND'),
    ))
    expect(r.error, 'リンクを無視した結果、展開結果と食い違う').toBeTruthy()
    expect(r.kind).toBe('ARCHIVE_INVALID')
    expect(r.files).toBeUndefined()
  })

  it('hardlink・ディレクトリでも同じパスの衝突は止まる', () => {
    for (const t of ['1', '5']) {
      const r = read(tarOf(entry('root/x.txt', 'FIRST'), entry('root/x.txt', '', t, 'other.txt')))
      expect(r.kind, `typeflag ${t}`).toBe('ARCHIVE_INVALID')
    }
  })

  it('対照 — 衝突していないリンクとディレクトリは、これまでどおり読み飛ばすだけ', () => {
    const r = read(tarOf(
      entry('root/dir/', '', '5'),
      entry('root/dir/a.txt', 'A'),
      entry('root/link.txt', '', '2', 'a.txt'),
      entry('root/b.txt', 'B'),
    ))
    expect(r.error, `塞ぎすぎている: ${r.error}`).toBeFalsy()
    expect([...r.files!.keys()].sort()).toEqual(['b.txt', 'dir/a.txt'])
  })

  it('対照 — 実物の GitHub tarball は正規化検査を通る（ディレクトリ entry を含む）', () => {
    const cached = '/tmp/src.tar.gz'
    if (!existsSync(cached)) return
    const r = read(readFileSync(cached), true)
    expect(r.error, `実物が止まった: ${r.error}`).toBeFalsy()
    expect(r.files!.size).toBe(246)
  })
})
