/**
 * 電気トポロジーの分類。**このプロジェクトで唯一の正本。**
 *
 * ## なぜ切り出したか（統合オーダー 2026-08-03 P0-4）
 *
 * 「帰線が浮き、L と R が別々の導体に届いている」という同じ判定が、
 * 2026-08-03 の時点で **5 か所**に書かれていた。
 *
 *   1. `src/model/circuit.ts` の `predictAcoustic`
 *   2. `scripts/searchTopology.ts` の `isStrictDifferenceSignal`
 *   3. `scripts/compareRealJack.ts` の `differenceWindows`
 *   4. `test/realJackComparison.test.ts` の `differenceWindowCount`
 *   5. `test/trrs.test.ts` の左右差分カウンタ
 *
 * 5 つが揃って正しい保証はどこにも無かった。実際、2 と 1 は
 * **2026-08-02 に 1 だけが直り、2 の説明文が旧実装のまま取り残されていた**
 * （「判定順の都合で L と R が同じ導体でも GROUND_OPEN になる」という記述。
 * その挙動はもう存在しない）。
 *
 * ## 層を分ける
 *
 * ここが返すのは**電気的な事実**だけである。「どう聞こえるか」は別層
 * （`predictAcoustic`）が持つ。オーダーが求めている分離はこれ。
 *
 * ## 位置ではなく機能で見る
 *
 * 端子 ID を直書きしない。3極ジャックは T1/T2/T3、4極は P1〜P6 と番号体系が違い、
 * 直書きすると片方が常に判定不能になる（2026-08-02 に実際に起きた）。
 * `signalRoleMap`（端子 → 機器が期待する機能）と
 * `netFunctions`（プラグ導体 → その導体が担う機能）で引く。
 */

import type { BreakState, ContactState, PlugNet, SignalFunction } from './types'

/**
 * 区間に付ける電気トポロジーの分類。
 * Half-Plug Lab 側の受け取り表（docs/HALF_PLUG_ADAPTER.md §5.3）と 1 対 1 で対応する。
 */
export type TopologyClass =
  | 'all-expected-functions-match'
  | 'no-path'
  | 'one-sided'
  | 'on-insulator'
  | 'wrong-conductor'
  | 'signal-to-signal-short'
  | 'signal-to-return-short'
  | 'ground-open-differential'
  | 'ground-open-nondifferential'

/** 分類対象として調べた全クラス。`absentTopologies.searched` の正本 */
export const ALL_TOPOLOGY_CLASSES: readonly TopologyClass[] = [
  'all-expected-functions-match',
  'no-path',
  'one-sided',
  'on-insulator',
  'wrong-conductor',
  'signal-to-signal-short',
  'signal-to-return-short',
  'ground-open-differential',
  'ground-open-nondifferential',
]

export interface TopologyInput {
  /** 端子 ID → その端子に届いているプラグ導体 */
  terminalToPlugNet: Record<string, PlugNet[]>
  /** 端子 ID → 機器側がその端子に期待する機能 */
  signalRoleMap: Record<string, SignalFunction>
  /**
   * プラグ導体 → その導体が担う機能。
   *
   * **これが無いと分類できない。** 「Ring2 に届いた」だけでは、それが帰線なのか
   * マイクなのか決まらない（CTIA と OMTP で入れ替わる）。オーダーの引数一覧には
   * 挙がっていないが、位置ではなく機能で見るという原則にこれが要る。
   */
  netFunctions: Partial<Record<PlugNet, SignalFunction>>
  contactStates: readonly ContactState[]
  breakStates: readonly (BreakState | null)[]
}

export interface TopologyClassification {
  topologyClass: TopologyClass
  /** なぜその分類になったか。文言ではなく機械可読な符号 */
  reasonCode: string
  lNets: PlugNet[]
  rNets: PlugNet[]
  gndNets: PlugNet[]
  /** L と R が同じ導体に落ちている */
  shortsSignalToSignal: boolean
  /** 帰線用の端子が L / R を担う導体に触れている、または信号が帰線導体に落ちている */
  shortsSignalToReturn: boolean
  /** どこにも届いていない機能 */
  openSignals: SignalFunction[]
  /** 判定の境目に近いか。窓が狭い・接触が不安定なときに立つ */
  confidenceBoundary: boolean
}

/**
 * 純関数。**モデルにも I/O にも依存しない。**
 * 同じ入力からは必ず同じ結果を返す。
 */
