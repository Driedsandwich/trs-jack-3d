/**
 * **CI が read-only であることを、機械で固定する。**（v0.6.0 P2）
 *
 * 目で見て「書き込み権は無いはず」で運用すると、
 * 1 行足したときに気づけない。**足したら落ちる形にする。**
 *
 * 変異は workflow の文字列を外から書き換えて入れる。
 * 検査の中の定数をいじると、その定数を読んでいることしか確かめられない。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mustBeNonEmpty } from './_must'

const ROOT = resolve(__dirname, '..')
const PATH = '.github/workflows/ci.yml'
const SRC = readFileSync(resolve(ROOT, PATH), 'utf8')

/** `uses:` 行を全部拾う */
const usesLines = (src: string) => src.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- uses:'))

/** `permissions:` ブロックの中身（`key: value` の並び）を拾う */
const permissionEntries = (src: string) => {
  const out: string[] = []
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*permissions:\s*$/.test(lines[i])) continue
    const indent = lines[i].search(/\S/)
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (!l.trim()) continue
      if (l.search(/\S/) <= indent) break
      out.push(l.trim())
    }
  }
  return out
}

describe('CI ① 権限が read だけ', () => {
  it('permissions ブロックが実在する（宣言していない＝既定の広い権限、を許さない）', () => {
    mustBeNonEmpty(permissionEntries(SRC), 'permissions の項目')
  })

  it('**contents: read 以外の権限を持たない**', () => {
    for (const e of permissionEntries(SRC)) {
      expect(e, `read 以外の権限がある: ${e}`).toBe('contents: read')
    }
  })

  it.each(['contents: write', 'packages: write', 'id-token: write', 'pull-requests: write'])(
    '%s を足したら落ちる（対照）',
    (bad) => {
      const mutated = SRC.replace('permissions:\n  contents: read', `permissions:\n  ${bad}`)
      expect(mutated, '変異が入っていない').not.toBe(SRC)
      expect(permissionEntries(mutated).every((e) => e === 'contents: read')).toBe(false)
    },
  )

  it('publish につながる語が出てこない', () => {
    for (const bad of ['gh release', 'npm publish', 'git push', 'softprops/action-gh-release', 'peaceiris/actions-gh-pages']) {
      expect(SRC, `${bad} が入っている`).not.toContain(bad)
    }
  })

  it('**credential を残さない**（後続の step が token を拾えない）', () => {
    expect(SRC).toContain('persist-credentials: false')
  })
})

describe('CI ② action が full commit SHA で固定されている', () => {
  const SHA40 = /^- uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40}$/

  it('uses: 行が実在する', () => {
    mustBeNonEmpty(usesLines(SRC), 'uses: 行')
  })

  it('**すべての uses: が 40 桁の SHA を指している**', () => {
    for (const l of usesLines(SRC)) {
      expect(SHA40.test(l), `SHA 固定になっていない: ${l}`).toBe(true)
    }
  })

  it.each([
    ['tag 参照', 'actions/checkout@v7'],
    ['ブランチ参照', 'actions/checkout@main'],
    ['短縮 SHA', 'actions/checkout@3d3c42e'],
  ])('%s に書き換えたら落ちる（対照）', (_name, ref) => {
    const mutated = SRC.replace(/actions\/checkout@[0-9a-f]{40}/, ref)
    expect(mutated, '変異が入っていない').not.toBe(SRC)
    expect(usesLines(mutated).every((l) => SHA40.test(l)), `${ref} を通してしまった`).toBe(false)
  })

  it('**どの版を指しているかがコメントに書いてある**（SHA だけだと人が追えない）', () => {
    for (const l of usesLines(SRC)) {
      const repo = /- uses: ([\w.-]+\/[\w.-]+)@/.exec(l)![1]
      expect(SRC, `${repo} の版がコメントに無い`).toMatch(new RegExp(`#\\s*${repo.replace('/', '\\/')} v[\\d.]+`))
    }
  })
})

describe('CI ③ 回すものと回さないもの', () => {
  const RUN = ['npm run typecheck', 'npm run test', 'npm run validate:profiles',
    'npm run check:vacuity', 'npm run check:doc-numbers', 'npm run lint']
  /** **重い成果物は CI で回さない。**通らないから通るまで回す運用になり、artifact が CI の都合で動く */
  const NEVER = ['npm run search:topology', 'npm run sensitivity', 'npm run search:robustness',
    'npm run export:half-plug', 'npm run release:evidence', 'npm run release:stage']

  it.each(RUN)('%s を回している', (cmd) => {
    expect(SRC, `${cmd} を回していない`).toContain(cmd)
  })

  it.each(NEVER)('**%s は回していない**', (cmd) => {
    expect(SRC, `${cmd} を回している`).not.toContain(cmd)
  })

  it('回している 6 つが package.json に実在する（存在しない script を並べていない）', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    for (const cmd of RUN) {
      const name = cmd.replace('npm run ', '')
      expect(Object.keys(pkg.scripts), `${name} が package.json に無い`).toContain(name)
    }
  })

  it('**過去 tag を読むテストのために fetch-depth: 0 を指定している**', () => {
    // schemaVersioningPolicy / contractMigration が git show で過去 tag の schema を読む
    expect(SRC).toContain('fetch-depth: 0')
  })
})
