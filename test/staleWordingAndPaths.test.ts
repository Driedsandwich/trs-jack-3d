/**
 * **言い切った文言と、指したパスが、いまも本当か（v0.6.15 新設・v0.6.16 で探索型へ）。**
 *
 * ## なぜ要るか
 *
 * v0.6.11 から v0.6.14 まで、**同じ形の欠陥を 4 版連続で出した。**
 * 境界や一覧を 2 か所に持ち、片方だけ直す。直さなかった側は誰も検査していないので、
 * **ずれても何も落ちない。**外部監査が毎回それを拾って返してきた。
 *
 * **変異対照（2026-08-14）**: SECURITY.md の版数を `v0.9.9 より前` に書き換えて
 * 全試験を回すと **1236 件すべて緑**だった。文言は 1 か所も検査されていなかった。
 *
 * ## v0.6.16 で作り直した理由
 *
 * v0.6.15 のこの試験は「全面へ当てる」と説明しながら、
 * **`LIVE_FILES` という手書きの allowlist を使っていた。**
 * 外部監査（2026-08-14）がそこを指した——**それ自体が同じ形の欠陥**である。
 *
 * 実測（2026-08-14）: `docs/` へ新しい文書を作り、古い言い方と実在しないパスを
 * 両方書いて全試験を回すと **14 件すべて緑**だった。**足し忘れれば検査されない。**
 *
 * だから**追跡されているファイルを列挙して**当てる。
 * 免除は「もう直せない記録」だけで、**パターンではなくパスの前方一致で宣言し、
 * 宣言した免除が実際に効いているかも確かめる**（効かなくなった免除を残すと、
 * 次に同じ語句が live へ戻っても静かに通る）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mustBeNonEmpty } from './_must'

const ROOT = resolve(__dirname, '..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')

/**
 * **もう直せない記録。**公開済み release 本文と正誤表は、当時の誤りごと残すのが仕様である
 * （`docs/ERRATA.md` の運用節）。**書き換えたら「いつ何が直ったか」が消える。**
 *
 * この試験自身も入る——反例として古い言い方を引用しているため。
 */
const FROZEN_PREFIXES = [
  'docs/release/',
  'docs/ERRATA.md',
  'CHANGELOG.md',
  /** 日付入りの受入・監査記録。**当時の状態を書いたもので、いま直すものではない** */
  'docs/INTEGRATION_ORDER_20260803.md',
  'docs/NONBLOCKING_FOLLOWUP_ORDER_20260803.md',
  'docs/NONBLOCKING_FOLLOWUP_ORDER_V020_20260803.md',
  'docs/NONBLOCKING_FOLLOWUP_ORDER_V030_20260803.md',
  'docs/NONBLOCKING_FOLLOWUP_ORDER_V040_20260804.md',
  'docs/NONBLOCKING_FOLLOWUP_ORDER_V041_20260804.md',
  'docs/PUBLISH_AUDIT_20260731.md',
  'docs/UNCHECKED_LISTS_AUDIT_20260812.md',
  'test/sourceVerifierCliResult.test.ts',
  'test/staleWordingAndPaths.test.ts',
  /** 生成物。中身は他のファイルの写しなので、二重に数えない */
  'artifacts/',
] as const

/**
 * **わざと存在しないパス。**「無いファイルを渡したら」を試すための材料で、
 * 実在させてはいけない。**語句で推測せず、1 つずつ名指しで宣言する。**
 * 宣言が要らなくなっていないかも下で確かめる。
 */
const INTENTIONALLY_ABSENT = [
  'artifacts/not_tracked_at_all.json',
  'artifacts/does-not-exist.json',
] as const

/** 本文を持たない（検査しても意味が無い）拡張子 */
const BINARY_EXT = /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|woff2?|ttf)$/i

/** 生成物。正本の md を直せば追随するので、二重に数えない */
const GENERATED = /\.html$/

const isFrozen = (p: string) => FROZEN_PREFIXES.some((f) => p === f || p.startsWith(f))

/**
 * **git が知っているファイルを列挙する。**手書きの一覧を持たない。
 *
 * **まだ `git add` していないものも数える（v0.6.18）。**
 * `--cached` だけにすると、**新しく作ったファイルは add するまで検査から消える。**
 * 実際、core / CLI 分離で追加した fixture が実在しないパスを指していたのに、
 * 手元では緑で、**commit して push した CI で初めて落ちた**。
 * 同じ穴は schema の母集団で先に見つけて塞いであった（`--others` を足した）が、
 * こちらには残っていた——**同じ境界を 2 か所で持っていた**ということ。
 */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n').filter(Boolean)
}

