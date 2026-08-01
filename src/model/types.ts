/**
 * 3.5mm TRS プラグ/ジャック 接合機構モデル — 型定義
 *
 * 設計原則:
 *  - 数値は必ず「根拠区分(Grade)」を伴う。裸の number をモデル層に持ち込まない。
 *  - 接触判定は 3D メッシュ名・画面座標・物理エンジンに一切依存しない純粋関数で行う。
 *  - 単位は全て mm / N / 度 (deg)。3D 表示側で必要ならスケールする。
 */

/** 根拠区分。仕様 §3。 */
export type Grade =
  /** 一次資料に直接記載されている */
  | 'FACT'
  /** 一次資料の寸法から幾何学的に導出した */
  | 'DERIVED'
  /** 資料にないため明示的な仮定を置いた */
  | 'ASSUMPTION'
  /** 確認できていない */
  | 'UNKNOWN'

export const GRADE_ORDER: Grade[] = ['FACT', 'DERIVED', 'ASSUMPTION', 'UNKNOWN']

/** 根拠区分つきの寸法エントリ。dimensions.json の 1 行。 */
export interface DimensionEntry {
  /** 値 (mm / N / deg / 無次元) */
  value: number
  /** 単位。省略時 mm */
  unit?: string
  /** 公差 (± value)。分かっている場合のみ。左右対称なものに限る */
  tolerance?: number
  /**
   * 感度解析でこの値を振る範囲 [min, max]。要素は 2 個 (使う側で検査する)。
   *
   * `tolerance` が左右対称の公差しか表せないので、実測のばらつきのように
   * 非対称な幅はこちらに書く。両方ある場合はこちらが優先。
   * 用途は scripts/sensitivity.ts のみで、モデルの計算には入らない。
   */
  sweepRange?: number[]
  grade: Grade
  /** sourceReferences.json の id 配列 */
  sources?: string[]
  /** 導出方法や仮定の理由 */
  note?: string
}

export type DimensionTable = Record<string, DimensionEntry>

/** 寸法キー、または直値。JSON 側でどちらも書けるようにする。 */
export type DimRef = string | number

// ---------------------------------------------------------------------------
// プラグ
// ---------------------------------------------------------------------------

/**
 * プラグ導体の「位置」。機能ではない。
 * TIP=先端, RING=第1リング, RING2=第2リング, SLEEVE=スリーブ。
 */
export type PlugNet = 'TIP' | 'RING' | 'RING2' | 'SLEEVE'

/**
 * 信号としての「機能」。同じ導体位置でも規格 (CTIA / OMTP) で機能が変わるため、
 * 位置と機能を型として分ける。混同すると仕様 §19 に反する。
 */
export type SignalFunction = 'L' | 'R' | 'GND' | 'MIC'

export const SIGNAL_LABEL: Record<SignalFunction, string> = {
  L: '左チャンネル',
  R: '右チャンネル',
  GND: '共通帰線',
  MIC: 'マイク',
}

export type SegmentKind = 'conductor' | 'insulator'

/**
 * プラグ軸方向の 1 区間。
 * 座標 s はプラグ先端 (tip apex) を 0 とし、肩へ向かう向きを + とする [mm]。
 */
export interface PlugSegmentDef {
  id: string
  label: string
  kind: SegmentKind
  /** conductor のときのみ。insulator は undefined */
  net?: PlugNet
  start: DimRef
  end: DimRef
  /** materials.json の id */
  material: string
}

/** 回転体プロファイルの 1 点。s = 先端からの軸方向距離、r = 外半径。 */
export interface RadiusProfilePoint {
  s: DimRef
  r: DimRef
  /** この点が丸め (球面/フィレット) の一部かどうか。表示の分割数決定に使う */
  fillet?: boolean
}

