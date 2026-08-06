/**
 * **ふつうの tar 展開を oracle にして、検算器の「見え方」と突き合わせる。**
 *
 * ## なぜ要るか（外部監査 2026-08-06 の 3 件）
 *
 * これまでの試験は**期待値を手で書いていた。**
 * そのため、コードと同じ思い違いを期待値も共有してしまい、
 * 材料が corpus にあっても素通りした。実際にこうなっていた。
 *
 * ```
 * pax-x-path は 2026-08-06 より前から corpus にあった
 *   期待値 : 「PAX ヘッダをファイルとして拾わなければ安全」→ 合格
 *   実態   : ヘッダ名 root/file.txt / PAX path=root/other.txt のとき
 *            検算器は file.txt を検証して OK、ふつうに展開すると root/other.txt ができる
 * ```
 *
 * **材料は正しく、判定基準のほうが間違っていた。**
 *
 * ## この試験の考え方
 *
 * 期待値を書かない。**同じ tar を `tar` コマンドで実際に展開して、できた木と比べる。**
 * 要件はひとつだけ。
 *
 * > 検算器が読めたなら、その各キーは、展開してできた**通常ファイル**として
 * > **同じ中身で**存在しなければならない。存在しない・中身が違うなら不合格。
 * > 止まった（`ARCHIVE_INVALID`）なら、食い違いは起こりえないので合格。
 *
 * 「何を拒むべきか」を人が決めなくてよいのが要点である。
 * **参照実装との差分がそのまま欠陥になる。**
 */
import { execFileSync } from 'node:child_process'
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readArchiveBuffer } from '../scripts/verifyReleaseSourceInputs.mjs'
import { allCases } from './_corruptTar.mjs'

const BLOCK = 512
const tmps: string[] = []
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })))

// --------------------------------------------------------------------------- tar を組む

function header(o: Record<string, unknown>): Buffer {
  const h = Buffer.alloc(BLOCK)
  h.write((o.name as string) ?? '', 0, 100, 'utf8')
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116)
  h.write(((o.size as number) ?? 0).toString(8).padStart(11, '0') + '\0', 124)
  h.write('00000000000\0', 136)
  h.write('        ', 148)
  h.write((o.type as string) ?? '0', 156, 1, 'ascii')
  h.write((o.linkname as string) ?? '', 157, 100, 'utf8')
  h.write('ustar\0', 257); h.write('00', 263)
  h.write((o.prefix as string) ?? '', 345, 155, 'utf8')
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += h[i]
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return h
}

function entry(o: { name: string, data?: string, type?: string, linkname?: string }): Buffer {
  const data = Buffer.from(o.data ?? '')
  const padded = data.length ? Buffer.concat([data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)]) : Buffer.alloc(0)
  return Buffer.concat([header({ ...o, size: data.length }), padded])
}

const tarOf = (...parts: Buffer[]) => Buffer.concat([...parts, Buffer.alloc(BLOCK * 2)])

