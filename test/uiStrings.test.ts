/**
 * 画面に出る固定文字列が、モデルの実態と食い違わないようにする。
 *
 * ## なぜこのファイルがあるか
 *
 * 文書の数値は `test/docs.test.ts` が artifact と機械照合している。
 * **画面の文字列は誰も見ていなかった。** 2026-08-02 に 4極ジャックを組み直したとき、
 * variant の説明文が「端子番号は Same Sky SJ3-35074A に準拠」のまま残り、
 * 画面だけが嘘をついている状態になった。文書は直したのに画面を直していない、という形である。
 *
 * ## なぜ「台帳方式」にしなかったか
 *
 * 洗い出すと、画面に出る文字列は **JSON 側 238 件 + UI 直書き 160 件** あった。
 * そのうち実際に陳腐化していたのは **5 件**で、しかも 5 件とも
 * **「これはどの実在部品を表しているか」**という同じパターンだった。
 *
 * 398 件を台帳に載せると、文言を直すたびに台帳も直すことになり、
 * 割に合わない上に「台帳を通したから正しい」という誤った安心を生む。
 * そこで**そのパターンだけを突く不変条件**を少数置くことにした。
 *
 * 見つかった 5 件:
 *   1. App のヘッダが、構成モデルを選んでも「実在する代表的な一例」と名乗っていた
 *   2. materials の「ローレットナット (CuZn ニッケルめっき)」が 4極でも出る
 *      (1503 28 のノーズは樹脂。3D は 3極品の外形を流用しているため)
 *   3. 4極ジャックのボア径の注記が、17mm プラグ用の別規格品 (Cliff FC68128) だけを挙げていた
 *   4. 4極 OMTP プラグの説明文が、構成モデルであることをどこにも書いていなかった
 *   5. 4極 CTIA プラグの説明文が「Ring1/Ring2 の境界は仮定」と書いていた
 *      (その境界は 2026-07-31 に FACT へ解決済み。**逆向きの陳腐化**)
 */

// **`existsSync` を分岐に使わない。** 2026-08-03 まで 4 か所で
// `if (!existsSync(p)) return` と書いており、成果物が消えると 3 件が黙って通った。
// artifacts/ は git 管理下で「無い環境」は存在しない (→ CONTRIBUTING §7)。
// 下の「検査対象が実在するか」だけは、存在そのものを検査したいので使う。
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_FAULTS } from '../src/model/contact'
import { extractEvents, sweep } from '../src/model/sweep'
import {
  allVariantIds,
  getModel,
  jackInfo,
  listJackVariants,
  listPlugVariants,
  plugInfo,
  rawSources,
  splitVariantId,
} from '../src/data'

const ROOT = resolve(__dirname, '..')