export interface PlugModelDef {
  schemaVersion: number
  variant: 'TRS' | 'TRRS-CTIA' | 'TRRS-OMTP'
  poleCount: number
  partNumber: string
  manufacturer: string
  /** 導体位置 → 信号機能。CTIA と OMTP はここだけが違う。 */
  netFunctions: Partial<Record<PlugNet, SignalFunction>>
  /** 配列の根拠 */
  netFunctionsGrade: Grade
  netFunctionsSources?: string[]
  /** 金属指部の全長 (先端〜肩) */
  fingerLength: DimRef
  /** 指部の呼び径 */
  bodyDiameter: DimRef
  /** 外形プロファイル (指部のみ)。s 昇順 */
  radiusProfile: RadiusProfilePoint[]
  segments: PlugSegmentDef[]
  /** 肩から後ろのハンドル部 (表示専用、接触判定には使わない) */
  handle: {
    shoulderDiameter: DimRef
    shoulderLength: DimRef
    bodyDiameter: DimRef
    bodyLength: DimRef
    strainReliefLength: DimRef
    strainReliefDiameter: DimRef
    cableDiameter: DimRef
    cableLength: DimRef
  }
}

// ---------------------------------------------------------------------------
// ジャック
// ---------------------------------------------------------------------------

/** ブレーク接点 (ノーマルクローズのスイッチ) の定義 */
export interface BreakContactDef {
  id: string
  label: string
  /** ブレーク接点の相手側端子 (信号ばねが無挿入時に触れている端子) */
  terminalId: string
  /** 無挿入時の状態。データシート記載。 */
  normalState: 'closed' | 'open'
  /** 親接点ばねのたわみがこの値を超えるとブレーク接点が開く [mm] */
  openDeflection: DimRef
}

/** ジャック接点ばね 1 本の定義。仕様 §6。 */
export interface JackContactDef {
  id: string
  label: string
  /** この接点が本来触れるべきプラグセグメント id */
  expectedSegment: string
  /** この接点が内部配線でつながっている端子 id */
  terminalId: string
  /** ジャック前面基準面からの軸方向距離 (奥が +) [mm] */
  axialCenter: DimRef
  /** 接触パッドの軸方向有効幅 [mm] */
  padWidth: DimRef
  /** プラグ非挿入時の接触パッド中心半径 [mm]。プラグ半径 1.75 より小さい。 */
  freeRadius: DimRef
  /** 設計上の標準たわみ量 (完全挿入・正常時) [mm] */
  nominalDeflection: DimRef
  /** 機械的に許容される最大たわみ [mm] */
  maxDeflection: DimRef
  /** ばね定数 [N/mm] (半径方向) */
  springRate: DimRef
  /** 円周方向の配置角 [deg]。3D 表示とばね可視化に使う */
  angularPosition: DimRef
  /** 片持ち梁の根元位置 (前面基準、奥が +) [mm]。表示用 */
  rootAxial: DimRef
  /** このばねが駆動するブレーク接点。無い場合 null */
  breakContact: BreakContactDef | null
  grade: Grade
  sources?: string[]
  note?: string
}

/** 端子の役割。回路パネルと音響推定が参照する。 */
export type TerminalRole =
  | 'tip-signal'
  | 'ring-signal'
  | 'ring2-signal'
  | 'sleeve-signal'
  | 'tip-normal'
  | 'ring-normal'

/** ジャック端子 (はんだ付けピン) */
export interface JackTerminalDef {
  id: string
  /** データシート上のピン番号。推測しないこと。不明なら null */
  pin: string | null
  role: TerminalRole
  /**
   * 機器側の配線としてこの端子が担う信号。
   * ブレーク接点端子など信号を担わない端子は undefined。
   */
  signalRole?: SignalFunction
  label: string
  /** TRS 標準機能。Tip=Left, Ring=Right, Sleeve=Common return */
  functionLabel: string
  grade: Grade
  sources?: string[]
  note?: string
}

