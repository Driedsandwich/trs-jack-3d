# Half-Plug Lab へ渡すもの — adapter 仕様

> この文書の HTML 版（同名 `.html`）は `npm run docs:html` で生成しています。**HTML を直接編集しないでください。**

作成 2026-08-02 ／ 対象 `Half-Plug Topology Profile v1`

統合オーダー §4 が Half-Plug 側へ求めている `integrations/trs-jack-3d/` の
初期マッピングを、**現在のコード体系で**書き起こしたものです。

このリポジトリは Half-Plug Lab 側を持っていないので、ここに置いた仕様を
向こうで実装してもらう形になります。

---

## 0. 先に — この profile は DSP 係数ではありません

渡しているのは「**どの端子がどの導体につながっているか**」という電気的な接続だけです。
音に関する項目（`acousticAnnotation`）は**参考分類**であって、
フィルタ係数でもゲインでもクロストーク量でもありません。

**やってはいけない変換**（統合オーダー §2 の禁止事項）:

| してはいけないこと | なぜ |
|---|---|
| `topologyClass` を係数へ直接写像する | 分類であって量ではない |
| `quality` を接触抵抗 Ω やゲインへ換算する | 相対スコアで、Ω に換算していない（profile に含めてもいません） |
| 1 機種の `nominalStartMm` を一般的な「挿入深度」として使う | `normalized` を併記しているのでそちらを使う |
| **`ground-open-differential` を自動的に L−R 係数へ変換する** | §2 を参照 |
| 未実測なのに「実物と同じ」と表示する | 全 profile が `verifiedPhysical: false` |

---

## 1. 渡す profile は 2 つあります

| ファイル | 中身 | 左右差分 |
|---|---|---|
| `half_plug_topology_profile.v1.trs_jack_trs.json` | 3極プラグ × 3極ジャック（Lumberg 実部品） | **現れない** |
| `half_plug_topology_profile.v1.trs_jack_trrs.json` | 3極プラグ × **4極ジャック** | **現れる**（`IV019` / 12.90〜13.12 mm） |

**再現したい音が出るのは後者だけです。**前者は「出ない」ことを
`absentTopologies` に記録した反証として持っています。

```bash
npm run export:half-plug -- --variant "TRS|JACK-TRRS"
```

---

## 2. 初期マッピング

**1 対 1 ではありません。**同じ `topologyClass` でも、`stabilityOverlay` と
`electricalRisk` の組み合わせで扱いが変わります。

| profile の `topologyClass` | Half-Plug の状態 | 備考 |
|---|---|---|
| `fully-seated` | Normal / seated | 通常再生 |
| `no-path` | Silent | 導通経路が無い |
| `one-sided` | One-sided contact | 片チャンネルのみ |
| **`ground-open-differential`** | **Floating return（本命）** | **§2-1 を必ず読むこと** |
| `ground-open-nondifferential` | Silent 相当 | 帰線が浮くが左右が同一節点。差分は生じない |
| `signal-to-return-short` | Miscontact / protection-dependent | **過渡音を作らないこと**（§2-2） |
| `on-insulator` | Open / fragmented | 絶縁帯上 |
| `wrong-conductor` | Miscontact | 誤った導体 |

`stabilityOverlay: "intermittent"` は**基底トポロジーと直交する重ね合わせ**です。
状態を別物に置き換えるのではなく、その状態の上に不安定性を乗せてください。

### 2-1. `ground-open-differential` を自動で L−R 係数にしないでください

この状態は「帰線が浮き、L と R が別々の導体に届いている」という**電気的な接続の記述**です。
そこから何 dB 落ちて、どういう周波数特性になるかは、**このモデルは一切計算していません**。

- ドライバのインピーダンス、アンプの出力段、保護回路のどれもモデル化していません
- `audibleHypothesis`（「音量が落ち、左右の差分成分が残る」）は
  **回路構成からの定性的な推測**であって、実測ではありません
- `confidence: "low"` が付いています

3 帯域行列や 4 経路 FIR は、**実測 profile ID を介して別管理**してください
（統合オーダー §4）。トポロジーはどの実測 profile を選ぶかの**索引**であって、
係数そのものではありません。

