/**
 * 接触判定の結果から電気的な接続グラフを組み立てる。仕様 §10。
 * さらに、その接続から音響上の予測を導く。仕様 §14。
 *
 * 「どの接点がどのセグメントに触れたか」だけでは回路にならない。
 * 端子 ↔ 接点ばね ↔ プラグ導体 を 1 つのグラフにして連結成分を取る。
 */

import type {
  AcousticPrediction,
  CircuitEdge,
  CircuitResult,
  ContactResult,
  ContactState,
  PlugNet,
  SignalFunction,
} from './types'
import type { ResolvedJack, ResolvedPlug } from './resolve'

/** この状態なら電流が流れているとみなす */
const CONDUCTING: ContactState[] = ['CLOSED', 'TOUCH_UNSTABLE', 'WRONG_SEGMENT', 'BRIDGED']

export const plugNode = (net: PlugNet) => `PLUG:${net}`
export const termNode = (id: string) => `TERM:${id}`
export const springNode = (id: string) => `SPRING:${id}`

class UnionFind {
  private parent = new Map<string, string>()
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x)
    let root = this.parent.get(x)!
    while (root !== this.parent.get(root)) root = this.parent.get(root)!
    // 経路圧縮
    let cur = x
    while (cur !== root) {
      const next = this.parent.get(cur)!
      this.parent.set(cur, root)
      cur = next
    }
    return root
  }
  union(a: string, b: string) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
  groups(): Map<string, string[]> {
    const g = new Map<string, string[]>()
    for (const k of this.parent.keys()) {
      const r = this.find(k)
      if (!g.has(r)) g.set(r, [])
      g.get(r)!.push(k)
    }
    return g
  }
}

const netLabel: Record<PlugNet, string> = {
  TIP: 'Plug Tip',
  RING: 'Plug Ring',
  RING2: 'Plug Ring 2',
  SLEEVE: 'Plug Sleeve',
}

export function buildCircuit(jack: ResolvedJack, contacts: ContactResult[]): CircuitResult {
  const uf = new UnionFind()
  const edges: CircuitEdge[] = []

  const terminalById = new Map(jack.terminals.map((t) => [t.id, t]))

  for (const t of jack.terminals) uf.find(termNode(t.id))

  for (const c of contacts) {
    const sp = springNode(c.contactId)
    uf.find(sp)

    // 接点ばね ↔ その端子 (内部配線。常に導通)
    edges.push({ from: sp, to: termNode(c.terminalId), kind: 'internal-wire', state: 'CLOSED' })
    uf.union(sp, termNode(c.terminalId))

    // 接点ばね ↔ プラグ導体
    if (CONDUCTING.includes(c.state)) {
      for (const net of c.connectedNets) {
        edges.push({
          from: sp,
          to: plugNode(net),
          kind: c.state === 'BRIDGED' ? 'bridge' : 'contact',
          state: c.state,
          quality: c.quality,
        })
        uf.union(sp, plugNode(net))
      }
    }

    // ブレーク接点
    if (c.breakContactId && c.breakState) {
      const def = jack.contacts.find((jc) => jc.id === c.contactId)?.breakContact
      if (def) {
        const closed = c.breakState === 'BREAK_CLOSED'
        edges.push({
          from: sp,
          to: termNode(def.terminalId),
          kind: 'break-switch',
          state: c.breakState,
        })
        if (closed) uf.union(sp, termNode(def.terminalId))
      }
    }
  }

  const groups = [...uf.groups().values()].map((nodes) => ({ nodes: nodes.sort() }))

  // 端子 → 実際に到達できるプラグ導体
  const terminalToPlugNet: Record<string, PlugNet[]> = {}
  for (const t of jack.terminals) {
    const root = uf.find(termNode(t.id))
    const nets: PlugNet[] = []
    for (const g of groups) {
      if (uf.find(g.nodes[0]) !== root) continue
      for (const n of g.nodes) {
        if (n.startsWith('PLUG:')) nets.push(n.slice(5) as PlugNet)
      }
    }
    terminalToPlugNet[t.id] = [...new Set(nets)]
  }

  // 人間可読の行
  const lines: string[] = []
  for (const t of jack.terminals) {
    const nets = terminalToPlugNet[t.id]
    const pin = t.pin ? `pin ${t.pin}` : 'pin 不明'
    if (nets.length === 0) {
      lines.push(`${t.label} (${pin}) → 未接続`)
    } else {
      lines.push(`${t.label} (${pin}) → ${nets.map((n) => netLabel[n]).join(' + ')}`)
    }
  }
  // プラグ導体どうしの橋絡
  const allNets: PlugNet[] = ['TIP', 'RING', 'RING2', 'SLEEVE']
  for (let i = 0; i < allNets.length; i++) {
    for (let j = i + 1; j < allNets.length; j++) {
      const a = plugNode(allNets[i])
      const b = plugNode(allNets[j])
      const has = (n: string) => groups.some((g) => g.nodes.includes(n))
      if (has(a) && has(b) && uf.find(a) === uf.find(b)) {
        lines.push(`${netLabel[allNets[i]]} ↔ ${netLabel[allNets[j]]} 橋絡`)
      }
    }
  }
  // ブレーク接点の開閉
  for (const c of contacts) {
    if (c.breakState) {
      const def = jack.contacts.find((jc) => jc.id === c.contactId)?.breakContact
      const term = def ? terminalById.get(def.terminalId) : undefined
      const pin = term?.pin ? ` (pin ${term.pin})` : ''
      lines.push(
        `${def?.label ?? c.breakContactId}${pin}: ${c.breakState === 'BREAK_OPEN' ? 'OPEN' : 'CLOSED'}`,
      )
    }
  }

  return { edges, nets: groups, lines, terminalToPlugNet }
}