export interface JackModelDef {
  schemaVersion: number
  partNumber: string
  manufacturer: string
  /** 前面基準面から停止面 (プラグ肩が当たる面) までの距離 [mm] = 完全挿入深度 */
  fullInsertionDepth: DimRef
  /** 挿入口の内径 [mm] */
  entryBoreDiameter: DimRef
  /** 金属ブッシング/入口部の軸方向長さ [mm] */
  entryBushingLength: DimRef
  /** 前面基準面から絶縁ハウジング前面までの距離 (ローレットナットの突き出し長) [mm] */
  noseLength: DimRef
  /** ローレットナットの外径 [mm] */
  nutDiameter: DimRef
  /** 外装ハウジング寸法 (表示用) */
  housing: {
    width: DimRef
    height: DimRef
    depth: DimRef
    /** 基板面から軸中心までの高さ (アングル型) */
    axisHeightFromPcb: DimRef
  }
  contacts: JackContactDef[]
  terminals: JackTerminalDef[]
}

// ---------------------------------------------------------------------------
// 故障プリセット
// ---------------------------------------------------------------------------

/**
 * 故障は正常モデルを書き換えず、パラメータとして重ねる。仕様 §12。
 */
export interface FaultParams {
  /** 汚れ・酸化係数 0(清浄) 〜 1(絶縁膜で完全に導通不能) */
  contamination: number
  /** 接点摩耗 0(新品) 〜 1。freeRadius が広がり押付が落ちる */
  wear: number
  /** 軸ずれ (半径方向のオフセット) [mm] */
  lateralOffsetMm: number
  /** 傾き [deg] */
  tiltDeg: number
  /** ばね押付倍率。1 = 公称、0.3 = 押付不足 */
  springForceScale: number
  /** 断続接触を有効にする */
  intermittent: boolean
  /** 断続接触の乱数シード (再現可能) */
  seed: number
  /** 断続接触の強さ 0-1 */
  intermittentAmplitude: number
  /** プラグの軸回転 [deg]。理想同心接点では影響なし。汚れ/摩耗時のみ効く。 */
  rotationDeg: number
}

export interface FaultPreset {
  id: string
  label: string
  description: string
  /** 適用する挿入深度 [mm]。null なら現在深度を変えない */
  depthMm: number | null
  params: Partial<FaultParams>
}

// ---------------------------------------------------------------------------
// 接触判定の出力
// ---------------------------------------------------------------------------

/** 接触状態。仕様 §6。 */
export type ContactState =
  | 'OPEN'
  | 'INSULATED'
  | 'TOUCH_UNSTABLE'
  | 'CLOSED'
  | 'WRONG_SEGMENT'
  | 'BRIDGED'
  | 'UNKNOWN'

export type BreakState = 'BREAK_CLOSED' | 'BREAK_OPEN' | 'UNKNOWN'

/** 1 接点 × 1 セグメントの重なり */
export interface SegmentOverlap {
  segmentId: string
  segmentLabel: string
  kind: SegmentKind
  net?: PlugNet
  /**
   * 導通判定に使う重なり幅 [mm]。
   * 接点が押し開かれた位置から contactComplianceMm 以内にある面だけを数える。
   */
  widthMm: number
  /**
   * パッドがこのセグメントに噛み合っている幅 [mm]。
   * 押し開かれる前の自由半径で見た幅で、品質スコアと画面表示はこちらを使う。
   * 平坦面の上では widthMm と一致し、傾斜面の上では widthMm より広くなる。
   */
  engagedWidthMm: number
  /** パッド幅に対する噛み合いの比 0-1 (engagedWidthMm / padWidthMm) */
  fraction: number
}

/** 1 接点の判定結果 */
export interface ContactResult {
  contactId: string
  label: string
  terminalId: string
  expectedSegment: string
  state: ContactState
  /** 機械的に触れているか (半径方向に干渉しているか) */
  physicallyTouching: boolean
  /** ばねのたわみ [mm] */
  deflectionMm: number
  /** 半径方向の押付力 [N] */
  normalForceN: number
  /** 各セグメントとの重なり (幅 > 0 のみ) */
  overlaps: SegmentOverlap[]
  /** 導通していると判定したプラグネット (複数なら橋絡) */
  connectedNets: PlugNet[]
  /** 接触品質スコア 0-1。仕様 §7。 */
  quality: number
  /** ブレーク接点の状態 */
  breakState: BreakState | null
  breakContactId: string | null
  /** 機械的許容たわみを超えているか */
  overDeflected: boolean
  /** この接点に実際に適用された汚れ係数 (回転角により変わる) */
  contaminationApplied: number
  /** 接点パッド中心が対応するプラグ座標 s [mm]。デバッグ・表示用 */
  padCenterSMm: number
  /** 判定の根拠区分。入力寸法の最低グレードが伝播する */
  grade: Grade
  /** 人間向けの一言説明 */
  reason: string
}

