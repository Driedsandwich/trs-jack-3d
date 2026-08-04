/**
 * contractMigration の値を正本 (contract-migration.v1.json) から引く。
 *
 * 生成器ごとに手で書くと、v0.4.0 のときのように**片方だけ古いまま**になる。
 * 6 本の artifact が同じ 1 か所を読む。
 *
 * 記録が schema 実物とずれていないことは test/contractMigration.test.ts が確かめる
 * (pointer 実在・判定の一致・網羅・据置きゼロ の 4 検査)。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const CONTRACT_MIGRATION_FILE = 'contract-migration.v1.json'

let cache = null

export function loadContractMigrations(root = ROOT) {
  if (cache) return cache
  const p = resolve(root, CONTRACT_MIGRATION_FILE)
  let raw
  try {
    raw = readFileSync(p, 'utf8')
  } catch (e) {
    throw new Error(
      `${CONTRACT_MIGRATION_FILE} が読めない (${p}): ${e.message}\n`
        + '  **黙って空の対応表を書いてはいけない。**下流は版の対応をここでしか引けない。',
    )
  }
  cache = JSON.parse(raw)
  return cache
}

/** schemaId を指定して contractMigration の値を取る。**無ければ落とす** */
export function migrationFor(schemaId, root = ROOT) {
  const all = loadContractMigrations(root)
  const m = all.migrations?.[schemaId]
  if (!m) {
    throw new Error(
      `${CONTRACT_MIGRATION_FILE} に ${schemaId} の対応表が無い。\n`
        + `  ある id: ${Object.keys(all.migrations ?? {}).join(', ')}\n`
        + '  **版を上げたら、まずここへ history を足すこと。**',
    )
  }
  return m
}