describe('画面に出る文字列', () => {
  it('**識別子の欄に説明文を入れていない**（ヘッダが崩れる）', () => {
    // partNumber / manufacturer は App のヘッダに 1 行で並べて出る。
    // 2026-08-02 に「Lumberg (接点系のみ)。外形は 3極 1503 09 の値を流用」という
    // 文章を manufacturer に入れてしまい、ヘッダが読めない文になった。
    // 説明は variant の description が持つ。こちらは識別子に保つ。
    for (const v of allVariantIds()) {
      const m = getModel(v)
      for (const [what, s] of [
        ['plug.partNumber', m.plug.partNumber],
        ['plug.manufacturer', m.plug.manufacturer],
        ['jack.partNumber', m.jack.partNumber],
        ['jack.manufacturer', m.jack.manufacturer],
      ] as const) {
        expect({ v, what, tooLong: s.length > 40 }).toEqual({ v, what, tooLong: false })
        expect({ v, what, hasSentence: /。/.test(s) }).toEqual({ v, what, hasSentence: false })
      }
    }
  })

  it('**構成モデルを含む組み合わせでは「実在の一例」と名乗らない**', () => {
    // App.tsx はこの条件で文言を切り替える。条件そのものを検査する。
    const claimReal = (v: ReturnType<typeof allVariantIds>[number]) => {
      const [p, j] = splitVariantId(v)
      return plugInfo(p).basis === 'measured-part' && jackInfo(j).basis === 'measured-part'
    }
    // 実在部品の対は 3極×3極 だけ
    expect(allVariantIds().filter(claimReal)).toEqual(['TRS|JACK-TRS'])
    // 4極ジャックを含む組み合わせでは必ず名乗らない
    for (const v of allVariantIds().filter((x) => x.endsWith('JACK-TRRS')))
      expect({ v, claims: claimReal(v) }).toEqual({ v, claims: false })
  })

  it('**構成モデルの説明文は、実在製品でないと明言している**', () => {
    // 「仮定」「構成」という語の有無だけでは足りない。
    // 実際、TRRS-CTIA の説明文には「Ring1/Ring2 の境界は仮定」とあったが、
    // その境界は 2026-07-31 に FACT へ解決済みで、**逆向きに古くなっていた**。
    // 語の有無ではなく、**必要な断り書きが入っているか**を見る。
    for (const v of [...listPlugVariants(), ...listJackVariants()])
      if (v.basis === 'constructed')
        expect({ id: v.id, discloses: v.description.includes('実在の特定製品ではない') }).toEqual({
          id: v.id,
          discloses: true,
        })
  })

  it('**解決済みの項目を「仮定」と言い続けていない**', () => {
    // 逆向きの陳腐化。4極プラグの導体境界は FACT なのに、説明文が「仮定」と書いていた。
    const boundariesAreFact = ['trrs.ring1.end', 'trrs.ring2.start'].every(
      (k) => getModel('TRRS-CTIA|JACK-TRRS').dims.entry(k).grade === 'FACT',
    )
    expect(boundariesAreFact).toBe(true)
    const ctia = listPlugVariants().find((v) => v.id === 'TRRS-CTIA')!
    expect(ctia.description).not.toMatch(/境界は仮定/)
  })

  it('**表示される出典 ID が、すべて出典表に実在する**', () => {
    // 出典 ID の改名・削除で「根拠」タブのリンクが黙って消えるのを防ぐ。
    const known = new Set(rawSources.map((s) => s.id))
    const missing: string[] = []
    const scan = (o: unknown, where: string) => {
      if (Array.isArray(o)) return o.forEach((x, i) => scan(x, `${where}[${i}]`))
      if (o && typeof o === 'object')
        for (const [k, val] of Object.entries(o as Record<string, unknown>)) {
          if (k === 'sources' && Array.isArray(val))
            for (const id of val) if (typeof id === 'string' && !known.has(id)) missing.push(`${where}.${k}=${id}`)
          else scan(val, `${where}.${k}`)
        }
    }
    for (const f of [
      'src/data/dimensions.json',
      'src/data/materials.json',
      'src/data/jackContacts.json',
      'src/data/jackContacts.trrs.json',
      'src/data/plugSegments.json',
      'src/data/plugSegments.trrs.json',
    ])
      scan(JSON.parse(readFileSync(resolve(ROOT, f), 'utf8')), f)
    expect(missing).toEqual([])
  })

  it('**材質ラベルが、どの部品のものかを名乗っている**', () => {
    // 3D の前面円柱は全 variant 共通で描かれるが、材質は 3極 1503 09 のものである。
    // 4極 (1503 28) のノーズは樹脂で、ナットでもない。
    // ラベルが部位名だけだと、4極でも金属ナットだと読めてしまう。
    const mats = JSON.parse(readFileSync(resolve(ROOT, 'src/data/materials.json'), 'utf8')) as {
      materials: { id: string; label: string }[]
    }
    const bushing = mats.materials.find((x) => x.id === 'jack-bushing')!
    expect(bushing.label).toMatch(/1503 09/)
  })
})

/**
 * 公開物に社交辞令を書かない。
 *
 * 2026-08-03、公開した release note へ
 * 「Half-Plug Lab 側の fixture import で発見されました。**報告に感謝します。**」と書いた。
 *
 * Half-Plug Lab はこのリポジトリの作者自身の別プロジェクトで、
 * 監査文書はその作者が AI に生成させたものである。**その事実は分かっていた。**
 * それでも「外部のラボが監査してくれた」と読める文を公開物へ入れた。
 *
 * release note を読むのは不特定多数である。
 * **実態より大きく見せる書き方**は、このリポジトリが全編で禁じているものと同じ。
 *
 * 件数は 1 件（現在 0 件）。それでも検査を置くのは、
 * **release notes と引き継ぎ文は今後も書く**からで、検査そのものは数行で済む。
 */
