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

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
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
