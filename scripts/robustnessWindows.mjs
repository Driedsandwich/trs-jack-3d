/**
 * `topology-robustness` の窓の不変条件。**schema では書けない規則をここに置く。**
 *
 * ## なぜ切り出したか（v0.3.0 フォローアップ P1-4）
 *
 * schema は「その項目があるか」「型が合うか」しか言えない。
 * **`lastSampleMm` と `endExclusiveMm` の大小関係は draft-07 では書けない**
 * （項目どうしを比べる書き方が無い）。
 *
 * すると受け手は「schema を通ったから窓は正しい」と読んでしまう。
 * だから *どこで捕まえるのか* を、fixture で実演できる形にする——
 * 旧語彙 (`toMm`) は schema が、端点の大小は意味検査がそれぞれ捕まえる。
 *
 * `validateProfiles.mjs`（本番の検証）と `test/robustnessWindowFixtures.test.ts`
 * （fixture の実演）が**同じこの関数**を呼ぶ。別々に書くと、fixture が通っても
 * 本番が通るとは限らなくなる。
 */

/**
 * 窓 1 つ分の不変条件。**エラー文字列の配列**を返す（空なら合格）。
 *
 * @param {{startMm:number,lastSampleMm:number,endExclusiveMm:number,widthMm:number}} w
 * @param {number} stepMm 走査の刻み
 * @param {string} where エラー文につける場所の名前
 */
export function checkWindow(w, stepMm, where) {
  const errs = []
  const num = (k) => typeof w?.[k] === 'number' && Number.isFinite(w[k])
  for (const k of ['startMm', 'lastSampleMm', 'endExclusiveMm', 'widthMm'])
    if (!num(k)) errs.push(`${where}: ${k} が数値でない (${JSON.stringify(w?.[k])})`)
  if (errs.length) return errs

  // **旧 v1 の語彙が残っていないこと。**`toMm` は「最後に当たった標本の位置」で、
  // 区間の終端ではなかった。同じ「終わり」という語で 2 つの違う量を指していた
  for (const legacy of ['fromMm', 'toMm'])
    if (legacy in w) errs.push(`${where}: 旧 v1 の項目 ${legacy} が残っている`)

  if (w.lastSampleMm < w.startMm)
    errs.push(`${where}: lastSampleMm ${w.lastSampleMm} が startMm ${w.startMm} より小さい`)

  /**
   * **最後の標本は区間の終端より必ず手前にある。**
   * `lastSampleMm === endExclusiveMm` は「終端でも観測した」という意味になり、
   * EXCLUSIVE の約束と矛盾する。**schema では書けない条件はここが唯一の砦。**
   */
  if (w.lastSampleMm >= w.endExclusiveMm)
    errs.push(
      `${where}: lastSampleMm ${w.lastSampleMm} が endExclusiveMm ${w.endExclusiveMm} 以上。`
        + 'endExclusiveMm は区間の外側なので、標本がそこに乗ることはない (EXCLUSIVE)',
    )

  const wantEnd = +(w.lastSampleMm + stepMm).toFixed(4)
  if (Math.abs(w.endExclusiveMm - wantEnd) > 1e-6)
    errs.push(`${where}: endExclusiveMm ${w.endExclusiveMm} が lastSampleMm + stepMm (${wantEnd}) と合わない`)

  const wantWidth = +(w.endExclusiveMm - w.startMm).toFixed(4)
  if (Math.abs(w.widthMm - wantWidth) > 1e-6)
    errs.push(`${where}: widthMm ${w.widthMm} が endExclusiveMm − startMm (${wantWidth}) と合わない`)

  return errs
}

/**
 * artifact 全体の窓を見る。`nominalConfiguration` と `counterExamples` の両方。
 *
 * @param {object} a topology-robustness artifact
 * @returns {string[]} エラー文字列（空なら合格）
 */
export function checkWindowInvariants(a) {
  const errs = []
  if (a.windowEndConvention !== 'EXCLUSIVE') errs.push(`windowEndConvention が ${a.windowEndConvention}`)
  const all = [
    ...(a.nominalConfiguration?.windows ?? []).map((w) => ['nominalConfiguration', w]),
    ...(a.counterExamples ?? []).flatMap((c) => (c.windows ?? []).map((w) => [c.label ?? c.kind, w])),
  ]
  for (const [where, w] of all) errs.push(...checkWindow(w, a.stepMm, where))
  return errs
}
