/** 自己申告 artifact の schema が書ける status（enum をそのまま返す） */
export declare function expressibleStatuses(root?: string): string[]
/** 書けない status なら投げる。**戻り値で可否を返さない**（見落とすと丸めた値が出荷される） */
export declare function assertExpressibleInSelfReport(status: string, root?: string): string