/** PAX の 1 レコード: `"<全長> <鍵>=<値>\n"`。`<全長>` は自身を含む */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`
  let len = body.length + 1
  for (;;) {
    const s = `${len}${body}`
    if (s.length === len) return Buffer.from(s)
    len = s.length
  }
}

// --------------------------------------------------------------------------- oracle

type Extracted = { path: string, type: 'file' | 'dir' | 'symlink', content?: string }

/** **ふつうの tar で展開して、できた木を列挙する。**これが判定の基準になる */
function extractWithTar(buf: Buffer): { entries: Extracted[], failed: boolean } {
  const dir = mkdtempSync(join(tmpdir(), 'trs-oracle-'))
  tmps.push(dir)
  const out = join(dir, 'out')
  mkdirSync(out)
  writeFileSync(join(dir, 'a.tar'), buf)
  let failed = false
  try {
    execFileSync('tar', ['-xf', join(dir, 'a.tar'), '-C', out], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    failed = true
  }
  const found: Extracted[] = []
  const walk = (rel: string) => {
    for (const n of readdirSync(join(out, rel) || out).sort()) {
      const r = rel ? `${rel}/${n}` : n
      const st = lstatSync(join(out, r))
      if (st.isSymbolicLink()) found.push({ path: r, type: 'symlink', content: readlinkSync(join(out, r)) })
      else if (st.isDirectory()) { found.push({ path: r, type: 'dir' }); walk(r) }
      else found.push({ path: r, type: 'file', content: readFileSync(join(out, r)).toString('utf8') })
    }
  }
  walk('')
  return { entries: found, failed }
}

/**
 * 検算器の view と展開の view を比べ、食い違いの一覧を返す。
 * **止まったときは空**（食い違いは起こりえない）。
 */
function mismatchesOf(buf: Buffer): string[] {
  const r = readArchiveBuffer(buf, { gzip: false })
  if (r.error) return []
  const o = extractWithTar(buf)
  const bad: string[] = []
  for (const [k, v] of r.files!) {
    // 検算器は先頭の 1 階層を剥がすことがあるので、両方の綴りで探す
    const cand = o.entries.filter((e) => e.path === k || e.path.endsWith(`/${k}`))
    const file = cand.find((e) => e.type === 'file')
    if (!file) bad.push(`${k}: 展開結果に通常ファイルとして存在しない（実際は ${cand.map((c) => c.type).join(',') || 'なし'}）`)
    else if (file.content !== v.toString('utf8')) bad.push(`${k}: 中身が違う`)
  }
  bad.push(...omissionsOf(r, o))
  return bad
}

/**
 * **逆向きも見る（v0.6.4・外部監査 P0-B）。**
 *
 * v0.6.3 の差分試験は**片方向**だった——「検算器が返した key が展開木に在るか」しか見ていない。
 * そのため **`typeflag 7` のように「展開されるのに検算器が数えない」欠陥は素通りした。**
 * 実測: この検査を外す変異を入れても、片方向の 48 件は 1 件も落ちなかった。
 *
 * 逆向きの要件はこうである。
 *
 * > 展開してできた通常ファイルは、検算器の `files` か `inventory` のどちらかに
 * > 現れていなければならない。どちらにも無いなら、**検算器から見えていないファイルが
 * > source に混じる**ことになる。止まった（`ARCHIVE_INVALID`）なら合格。
 *
 * `inventory` はリンクやディレクトリも載せるので、**ファイルとして読まない entry を
 * 「見なかったこと」にはしない。**範囲の完全性検査はこちらを母集団にする。
 */
function omissionsOf(
  r: { files?: Map<string, Buffer>, inventory?: { name: string }[] },
  o: { entries: Extracted[], failed: boolean },
): string[] {
  if (o.failed) return []                        // 展開できない archive は比べようがない
  const seen = new Set<string>([
    ...[...(r.files ?? new Map()).keys()],
    ...(r.inventory ?? []).map((e) => e.name),
  ])
  const known = (p: string) => [...seen].some((k) => p === k || p.endsWith(`/${k}`))
  return o.entries
    .filter((e) => e.type === 'file' && !known(e.path))
    .map((e) => `${e.path}: 展開されるのに検算器の一覧に現れない（見えないファイルが source に混じる）`)
}

// --------------------------------------------------------------------------- 試験

describe('tar 展開 oracle ① 検算した view と展開した view が食い違わない', () => {
  it('oracle が動いている（正常な tar で木ができる）', () => {
    const o = extractWithTar(tarOf(entry({ name: 'root/a.txt', data: 'A' })))
    expect(o.failed, 'tar コマンドが使えない').toBe(false)
    expect(o.entries.some((e) => e.path === 'root/a.txt' && e.content === 'A'), '展開できていない').toBe(true)
  })

  /**
   * **v0.6.2 まで食い違っていた 4 つ。**
   * どれも「検算器は OK と言うが、展開すると別のものができる」形である。
   */
  const CASES: [string, () => Buffer][] = [
    ['PAX path 上書き', () => tarOf(
      entry({ name: 'PaxHeaders/f', type: 'x', data: paxRecord('path', 'root/other.txt').toString() }),
      entry({ name: 'root/file.txt', data: 'EXPECTED' }),
    )],
    ['PAX size 上書き', () => tarOf(
      entry({ name: 'PaxHeaders/f', type: 'x', data: paxRecord('size', '4').toString() }),
      entry({ name: 'root/file.txt', data: 'ABCDEFGH' }),
    )],
    ['読み飛ばす entry の別名 path', () => tarOf(
      entry({ name: 'root/file.txt', data: 'FIRST' }),
      entry({ name: 'root/./file.txt', type: '2', linkname: 'target.txt' }),
      entry({ name: 'root/target.txt', data: 'SECOND' }),
    )],
    ['パス末尾の空白', () => tarOf(entry({ name: 'root/file.txt ', data: 'EXPECTED' }))],
    ['同名 symlink', () => tarOf(
      entry({ name: 'root/file.txt', data: 'FIRST' }),
      entry({ name: 'root/file.txt', type: '2', linkname: 'target.txt' }),
      entry({ name: 'root/target.txt', data: 'SECOND' }),
    )],
    ['同じ場所の別の綴り', () => tarOf(
      entry({ name: 'root/file.txt', data: 'FIRST' }),
      entry({ name: 'root/./file.txt', data: 'SECOND' }),
    )],
  ]

  it.each(CASES)('%s', (_label, make) => {
    expect(mismatchesOf(make())).toEqual([])
  })

  it('**この試験が空振りしていない**（食い違う材料を作れば検出する）', () => {
    /**
     * 検出器そのものを試す。**検算器を通さず**、
     * 「読めた view」を人工的に作って比較関数の判定を見る。
     */
    const buf = tarOf(entry({ name: 'root/a.txt', data: 'A' }))
    const o = extractWithTar(buf)
    const fake = new Map([['a.txt', Buffer.from('DIFFERENT')]])
    const bad: string[] = []
    for (const [k, v] of fake) {
      const file = o.entries.find((e) => (e.path === k || e.path.endsWith(`/${k}`)) && e.type === 'file')
      if (!file) bad.push(`${k}: 無い`)
      else if (file.content !== v.toString('utf8')) bad.push(`${k}: 中身が違う`)
    }
    expect(bad, '中身が違うのに検出できていない').toHaveLength(1)
  })

  it('対照 — 正常な tar は食い違わない', () => {
    expect(mismatchesOf(tarOf(
      entry({ name: 'root/a.txt', data: 'A' }),
      entry({ name: 'root/sub/b.txt', data: 'B' }),
    ))).toEqual([])
  })
})

describe('tar 展開 oracle ② 既存の 26 個も、この基準で見る', () => {
  const all = Object.entries(allCases()).flatMap(([kind, list]) => list.map((c) => [kind, c.id, c.tar] as const))

  it('材料が 26 個以上ある（母集団が空でない）', () => {
    expect(all.length).toBeGreaterThanOrEqual(26)
  })

  it.each(all.map(([kind, id]) => [`${kind}/${id}`] as const))('%s', (label) => {
    const found = all.find(([k, i]) => `${k}/${i}` === label)!
    /**
     * **`pax-x-path` と `pax-x-size-override` は、この基準で初めて落ちた。**
     * 手で書いた期待値では「PAX を拾っていないので合格」だった。
     */
    expect(mismatchesOf(found[2] as Buffer)).toEqual([])
  })
})