/** 検査する live なファイル（追跡されていて、凍結記録でも生成物でもないテキスト） */
function liveFiles(): string[] {
  return trackedFiles().filter((p) => {
    if (isFrozen(p) || BINARY_EXT.test(p) || GENERATED.test(p)) return false
    const abs = resolve(ROOT, p)
    if (!existsSync(abs)) return false
    /** 巨大ファイルは読まない（実測: いちばん大きい追跡ファイルでも 2 MB 未満） */
    return statSync(abs).size < 4 << 20
  })
}

/** live 側に在ってはいけない言い方と、なぜ誤りか */
const FORBIDDEN_PHRASES = [
  {
    phrase: 'v0.3.0 より前',
    why: '範囲定義（inputScope）が入ったのは v0.4.0。v0.3.0 自身も「範囲が無い側」に含まれる',
  },
] as const

describe('言い切った文言が、いまも本当か', () => {
  const LIVE = liveFiles()

  it('**追跡ファイルを実際に列挙できている**（allowlist を持たない）', () => {
    expect(mustBeNonEmpty(LIVE, '検査対象の live ファイル').length,
      '**検査対象が痩せている。**追跡 349 件から凍結記録・生成物・artifact を除いて 183 件が実測（2026-08-14）',
    ).toBeGreaterThanOrEqual(150)
    /** 凍結記録が漏れなく外れていること（外れていないと、当時の誤りで毎回落ちる） */
    expect(LIVE.filter((p) => p.startsWith('docs/release/'))).toEqual([])
    /** 逆に、live 側の代表が入っていること */
    for (const must of ['SECURITY.md', 'README.md', 'scripts/verifyReleaseSourceInputs.mjs']) {
      expect(LIVE, `${must} が検査対象から漏れている`).toContain(must)
    }
  })

  it.each(FORBIDDEN_PHRASES)('live なファイルに「$phrase」が無い（$why）', ({ phrase }) => {
    const hits = LIVE.filter((f) => read(f).includes(phrase))
    expect(hits, `**古い言い方が残っている**: ${hits.join(', ')}`).toEqual([])
  })

  /**
   * **除外のほうが陳腐化していないか。**
   * 語句を含まなくなった記録を除外に残すと、**その語句が live へ戻っても静かに通る。**
   */
  it.each(FORBIDDEN_PHRASES)('「$phrase」を免除した記録が、いまもその語句を含む', ({ phrase }) => {
    const frozen = trackedFiles().filter((p) => isFrozen(p) && !BINARY_EXT.test(p) && !GENERATED.test(p))
    const stillQuoting = frozen.filter((f) => existsSync(resolve(ROOT, f)) && read(f).includes(phrase))
    expect(
      mustBeNonEmpty(stillQuoting, `「${phrase}」を引用している記録`).length,
      '**免除する記録が 1 つも語句を含まない＝免除が不要になっている**',
    ).toBeGreaterThan(0)
  })

  /** **非空振り**: 検査が本当に本文を読んでいる */
  it('**この検査が空振りしていない**（存在する語句なら見つかる）', () => {
    const canary = LIVE.filter((f) => read(f).includes('v0.4.0 より前'))
    expect(canary.length, '訂正後の言い方すら見つからない＝本文を読めていない').toBeGreaterThan(0)
    expect(LIVE.filter((f) => read(f).includes('絶対に出てこない語句ZZZ'))).toEqual([])
  })
})

/**
 * **指したパスが実在するか。**
 * v0.6.14 は、受け手が読むエラー文で `scripts/reasonCodes.mjs` を指していた。
 * **そのファイルは同じ版で消してある。**「登録しろ」と言われた受け手は、無い場所を開くことになる。
 */
