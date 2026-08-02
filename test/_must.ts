/**
 * 「実在しない識別子」で空振りしないための小さな道具。
 *
 * ## なぜ要るか
 *
 * このリポジトリでは 2026-08-02〜03 に **7 回**、同じ形の欠陥を作った。
 * どれも「識別子で引く → 見つからない → それでもテストが通る」である。
 *
 *   1. searchTopology が 4極 variant へ 3極用の寸法キーを渡し、override が効かないまま
 *      「3 variant を探索した」と報告した
 *   2. テストが端子 ID を直書きし、番号体系が変わって 3 件落ちた（これは落ちたので気付けた）
 *   3. 探索の標本が variant 混在で、成立した 4極が 1 件も載らなかった
 *   4. 走査水準のリストに既定値が入っておらず、「無改造で成立: 0」と報告した
 *   5. sensitivity が同じ形で既定値を走査していなかった
 *   6. artifact 照合テストが実在しない kind 名（BRIDGE_START）を並べ、null === null を比べた
 *   7. `differenceWindowCount` が signalRole を引けないと 0 を返し、
 *      **「図面値では区間が出ない」という反証を守るテストが、壊れていても通った**（2026-08-03 実測）
 *
 * ## 使い分け
 *
 * - 引けないと **例外で落ちる**なら、そのままでよい（`.find(...)!` は TypeError になる）。
 * - 引けないと **通ってしまう**なら、ここを使う。境目は「miss が偽の合格になるか」だけ。
 *
 * 41 件ある `.find(...)!` を機械的に置き換えることはしない。あれは落ちるので害が小さく、
 * 全部書き換えると差分が大きいわりに守りが増えない（→ CONTRIBUTING §7）。
 */

/** 引けなければその場で落ちる `find`。何を探して何があったかをメッセージに残す。 */
export function mustFind<T>(items: readonly T[], pred: (x: T) => boolean, what: string): T {
  const hit = items.find(pred)
  if (hit === undefined)
    throw new Error(`${what} が引けない。候補 ${items.length} 件: ${JSON.stringify(items).slice(0, 200)}`)
  return hit
}

/** 空集合を渡されたら落ちる。空の for..of が「合格」に化けるのを防ぐ。 */
export function mustBeNonEmpty<T>(items: readonly T[], what: string): readonly T[] {
  if (items.length === 0) throw new Error(`${what} が 0 件。この検査は 1 件以上を前提にしている`)
  return items
}