/** 回路の 1 本の接続 */
export interface CircuitEdge {
  from: string
  to: string
  kind: 'contact' | 'internal-wire' | 'break-switch' | 'bridge'
  state: ContactState | BreakState
  quality?: number
}

export interface CircuitNet {
  /** 同電位のノード集合 */
  nodes: string[]
}

export interface CircuitResult {
  edges: CircuitEdge[]
  nets: CircuitNet[]
  /** 「Jack Tip terminal → Plug Ring」のような人間可読の行 */
  lines: string[]
  /** 端子 → 実際につながっているプラグネット */
  terminalToPlugNet: Record<string, PlugNet[]>
}

/** 音響上の予測 (簡易推定)。仕様 §14。 */
export interface AcousticPrediction {
  code:
    | 'NORMAL'
    | 'LEFT_ONLY'
    | 'RIGHT_ONLY'
    | 'GROUND_OPEN'
    | 'LR_SHORTED'
    | 'DIFFERENCE_SIGNAL'
    | 'MONO'
    | 'SILENT'
    | 'INTERMITTENT'
    | 'UNKNOWN'
  label: string
  detail: string
  severity: 'ok' | 'warn' | 'bad'
}

/** 1 フレーム分の完全な評価結果 */
export interface EvaluationResult {
  depthMm: number
  depthPercent: number
  contacts: ContactResult[]
  circuit: CircuitResult
  acoustic: AcousticPrediction
  /** 推定挿抜力 [N]。実測値ではない。 */
  estimatedForceN: number
  /** 橋絡が 1 つでもあるか */
  anyBridged: boolean
  /** 誤セグメント接触があるか */
  anyWrongSegment: boolean
  /** 不安定接触があるか */
  anyUnstable: boolean
}

// ---------------------------------------------------------------------------
// イベント
// ---------------------------------------------------------------------------

export type EventKind =
  | 'FIRST_PHYSICAL_CONTACT'
  | 'FIRST_ELECTRICAL_CONTACT'
  | 'FIRST_BREAK_OPEN'
  | 'FIRST_WRONG_SEGMENT'
  | 'FIRST_BRIDGE'
  | 'ALL_SIGNALS_CORRECT'
  | 'FULL_INSERTION'
  | 'LAST_CONTACT_RELEASE'
  | 'STATE_CHANGE'

export interface InsertionEvent {
  kind: EventKind
  depthMm: number
  label: string
  detail: string
  severity: 'info' | 'ok' | 'warn' | 'bad'
}

// ---------------------------------------------------------------------------
// 資料参照
// ---------------------------------------------------------------------------

export interface SourceReference {
  id: string
  title: string
  publisher: string
  partNumber?: string
  docDate?: string
  url?: string
  accessed?: string
  reliability: 'standard' | 'manufacturer' | 'manufacturer-tech' | 'distributor' | 'secondary'
  /** 図面/CAD/画像の利用条件 */
  usageTerms?: string
  /** どの部分に使ったか */
  usedFor?: string
  /** 本文を実際に取得できたか */
  fetchStatus?: 'full-text-read' | 'partial' | 'blocked' | 'not-attempted'
}

export interface MaterialDef {
  id: string
  label: string
  /** 表示色 (hex) */
  color: string
  metalness: number
  roughness: number
  /** 導体か */
  conductive: boolean
  /** 実材料名 */
  spec?: string
  grade: Grade
  sources?: string[]
}
