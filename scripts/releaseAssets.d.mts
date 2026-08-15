/** scripts/releaseAssets.mjs の型。実体は .mjs 側にある（正本は 1 つ） */
export declare const RELEASE_ASSETS: readonly { path: string; role: string }[]
export declare const REMOVED_SINCE_V011: readonly { path: string; reason: string }[]
/** 受け手が必ず lock すべき配布物の filename（v0.6.17・RELEASE_ASSETS から導出） */
export declare const REQUIRED_CONSUMER_PINS: readonly string[]
export declare const SOURCE_ONLY_TARGETS: readonly { path: string; reason: string }[]