describe('公開物の文体', () => {
  const PUBLIC_DOCS = [
    'README.md',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'docs/HALF_PLUG_ADAPTER.md',
    'docs/INTEGRATION_ORDER_20260803.md',
    'docs/release/v0.1.0-notes.md',
    'docs/release/v0.1.1-notes.md',
    // 提出用プロンプト。**相手は本人の AI セッションなので、依頼文でなく作業指示で書く**
    'docs/release/v0.1.1-chatgpt-prompt.md',
  ]

  it('**社交辞令を書いていない**（読者は不特定多数で、相手は AI セッションである）', () => {
    const COURTESY = ['感謝します', 'ありがとうございま', 'お礼申し上げ', '幸いです', 'よろしくお願い']
    const hits: string[] = []
    for (const f of PUBLIC_DOCS) {
      const src = readFileSync(resolve(ROOT, f), 'utf8')
      for (const w of COURTESY) if (src.includes(w)) hits.push(`${f}: ${w}`)
    }
    expect(hits).toEqual([])
  })

  it('**検査対象の公開物が実在する**（列挙だけして 0 件を検査しない）', () => {
    // ファイル名を打ち間違えると、上の検査は 1 文字も読まずに通る
    for (const f of PUBLIC_DOCS)
      expect({ f, exists: existsSync(resolve(ROOT, f)) }).toEqual({ f, exists: true })
    expect(PUBLIC_DOCS.length).toBeGreaterThan(5)
  })
})

/**
 * 「逆向きの陳腐化」— 解決済みの項目を、まだ未確認だと言い続けていないか。
 *
 * ## 汎用の検出器は作らなかった
 *
 * `dimensions.json` の 135 キーに対して「grade が FACT/DERIVED なのに note に
 * 『仮定 / 不明 / 未確認』がある」「grade が ASSUMPTION なのに note に『図面記載 / FACT』がある」
 * という語句スキャンをかけると **9 件**引っかかったが、**実質は 1 件だけ**だった（誤検出 8/9 = 89 %）。
 *
 * 誤検出の中身は 2 種類:
 *   - 歴史的な記述（「2026-07-31 まで〜と書いていたが」）
 *   - 同じ note の中で**別の量**を指している（「端子位置は FACT だが接点位置は ASSUMPTION」）
 *
 * 語句スキャンは文脈を見られないので、テストにすると 8 件の恒久的なノイズになる。
 * `docs.test.ts` が「artifact の全数値を文書と突き合わせる」のをやめて
 * 主張の台帳にしたのと同じ理由で、**見つかった分だけを名指しで固定する**。
 *
 * 2026-08-02 の洗い出しで見つかった 6 件:
 *   1. jack.housing.axisHeightFromPcb が FACT なのに、note 自身が「依然として未確認」と書いていた
 *   2. docs/REPORT.md が「Ring1 / Ring2 の境界は仮定」（07-31 に FACT へ解決済み）
 *   3. ASSUMPTIONS.md G が軸高さの導出を旧記述（拾い漏れ前の「中央に描かれているから」）のまま
 *   4. UNKNOWNS.md §2 が「JEITA が読めれば Ring1/Ring2 境界を確定できた」（もう確定済み）
 *   5. ASSUMPTIONS.md F-3 が端子番号の出典を Same Sky SJ3-35074A のままにしていた
 *   6. ASSUMPTIONS.md F-3 が「4極ジャックのブレーク接点は定義していません」（08-02 に定義済み）
 */
describe('逆向きの陳腐化', () => {
  const md = (f: string) => readFileSync(resolve(ROOT, f), 'utf8')
  const dims = getModel('TRS|JACK-TRRS').dims

  it('**note が自分自身を未確認と書いている項目を FACT にしない**', () => {
    // 1 件目。合成量の区分は、弱いほうの入力に合わせる。
    expect(dims.entry('jack.housing.axisHeightFromPcb').grade).toBe('ASSUMPTION')
  })

  it('解決済みの Ring1/Ring2 境界を「仮定」と呼んでいない', () => {
    // 境界は図面記載の演算で FACT（§5-1・2026-07-31 解決）
    for (const k of ['trrs.ring1.end', 'trrs.ring2.start'])
      expect({ k, grade: dims.entry(k).grade }).toEqual({ k, grade: 'FACT' })
    for (const f of ['docs/REPORT.md', 'README.md', 'ASSUMPTIONS.md'])
      expect({ f, stale: /Ring1 ?\/ ?Ring2 の境界[^。\n]*(は仮定|が仮定)/.test(md(f)) }).toEqual({
        f,
        stale: false,
      })
    expect(md('UNKNOWNS.md')).not.toMatch(/読めれば TRRS の Ring1\/Ring2 境界を確定できた/)
  })

  it('**4極ジャックのブレーク接点を「定義していない」と書いていない**', () => {
    // §5-3 は 2026-08-02 に解決済み。モデルにも入っている。
    const brk = getModel('TRS|JACK-TRRS').jack.contacts.filter((c) => c.breakContact)
    expect(brk).toHaveLength(2)
    for (const f of ['ASSUMPTIONS.md', 'UNKNOWNS.md', 'README.md'])
      expect({ f, stale: /ブレーク接点は定義していません/.test(md(f)) }).toEqual({ f, stale: false })
  })

  it('4極ジャックの端子番号の出典が、いま使っている部品と一致している', () => {
    // 旧: Same Sky SJ3-35074A / 現: Lumberg 1503 28
    expect(md('ASSUMPTIONS.md')).not.toMatch(/端子番号（PIN1=sleeve[^）]*）は Same Sky/)
    expect(md('ASSUMPTIONS.md')).toMatch(/1503 28/)
  })

  it('軸高さの導出について、拾い漏れ前の説明が残っていない', () => {
    expect(md('ASSUMPTIONS.md')).not.toMatch(/前面図でボアが本体高さ 6 ?mm の中央に描かれていることから DERIVED/)
  })
})

