/**
 * release asset の一覧。**ここが唯一の正本。**
 *
 * ## なぜ 1 か所に固めたか（非阻害フォローアップ P2-7）
 *
 * v0.1.1 では、この一覧がどこにも無く、その場で選んで並べた。
 * その結果 **`event-sensitivity` schema を入れ忘れ**、受け手は感度 artifact を
 * 検証する手立てが無いまま独自に構造検査を書くことになった。
 * 「毎回思い出す」に頼る設計は、いつか必ず落とす。
 *
 * ## 何を入れるか
 *
 * **受け手がこの配布物だけで検証を完結できること**を基準にする。
 * artifact だけ渡して schema を渡さなければ、受け手は形を確かめられない。
 * 検証結果と入力一覧を渡さなければ、「こちらでは通っている」を確かめられない。
 */

export const RELEASE_ASSETS = [
  // --- 本体 ---
  { path: 'artifacts/half_plug_topology_profile.v2.trs_jack_trs.json', role: 'profile' },
  { path: 'artifacts/half_plug_topology_profile.v2.trs_jack_trrs.json', role: 'profile' },
  { path: 'artifacts/sensitivity.trs_jack_trs.json', role: 'sensitivity' },
  { path: 'artifacts/sensitivity.trs_jack_trrs.json', role: 'sensitivity' },
  { path: 'artifacts/topology-robustness.trs_jack_trrs.json', role: 'robustness' },

  // --- 受け手が検証するための schema ---
  { path: 'schemas/half-plug-topology-profile.v2.schema.json', role: 'schema' },
  { path: 'schemas/event-sensitivity.v1.schema.json', role: 'schema' },
  { path: 'schemas/topology-robustness.v2.schema.json', role: 'schema' },
  { path: 'schemas/trs-jack-3d-release-index.v1.schema.json', role: 'schema' },
  { path: 'schemas/validation-results.v1.schema.json', role: 'schema' },
  { path: 'schemas/source-input-manifest.v1.schema.json', role: 'schema' },
  { path: 'schemas/topology-search.v1.schema.json', role: 'schema' },
  { path: 'schemas/real-jack-comparison.v1.schema.json', role: 'schema' },
  { path: 'schemas/test-counts.v1.schema.json', role: 'schema' },

  // --- 自己完結性のための証拠（P2-7）---
  { path: 'artifacts/test_counts.json', role: 'evidence' },
  { path: 'artifacts/validation-results.json', role: 'evidence' },
  { path: 'artifacts/source-input-manifest.json', role: 'evidence' },
  // **索引。**下流が報告文から値を手で転記しなくて済むようにする（v0.2.0 では手入力だった）
  { path: 'artifacts/trs-jack-3d-release-index.v1.json', role: 'index' },
]

/**
 * v0.1.1 の release に入っていたが v0.2.0 では入れないもの。
 * **消えた理由を書く。**黙って消えると「落とした」のか「意図」なのか分からない。
 */
/**
 * **配布しない検証対象。**`validate:profiles` は 9 件を見るが、そのうち 2 件は bundle に入らない。
 *
 * 受け手が「9 件すべてを bundle だけで独立再検証できる」と読まないよう、
 * `validation-results.json` の各 target へ `distribution` を持たせている（v0.2.0 フォローアップ §3）。
 * ここに並ぶのは runtime 入力ではない成果物で、配布しても受け手の役に立たない。
 */
export const SOURCE_ONLY_TARGETS = [
  { path: 'artifacts/topology_search_difference_signal.json', reason: '目標トポロジーの探索記録。runtime 入力ではない' },
  { path: 'artifacts/real_jack_comparison.json', reason: '実在部品図面との突き合わせ記録。runtime 入力ではない' },
]

export const REMOVED_SINCE_V011 = [
  {
    path: 'half-plug-topology-profile.v1.schema.json',
    reason: 'v2 へ置き換えた。v1 schema は v0.1.1 の asset として immutable に残っている',
  },
  {
    path: 'half_plug_topology_profile.v1.trs_jack_trs.json',
    reason: 'ファイル名は契約の一部（下流の lock が filename で引く）なので、schemaVersion と一緒に v2 へ移した',
  },
  {
    path: 'half_plug_topology_profile.v1.trs_jack_trrs.json',
    reason: '同上',
  },
]