describe('文中で指したリポジトリ内のパスが実在するか', () => {
  /**
   * **前が語構成文字なら、それは長いパスの途中である（v0.6.16）。**
   * これを付けないと `node_modules/vitest/package.json` が
   * `test/package.json` として拾われる（実測で誤検出した）。
   */
  const PATH_TOKEN = /(?<![A-Za-z0-9_.\-/])(?:scripts|test|schemas|artifacts)\/[A-Za-z0-9_][A-Za-z0-9_.\-]*\.(?:mjs|ts|json|txt)/g
  const LIVE = liveFiles()

  it('live なファイルが指すパスがすべて実在する', () => {
    const missing: string[] = []
    for (const f of LIVE) {
      for (const t of new Set(read(f).match(PATH_TOKEN) ?? [])) {
        if ((INTENTIONALLY_ABSENT as readonly string[]).includes(t)) continue
        if (!existsSync(resolve(ROOT, t))) missing.push(`${f} → ${t}`)
      }
    }
    expect(missing, `**実在しないパスを指している**: ${missing.slice(0, 5).join(' / ')}`).toEqual([])
  })

  it('**この検査が空振りしていない**（実在するパスを実際に拾えている）', () => {
    const all = LIVE.flatMap((f) => read(f).match(PATH_TOKEN) ?? [])
    expect(mustBeNonEmpty([...new Set(all)], 'live なファイルが指すパス').length).toBeGreaterThanOrEqual(20)
    // 実在しない名前を混ぜたら落ちること（検出器そのものの対照）
    const fake = 'scripts/thisFileDoesNotExist.mjs'
    expect(fake.match(PATH_TOKEN), '検出器がこの形を拾えない').toEqual([fake])
    expect(existsSync(resolve(ROOT, fake))).toBe(false)
    /** 長いパスの途中を拾わない（誤検出の対照） */
    expect('node_modules/vitest/package.json'.match(PATH_TOKEN), '長いパスの途中を拾っている').toBeNull()
  })

  /**
   * **わざと存在しないと宣言したパスが、いまも参照されているか。**
   * 参照が消えたのに宣言だけ残ると、**同じ名前が本物の誤りとして現れても素通りする。**
   */
  it('**わざと存在しないと宣言したパスが、いまも使われている**', () => {
    for (const t of INTENTIONALLY_ABSENT) {
      const used = LIVE.filter((f) => read(f).includes(t))
      expect(mustBeNonEmpty(used, `${t} を参照しているファイル`).length,
        `**${t} はもう誰も参照していない。宣言を消すこと**`).toBeGreaterThan(0)
      expect(existsSync(resolve(ROOT, t)), `${t} は存在してはいけない`).toBe(false)
    }
  })
})

/**
 * **「無いと言ったのに在る」を捕まえる（v0.6.21・逆向きの陳腐化）。**
 *
 * ここまでの検査は「**在ると言ったのに無い**」を見ている——指したパスが実在するか。
 * だが**反対向きは誰も見ていなかった。**実測（2026-08-15）:
 *
 * ```
 * 11:21  docs 6e151bc   「fit:contacts の 4極版は未実装」と書いた
 * 11:38  script 7602666 **その 17 分後に fitContactsTrrs.ts が入った**
 * 15:53  docs 18abe44   同じ文書を再び触ったが、直っていない
 * ```
 *
 * **9 日間、測ってくださる方へ「無い」と伝え続けた。**
 * 実装が進むほど増える型で、しかも**害は受け手の側にしか出ない**
 * ——書いた本人は道具が在ることを知っているので、読み返しても違和感が無い。
 *
 * 検査は「否定語と同じ行に npm script 名がある」ものを拾い、
 * **その script が package.json に無いこと**を要求する。在るなら文言が古い。
 */
describe('「無い」と書いたものが、本当に無いか', () => {
  const LIVE = liveFiles()

  /** 実装の不在を言う語。ここに無い言い回しは拾えない（検査の範囲＝次に守られる範囲） */
  const ABSENCE = /未実装|用意していません|作っていません|入れていません|足していません|ありません/

  /** 不在の主張ではないもの。**語句でなくパスの前方一致で宣言する**（→ 上の EXEMPT と同じ考え方） */
  const EXEMPT_PREFIX = [
    'docs/release/',   // 公開済みの release notes は書き換えない（その時点の記録）
    'CHANGELOG.md',    // 履歴
  ]

  const SCRIPTS = Object.keys(
    (JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts,
  )

  /** 行を拾う。`npm run x` と `` `x` `` の両方の書かれ方を見る */
  const claims = (files: string[]) => {
    const out: { file: string, line: number, script: string, text: string }[] = []
    for (const f of files) {
      if (EXEMPT_PREFIX.some((p) => f.startsWith(p))) continue
      read(f).split('\n').forEach((l, i) => {
        if (!ABSENCE.test(l)) return
        for (const s of SCRIPTS) {
          if (l.includes(`npm run ${s}`) || l.includes(`\`${s}\``)) out.push({ file: f, line: i + 1, script: s, text: l.trim() })
        }
      })
    }
    return out
  }

  it('**実装されている script を「無い」と書いていない**', () => {
    const bad = claims(LIVE).filter((c) => SCRIPTS.includes(c.script) && ABSENCE.test(c.text)
      && /未実装|用意していません|作っていません|入れていません|足していません/.test(c.text))
    expect(bad.map((c) => `${c.file}:${c.line} ${c.script} — ${c.text.slice(0, 70)}`),
      '**その script は package.json に在る。文言が古い**').toEqual([])
  })

  it('**この検査が空振りしていない**（偽の文言を混ぜると拾える）', () => {
    const fake = '- `check:vacuity` の 4極版は未実装です'
    expect(ABSENCE.test(fake), '否定語を拾えない').toBe(true)
    expect(SCRIPTS.some((s) => fake.includes(`\`${s}\``)), 'script 名を拾えない').toBe(true)
    /** 逆の対照: 実在しない script 名なら拾わない */
    expect(SCRIPTS.some((s) => '- `no-such-script` は未実装です'.includes(`\`${s}\``))).toBe(false)
  })
})