/**
 * 根拠区分（grade）の付け方。
 *
 * 合成量の区分は**弱いほうの入力に合わせる**、というのがこのプロジェクトの規則である。
 * 2026-08-03 に 92 件（FACT 53 + DERIVED 39）を 1 件ずつ点検し、**11 件**が
 * 「資料から導いたものではないのに DERIVED」になっていたので下げた。
 *
 *   - 接点ばねの自由半径・公称たわみ・ばね定数 9 件
 *     （別メーカー資料の押付力レンジに合わせた逆算。ASSUMPTIONS.md A 節の
 *       「内部接点ばねの寸法は公開資料に含まれていない」と食い違っていた）
 *   - jack.entryBushingLength（ノーズ長の全長がボアだという仮定。
 *     UNKNOWNS §3-8 が「DERIVED の仮定」と自己矛盾した書き方をしていた）
 *   - plug.handle.bodyDiameter（八角形の実測を表示用に φ10 へ丸めた値）
 *
 * **FACT 側 53 件からは 1 件も出なかった。**
 */
describe('根拠区分の付け方', () => {
  const dims = getModel('TRS|JACK-TRS').dims

  it('**接点ばねの諸元はすべて ASSUMPTION である**', () => {
    // 資料に無いものを DERIVED と呼ばない。ASSUMPTIONS.md A 節の主張と揃える。
    for (const c of ['tip', 'ring', 'sleeve'])
      for (const p of ['freeRadius', 'nominalDeflection', 'springRate', 'maxDeflection', 'padWidth'])
        expect({ k: `${c}.${p}`, grade: dims.entry(`jack.contact.${c}.${p}`).grade }).toEqual({
          k: `${c}.${p}`,
          grade: 'ASSUMPTION',
        })
  })

  it('**接点まわりで DERIVED を名乗れるのは、図面の幾何から出るものだけ**', () => {
    // 端子の横位置 (FACT) から出る円周位置と、端子の軸位置そのもの。それ以外は仮定。
    const derived = Object.entries(dims.all())
      .filter(([k, v]) => k.startsWith('jack.contact.') && v.grade === 'DERIVED')
      .map(([k]) => k)
      .sort()
    expect(derived).toEqual([
      'jack.contact.ring.angularPosition',
      'jack.contact.sleeve.rootAxial',
      'jack.contact.tip.angularPosition',
    ])
  })

  it('自分の note が仮定だと書いている項目を FACT/DERIVED にしていない', () => {
    for (const k of ['jack.entryBushingLength', 'plug.handle.bodyDiameter', 'jack.housing.axisHeightFromPcb'])
      expect({ k, grade: dims.entry(k).grade }).toEqual({ k, grade: 'ASSUMPTION' })
  })
})

/**
 * README 冒頭の「使える／使えない」の理由づけ。
 *
 * 2026-08-03 に根拠区分を見直して ASSUMPTION が 43 → 54 件へ増えたとき、
 * 冒頭の理由が**件数だけ**になっていた。件数は「どれくらい信用できないか」を
 * 表さない（順序と仕組みは仮定に頑健で、深さと力だけが仮定に乗る）。
 * 読者が最初に決める分岐に効くよう、確か／不確かの切り分けを冒頭へ出した。
 *
 * ここで守るのは 2 つ。
 *   - 押付力の根拠が **別メーカーの資料** であることを README が隠さない
 *   - 冒頭の「確か」の側に、実は仮定に乗るもの（ブレーク接点の開くタイミング）を混ぜない
 */