export function classifyElectricalTopology(input: TopologyInput): TopologyClassification {
  const { terminalToPlugNet, signalRoleMap, netFunctions, contactStates, breakStates } = input

  const netsFor = (fn: SignalFunction): PlugNet[] => {
    const id = Object.keys(signalRoleMap).find((k) => signalRoleMap[k] === fn)
    return id === undefined ? [] : (terminalToPlugNet[id] ?? [])
  }
  const hasTerminal = (fn: SignalFunction) => Object.values(signalRoleMap).includes(fn)

  const lNets = netsFor('L')
  const rNets = netsFor('R')
  const gndNets = netsFor('GND')
  const micNets = netsFor('MIC')

  /** 届いた導体がちょうど 1 本で、その機能が期待どおり */
  const okFor = (nets: PlugNet[], want: SignalFunction) =>
    nets.length === 1 && netFunctions[nets[0]] === want
  const lOk = okFor(lNets, 'L')
  const rOk = okFor(rNets, 'R')
  const gOk = okFor(gndNets, 'GND')

  const openSignals: SignalFunction[] = []
  for (const [fn, nets] of [
    ['L', lNets],
    ['R', rNets],
    ['GND', gndNets],
    ['MIC', micNets],
  ] as const)
    if (hasTerminal(fn) && nets.length === 0) openSignals.push(fn)

  // --- 短絡の 2 種類を分ける -------------------------------------------------
  // **2026-08-03 まで、どちらも signal-to-return-short にしていた。**
  // L と R が同じ導体に落ちるのは信号どうしの短絡であって、帰線への短絡ではない。
  const shortsSignalToSignal = lNets.length > 0 && rNets.length > 0 && lNets.some((n) => rNets.includes(n))
  const signalOnReturnConductor = [...lNets, ...rNets].some((n) => netFunctions[n] === 'GND')
  const returnOnSignalConductor = gndNets.some((n) => {
    const f = netFunctions[n]
    return f === 'L' || f === 'R'
  })
  const shortsSignalToReturn = signalOnReturnConductor || returnOnSignalConductor

  const unstable = contactStates.includes('TOUCH_UNSTABLE')
  const anyInsulated = contactStates.includes('INSULATED')
  const anyWrong = contactStates.includes('WRONG_SEGMENT')
  const anyBridged = contactStates.includes('BRIDGED')
  const anyConducting = lNets.length + rNets.length + gndNets.length + micNets.length > 0

  const out = (topologyClass: TopologyClass, reasonCode: string): TopologyClassification => ({
    topologyClass,
    reasonCode,
    lNets,
    rNets,
    gndNets,
    shortsSignalToSignal,
    shortsSignalToReturn,
    openSignals,
    // 不安定な接触があるか、ブレーク接点が判定不能なら境目扱い
    confidenceBoundary: unstable || breakStates.includes('UNKNOWN'),
  })

  // --- 分類 ---------------------------------------------------------------
  // 順序に意味がある。**害の大きいものから見る。**
  if (!anyConducting) {
    // 触れてはいるが絶縁帯の上、という状態を「どこにも届かない」と区別する
    if (anyInsulated) return out('on-insulator', 'ALL_CONTACTS_ON_INSULATOR')
    return out('no-path', 'NO_CONDUCTING_PATH')
  }

  if (shortsSignalToSignal) return out('signal-to-signal-short', 'L_AND_R_ON_SAME_CONDUCTOR')
  if (returnOnSignalConductor) return out('signal-to-return-short', 'RETURN_TERMINAL_ON_SIGNAL_CONDUCTOR')
  if (signalOnReturnConductor && !lOk && !rOk) return out('signal-to-return-short', 'SIGNAL_TERMINAL_ON_RETURN_CONDUCTOR')

  // --- 帰線が浮いている ----------------------------------------------------
  if (!gOk && gndNets.length === 0) {
    // **ここが 5 か所に複製されていた判定である。**
    // L と R が別々の導体に 1 本ずつ届いていれば、左右の差分が残りうる。
    if (lNets.length === 1 && rNets.length === 1 && lNets[0] !== rNets[0])
      return out('ground-open-differential', 'RETURN_OPEN_L_AND_R_ON_DISTINCT_CONDUCTORS')
    if (lNets.length > 0 && rNets.length > 0)
      return out('ground-open-nondifferential', 'RETURN_OPEN_BUT_L_AND_R_NOT_DISTINCT')
    return out('no-path', 'RETURN_OPEN_AND_CIRCUIT_NOT_CLOSED')
  }

  // --- 帰線は届いている ----------------------------------------------------
  if (lOk && rOk) {
    if (anyBridged) return out('wrong-conductor', 'CORRECT_PATHS_PLUS_BRIDGE')
    // プラグ側で帰線を担う導体がどの接点にも触れていない (4極 × 3極)
    const gndConductorReached = Object.entries(netFunctions).some(
      ([net, fn]) => fn === 'GND' && Object.values(terminalToPlugNet).some((ns) => ns.includes(net as PlugNet)),
    )
    if (!gndConductorReached && gndNets.some((n) => netFunctions[n] === 'MIC'))
      return out('ground-open-nondifferential', 'RETURN_ROUTED_THROUGH_MIC_ELEMENT')
    if (gOk) return out('all-expected-functions-match', 'ALL_EXPECTED_FUNCTIONS_MATCH')
  }

  if ((lOk && !rOk && gOk) || (!lOk && rOk && gOk)) return out('one-sided', 'ONE_CHANNEL_NOT_REACHED')
  if (anyWrong) return out('wrong-conductor', 'CONTACT_ON_UNEXPECTED_CONDUCTOR')
  if (anyInsulated) return out('on-insulator', 'CONTACT_ON_INSULATOR_BAND')
  return out('wrong-conductor', 'NONSTANDARD_CONNECTION')
}

/**
 * モデルの評価結果から分類する薄い包み。
 *
 * **呼ぶ側が入力を組み立てないようにするため**にある。組み立てを各所へ書かせると、
 * 「signalRole ではなく端子 ID で引く」といった取り違えがまた 5 か所へ散る。
 */
export function classifyFromEvaluation(
  jackTerminals: readonly { id: string; signalRole?: SignalFunction }[],
  netFunctions: Partial<Record<PlugNet, SignalFunction>>,
  ev: {
    contacts: readonly { state: ContactState; breakState: BreakState | null }[]
    circuit: { terminalToPlugNet: Record<string, PlugNet[]> }
  },
): TopologyClassification {
  const signalRoleMap: Record<string, SignalFunction> = {}
  for (const t of jackTerminals) if (t.signalRole) signalRoleMap[t.id] = t.signalRole
  return classifyElectricalTopology({
    terminalToPlugNet: ev.circuit.terminalToPlugNet,
    signalRoleMap,
    netFunctions,
    contactStates: ev.contacts.map((c) => c.state),
    breakStates: ev.contacts.map((c) => c.breakState),
  })
}