### 2-2. `signal-to-return-short` で過渡音を作らないでください

電気的には出力短絡に近い状態で、実機の挙動はアンプの保護動作に依存します。
`electricalRisk: "short-circuit"` が付いており、`audibleHypothesis` は **`null`** です
（断定できないので空にしてあります）。

安全な DSP 表現（減衰・mono 化・mute など）へ写像し、
**クラックルやポップのような過渡音を生成しないでください。**

---

## 3. 本命の区間

`half_plug_topology_profile.v1.trs_jack_trrs.json` の `IV019`:

```
nominalStartMm  12.90      normalizedStart  0.9214
nominalEndMm    13.12      normalizedEnd    0.9371
topologyClass   ground-open-differential
evidenceGrade   ASSUMPTION
safetyFlags     shortsSignalToReturn: false / shortsSignalToSignal: false
```

端子の状態:

| 端子 | 届いている導体 |
|---|---|
| L | Tip |
| R | Ring |
| **GND** | **なし（浮いている）** |

4極ジャックの帰線接点が、3極プラグの絶縁帯にちょうど落ちるためです。

### この区間の根拠は弱いです

**4極ジャックの接点位置は一次資料がなく、4 件とも仮定です**
（[UNKNOWNS.md](../UNKNOWNS.md) §5-2）。したがって:

- **現象が起きること**は仮定の振り方に対して頑健です
  （完全挿入が壊れない 432 構成のうち 162 件 = 38 % で成立）
- **深さ 12.90〜13.12 mm という数字**は、仮定した接点位置に完全に依存します

`normalized`（0.9214〜0.9371）で扱うほうが、機種差に対しては幾分ましですが、
**それも同じ仮定の上に乗っています。**

---

## 4. プリセットへ持たせるメタデータ

統合オーダー §4 のとおり、Half-Plug 側のプリセットには次を持たせてください。

```
mechanismProfileRef      どの profile ファイルか
topologyIntervalId       IV019 など
geometryRevision         profile の sourceRevision
calibrationProfileId     実測した音響 profile（別管理）
evidenceGrade            profile の interval から引き継ぐ
physicalClaimStatus      未実測なら "unverified"
```

**`evidenceGrade` と `physicalClaimStatus` を落とさないでください。**
落とすと、UI で「実物と同じ」と読める表示になってしまいます。

---

## 5. 深さの窓が 0.2 mm しかない件

本命の区間は **0.22 mm 幅**で、挿入ストローク 14 mm の **1.6 %** です。

**これは Half-Plug 側で解くべき課題であって、機構の問題ではありません。**
Half-Plug は音を DSP で再現するものなので、プラグを物理的にその深さで
保持する必要はありません。深さは UI 上のパラメータです。

したがって扱いは次のようになります。

| | |
|---|---|
| ❌ しなくてよい | プラグを 0.2 mm 精度で保持する機構を作る |
| ✅ すべきこと | **区間を直接選べるようにする**（連続スライダーだけにしない） |

連続スライダーだけを置くと、**ストロークの 1.6 % を狙って合わせる操作**になり、
本命の状態にほとんど当たりません。`intervals[]` は区間の列なので、
**区間そのものを選択肢として提示する**のが素直です。

> 物理的に再現しようとする場合は別の話で、0.2 mm を保つのは容易ではありません。
> ただしその場合、4極ジャックの接点位置が仮定である以上、
> **狙うべき深さがそもそも分かりません。**先に実測が要ります
> （[VERIFICATION_PLAN.md](VERIFICATION_PLAN.md)）。

---

## 6. 受け取り側で必ず確認してほしいこと

- [ ] `modelLimitations.verifiedPhysical` が `false` であること（現状すべて false）
- [ ] `dataLicense.attribution` を表示または同梱すること（CC BY 4.0）
- [ ] `sourceRevision` を固定して参照すること（`main` を追わない）
- [ ] `schemaVersion` が 1 であること。破壊的変更は v2 へ上げます
- [ ] `absentTopologies.absent` を読み、**無い状態を UI に足さないこと**
