/**
 * 3D 内テキスト用のフォント。
 *
 * drei の <Text> は内部で troika-three-text を使う。font を指定しないと、
 * troika は実行時に cdn.jsdelivr.net からフォントを取りに行く
 * (日本語ラベルがあるため CJK サブセットまで引かれ、実測で 17 リクエスト)。
 * 外部へ通信させないため、必要な字だけを切り出したフォントを同梱して明示的に渡す。
 *
 * 同梱フォントの出所と再生成手順は public/fonts/README.md を見ること。
 * ラベルに新しい字を足したら、フォントを作り直さないとその字は表示されない。
 */
export const LABEL_FONT = `${import.meta.env.BASE_URL}fonts/NotoSansJP-Subset.ttf`