describe('README 冒頭の理由づけ', () => {
  const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8')

  it('**ばね定数の根拠が別メーカー資料であることを書いている**', () => {
    // SOURCES §6 は「この値を 1503 09 の仕様として表示してはいません」と定めている。
    // README が「メーカー公称レンジ」とだけ書くと、同じ部品の値に読める。
    expect(readme).toMatch(/別メーカー/)
    expect(readme).not.toMatch(/摩擦係数とばね定数は\s*\n?\s*メーカー公称レンジに整合するよう置いた仮定値です/)
  })

  it('**「確か」の側にブレーク接点のタイミングを入れていない**', () => {
    // しきい値 0.4 以上では一度も開かない。順序の不変量には含められない。
    const head = readme.slice(0, readme.indexOf('### 言葉づかい'))
    const row = head.split('\n').find((l) => l.includes('**確か**'))!
    expect(row).not.toMatch(/ブレーク接点/)
    expect(row).toMatch(/順序/)
  })

  it('冒頭が件数だけで終わっていない（頑健な結論も示している）', () => {
    const head = readme.slice(0, readme.indexOf('### 言葉づかい'))
    expect(head).toMatch(/何もかもが不確かなわけではありません/)
    expect(head).toMatch(/不確か/)
  })
})

/**
 * 文書どうしの食い違い。
 *
 * 2026-08-03 に、6 つの主張（橋絡の深さ / Tip↔Ring が橋絡しないこと / ブレーク接点 /
 * 4極ジャックの接点位置の根拠 / 挿抜力の校正 / 完全挿入深度）を 7 文書で突き合わせた。
 * 該当行は 257 行あったが、**値が割れていたのは 1 件**だけだった。
 *
 *   ブレーク接点が開く深さ … README/REPORT §4 は 8.06、SENSITIVITY/REPORT §5 は 8.05。
 *   artifact で確かめると events.json（0.02mm 走査）= 8.06、
 *   sensitivity.json（二分法）= 8.0509 で、**方法が違うだけ**だった。
 *   橋絡については同じ説明（11.760 と 11.78）が既にあるのに、ブレーク接点には無かった。
 *
 * 1 件なので「1 つの主張は 1 か所に書いて他は参照する」という構造の見直しはしない。
 * 両方の値が出てくる文書に、方法の違いを書き添えるだけにした。
 */
describe('文書どうしの食い違い', () => {
  const read = (f: string) => readFileSync(resolve(ROOT, f), 'utf8')

  it('**ブレーク接点の 8.05 と 8.06 が、方法の違いだと説明されている**', () => {
    for (const f of ['README.md', 'docs/REPORT.md', 'docs/SENSITIVITY.md']) {
      const t = read(f)
      if (t.includes('8.05') && t.includes('8.06'))
        expect({ f, explained: /二分法/.test(t) && /刻み/.test(t) }).toEqual({ f, explained: true })
    }
    // SENSITIVITY は 8.05 側だが、走査値との関係を書いていること
    expect(read('docs/SENSITIVITY.md')).toMatch(/8\.06/)
  })

  it('二分法の値と走査値が、artifact のとおりである', () => {
    const ev = JSON.parse(readFileSync(resolve(ROOT, 'artifacts/events.json'), 'utf8')) as {
      major: { kind: string; depthMm: number }[]
    }
    const first = ev.major.find((e) => e.kind === 'FIRST_BREAK_OPEN')!
    expect(first.depthMm).toBe(8.06) // 0.02mm 走査
    const sens = JSON.parse(readFileSync(resolve(ROOT, 'artifacts/sensitivity.json'), 'utf8')) as {
      previouslyUnswept: { ringBreakOpenDeflection: { openDeflection: number; depth: number | null }[] }
    }
    const shipped = sens.previouslyUnswept.ringBreakOpenDeflection.find((r) => r.openDeflection === 0.05)!
    expect(shipped.depth).toBe(8.0509) // 二分法
  })
})

/**
 * 手順（CONTRIBUTING.md §3）が実際に機能することを固定する。
 *
 * 2026-08-03 の通し確認で、手順は機能したが**条件に穴があった**。
 * 「接点位置や区分を変えたときは重い成果物の再実行が必要」と書いていたが、
 * 帰線パッド幅を変えたときも必要だった（両方の走査軸に入っている）。
 * 条件を人が覚えるのをやめ、`npm run check:stale` の機械判定に置き換えた。
 *
 * ここで守るのは「判定に必要な記録が成果物に入っていること」である。
 * 記録が消えると、判定はできなくなるのに**静かに「再実行不要」と答えてしまう**。
 */