// ---------------------------------------------------------------------------
// 音響予測 (仕様 §14)
// ---------------------------------------------------------------------------

/**
 * 接続グラフから、聴感上どうなるかを推定する。
 * これは回路接続からの簡易推定であり、特定製品の実際の音を保証するものではない。
 *
 * 「導体位置」ではなく「信号機能」で判定するため、CTIA / OMTP / 3極を混ぜても
 * 同じロジックで扱える。機器側 (ジャック端子) が期待する機能と、
 * 実際に届いたプラグ導体が担う機能を突き合わせる。
 */
export function predictAcoustic(
  jack: ResolvedJack,
  plug: ResolvedPlug,
  contacts: ContactResult[],
  circuit: CircuitResult,
): AcousticPrediction {
  const termFor = (fn: SignalFunction) => jack.terminals.find((t) => t.signalRole === fn)
  const reach = (id: string | undefined): PlugNet[] => (id ? circuit.terminalToPlugNet[id] ?? [] : [])

  /** その端子に届いているプラグ導体が担う機能の集合 */
  const fnOf = (nets: PlugNet[]): SignalFunction[] =>
    [...new Set(nets.map((n) => plug.netFunctions[n]).filter((f): f is SignalFunction => !!f))]

  const lNets = reach(termFor('L')?.id)
  const rNets = reach(termFor('R')?.id)
  const gNets = reach(termFor('GND')?.id)
  const micT = termFor('MIC')
  const micNets = reach(micT?.id)

  // 「正しく届いている」= 届いた導体がちょうど 1 つで、その機能が期待どおり
  const okFor = (nets: PlugNet[], want: SignalFunction) =>
    nets.length === 1 && plug.netFunctions[nets[0]] === want
  const lOk = okFor(lNets, 'L')
  const rOk = okFor(rNets, 'R')
  const gOk = okFor(gNets, 'GND')

  const anyConnection = lNets.length + rNets.length + gNets.length > 0
  const lrShorted =
    lNets.length > 0 && rNets.length > 0 && lNets.some((n) => rNets.includes(n))
  const unstable = contacts.some((c) => c.state === 'TOUCH_UNSTABLE')

  const mk = (
    code: AcousticPrediction['code'],
    label: string,
    detail: string,
    severity: AcousticPrediction['severity'],
  ): AcousticPrediction => ({
    code,
    label,
    detail: unstable ? `${detail} / 接触が不安定なため断続的なノイズが乗り得る` : detail,
    severity,
  })

  if (!anyConnection) {
    return mk('SILENT', '無音', 'ジャック端子とプラグ導体がどこも導通していない', 'bad')
  }

  if (!gOk && gNets.length === 0) {
    // 帰線が浮いている。ここから先は **左右が別々の導体に届いているか** で分ける。
    //
    // 2026-08-02 まで、この 2 つを区別せず GROUND_OPEN にまとめていた。
    // しかも判定が lrShorted より先にあるため、**左右が同じ導体に落ちていても
    // 「左右差分が残る」と表示していた。** 実際にはその場合、両チャンネルが
    // 同じ節点に落ちて差分は生じない。構成探索で 318 件中 78 件しか
    // 本当の差分信号でなかったことから見つかった。
    if (lNets.length === 1 && rNets.length === 1 && lNets[0] !== rNets[0]) {
      return mk(
        'DIFFERENCE_SIGNAL',
        '共通帰線断 (左右差分が残る)',
        '帰線がプラグ Sleeve に届いていない。左右のドライバが直列になり、' +
          '音量が大きく落ちたうえで左右の差分成分だけが聞こえる状態になり得る',
        'bad',
      )
    }
    if (lNets.length > 0 && rNets.length > 0) {
      return mk(
        'GROUND_OPEN',
        '共通帰線断 (差分にはならない)',
        '帰線が届いていないうえ、左右が同じ導体に落ちている。' +
          '両チャンネルが同じ節点になるため差分は生じず、ほぼ無音になる',
        'bad',
      )
    }
    return mk('SILENT', '無音または極小音', '共通帰線が接続されていないため、回路が閉じない', 'bad')
  }

  if (lrShorted) {
    return mk(
      'LR_SHORTED',
      '左右短絡',
      `左右が同じ導体 (${lNets.filter((n) => rNets.includes(n)).join(', ')}) に落ちている。` +
        'モノラル化するか、アンプによっては保護動作で無音になり得る',
      'bad',
    )
  }

  // --- 左右が正しくつながっているケースを、帰線／マイクの状況で細分する ---
  if (lOk && rOk) {
    const bridged = contacts.some((c) => c.state === 'BRIDGED')
    if (bridged) {
      return mk('UNKNOWN', '接続は成立しているが橋絡あり', '正規接続に加えて余分な短絡がある', 'warn')
    }

    const gndReachesMic = gNets.some((n) => plug.netFunctions[n] === 'MIC')
    const micReachesGnd = micNets.some((n) => plug.netFunctions[n] === 'GND')

    // CTIA と OMTP の食い違い: 帰線とマイクが入れ替わっている
    if (gndReachesMic && micReachesGnd) {
      return mk(
        'UNKNOWN',
        '規格違い (CTIA ↔ OMTP)',
        'ステレオ再生はできるが、機器が帰線だと思っている端子にプラグのマイク線が、' +
          'マイクだと思っている端子に帰線が来ている。マイクは働かず、ボタン操作も検出されない',
        'warn',
      )
    }

    // 4極プラグ × 3極ジャック: 機器の帰線端子にプラグのマイク線が当たっている。
    //
    // このとき、プラグ側で帰線 (GND) を担う導体がどこにも触れていないことがある。
    // ドライバの帰り道が機器のグランドへ直接つながらないので、「左右の音は正常」とは
    // 言えない。位置ではなく機能で見る (この関数の設計原則) と、これは帰線断の一種。
    if (gndReachesMic && !micT) {
      const gndConductorReached = Object.entries(plug.netFunctions).some(
        ([net, fn]) =>
          fn === 'GND' &&
          Object.values(circuit.terminalToPlugNet).some((nets) => nets.includes(net as PlugNet)),
      )
      if (!gndConductorReached) {
        return mk(
          'GROUND_OPEN',
          '帰線がマイク線経由になる (音量が大きく落ちる)',
          '4極プラグを3極ジャックへ挿した状態。左右の信号は正しい導体に届いているが、' +
            'プラグ側で帰線を担う導体 (Ring2) がどの接点にも触れていない。' +
            'ドライバの帰り道はヘッドセット内部のマイク素子を経由することになり、' +
            'マイクの直流抵抗 (数 kΩ) がドライバ (16〜32 Ω) と直列に入るため音量が大きく落ちる。' +
            'マイクも働かない。※実機はこの状態を検出して内部で結線を切り替えることがある',
          'bad',
        )
      }
      return mk(
        'NORMAL',
        'ステレオ再生は正常 / マイクは機能しない',
        '4極プラグを3極ジャックへ挿した状態。帰線は正しく届いているが、' +
          'プラグのマイク線がジャックの帰線接点に当たって短絡するため、マイクは働かない',
        'warn',
      )
    }

    if (gOk) {
      if (micT && !okFor(micNets, 'MIC')) {
        return mk(
          'NORMAL',
          'ステレオ再生は正常 / マイク未接続',
          '機器側はマイク端子を持つが、挿さっているプラグにマイク導体が無いか届いていない',
          'warn',
        )
      }
      const withMic = !!micT && okFor(micNets, 'MIC')
      return mk(
        'NORMAL',
        withMic ? '正常 (ステレオ + マイク)' : '正常 (ステレオ)',
        '機器が期待する信号と、実際に届いているプラグ導体の機能が一致している',
        'ok',
      )
    }
  }

  if (lOk && !rOk && gOk) {
    return mk('LEFT_ONLY', '左のみ', '右チャンネルの接点が Ring に届いていない', 'warn')
  }
  if (!lOk && rOk && gOk) {
    return mk('RIGHT_ONLY', '右のみ', '左チャンネルの接点が Tip に届いていない', 'warn')
  }

  // 帰線が音声信号の導体につながっている (挿入途中に頻発する。最も害が大きい)
  const gndOnSignal = gNets.filter((n) => {
    const f = plug.netFunctions[n]
    return f === 'L' || f === 'R'
  })
  if (gndOnSignal.length > 0) {
    const wrong = gndOnSignal
    return mk(
      'LR_SHORTED',
      `帰線が信号導体 (${wrong.join(', ')}) に接触`,
      '共通帰線用の接点が、本来の Sleeve ではなく信号側の導体に触れている。' +
        'そのチャンネルの出力が帰線に落ちるため、アンプにとっては出力短絡に近い状態になる',
      'bad',
    )
  }

  // 誤セグメント接続 (例: Tip 用接点が Sleeve に触れている)
  const desc: string[] = []
  if (lNets.length === 0) desc.push('左: 未接続')
  else desc.push(`左: ${lNets.join('+')} に接続`)
  if (rNets.length === 0) desc.push('右: 未接続')
  else desc.push(`右: ${rNets.join('+')} に接続`)
  if (gNets.length === 0) desc.push('帰線: 未接続')
  else desc.push(`帰線: ${gNets.join('+')} に接続`)

  const lGrounded = fnOf(lNets).includes('GND')
  const rGrounded = fnOf(rNets).includes('GND')
  if (lGrounded && rGrounded) {
    return mk('SILENT', '両チャンネルが帰線に落ちている', desc.join(' / '), 'bad')
  }
  if (lGrounded) return mk('RIGHT_ONLY', '左が帰線に短絡 (右のみ)', desc.join(' / '), 'bad')
  if (rGrounded) return mk('LEFT_ONLY', '右が帰線に短絡 (左のみ)', desc.join(' / '), 'bad')

  return mk('UNKNOWN', '非標準の接続', desc.join(' / '), 'warn')
}
