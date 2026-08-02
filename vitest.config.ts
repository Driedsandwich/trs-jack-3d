import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    reporters: ['default'],
    /**
     * **既定の 5 秒では足りない。**
     *
     * 2026-08-03、`test/trrs.test.ts` の「どの組み合わせでも、Tip 導体を含む橋絡は
     * 起きない」が **3 回に 1 回落ちる**状態になった。
     * 単独で回すと 606ms、全体で回すと 5463ms で、既定の 5000ms をまたいでいた。
     *
     * 原因は、同じ日に足した `test/sensitivityVariant.test.ts` が
     * `npx vite-node` の子プロセスを並列に起こし、他のワーカーを遅くすること。
     * このテストだけが、重いのに明示 timeout を持っていなかった（近隣は 30_000）。
     *
     * **ここの timeout は性能を測っていない。**ハングしたときに永久に止まらないための
     * 保険である。負荷でばらつく値を合否に使うと、
     * **落ちても気にしないテストが 1 つ生まれる。**それは空振りと同じくらい悪い
     * （→ CONTRIBUTING §7）。重いテストが個別に指定していた値と揃える。
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