describe('重い成果物の陳腐化判定', () => {
  const art = (f: string) => resolve(ROOT, 'artifacts', f)

  it('**探索の成果物が、走査軸ごとに実行時の値を記録している**', () => {
    const p = art('topology_search_difference_signal.json')
    const a = JSON.parse(readFileSync(p, 'utf8')) as {
      searchSpace: { axesByJack: Record<string, { key: string; shipped: number }[]> }
    }
    const axes = Object.values(a.searchSpace.axesByJack).flat()
    expect(axes.length).toBeGreaterThan(0)
    for (const x of axes) expect({ k: x.key, hasShipped: typeof x.shipped === 'number' }).toEqual({ k: x.key, hasShipped: true })
  })

  it('**感度解析の成果物が、走査に使った寸法値を記録している**', () => {
    const p = art('sensitivity.json')
    const a = JSON.parse(readFileSync(p, 'utf8')) as { inputs?: Record<string, number> }
    expect(a.inputs).toBeDefined()
    expect(Object.keys(a.inputs!).length).toBeGreaterThan(5)
    // 記録された値が、実在する寸法キーであること
    const dims = getModel('TRS|JACK-TRS').dims
    for (const k of Object.keys(a.inputs!)) expect({ k, exists: dims.entry(k) !== undefined }).toEqual({ k, exists: true })
  })
})

/**
 * **成果物がモデルより古くなっていないか。**
 *
 * 2026-08-03 に、判定の穴を見つけた。
 *   - `docs.test.ts` … 文書 ↔ artifact
 *   - `contact.test.ts` / `trrs.test.ts` … モデルの挙動
 *   - **artifact ↔ モデルを見ているテストが 1 つも無かった。**
 *
 * つまり `npm run artifacts` を回し忘れると、**古い artifact に文書が合っている**ので
 * すべて緑のまま、公開している数値だけが実際のモデルとずれる。
 *
 * git 履歴では一度も起きていない（`npm run artifacts` は数秒で終わり、習慣で回している）。
 * それでも構造的には到達できるので、**代表値をモデルから計算し直して突き合わせる**。
 * 重い成果物（探索・感度解析）は `npm run check:stale` が別に見ている。
 */
describe('成果物がモデルより古くなっていない', () => {
  const art = (f: string) => resolve(ROOT, 'artifacts', f)

  it('**events.json の橋絡区間が、いまのモデルから計算し直した値と一致する**', () => {
    const p = art('events.json')
    const a = JSON.parse(readFileSync(p, 'utf8')) as {
      stepMm: number
      major: { kind: string; depthMm: number }[]
    }
    const m = getModel('TRS|JACK-TRS')
    const rows = sweep(m, { stepMm: a.stepMm, faults: DEFAULT_FAULTS })
    const events = extractEvents(m, rows)
    // **存在しない kind を並べると null === null で素通りする。**
    // 実際 2026-08-03 の初稿で BRIDGE_START / BRIDGE_END という実在しない名前を書き、
    // 3 件中 2 件が空振りしていた (このリポジトリで 6 度目の同型)。まず実在を検査する。
    const KINDS = ['FIRST_BRIDGE', 'FIRST_BREAK_OPEN', 'FIRST_ELECTRICAL_CONTACT', 'ALL_SIGNALS_CORRECT']
    for (const kind of KINDS)
      expect({ kind, inArtifact: a.major.some((e) => e.kind === kind) }).toEqual({ kind, inArtifact: true })

    for (const kind of KINDS) {
      const inArt = a.major.find((e) => e.kind === kind)!
      const now = events.find((e) => e.kind === kind)
      expect({ kind, model: now?.depthMm ?? null }).toEqual({ kind, model: inArt.depthMm })
    }
  }, 30_000)

  it('**verification_summary.json の区分件数が、いまの台帳と一致する**', () => {
    const p = art('verification_summary.json')
    const a = JSON.parse(readFileSync(p, 'utf8')) as { gradeCounts: Record<string, number> }
    const counts: Record<string, number> = { FACT: 0, DERIVED: 0, ASSUMPTION: 0, UNKNOWN: 0 }
    for (const v of Object.values(getModel('TRS|JACK-TRS').dims.all())) counts[v.grade]++
    expect(a.gradeCounts).toEqual(counts)
  })
})
