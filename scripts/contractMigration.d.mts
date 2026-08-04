/** scripts/contractMigration.mjs の型。実体は .mjs 側にある（正本は 1 つ） */

export declare const CONTRACT_MIGRATION_FILE: string

export declare function loadContractMigrations(root?: string): {
  schemaVersion: number
  schemaId: string
  policyDocument: string
  policyVersion: number
  migrations: Record<string, unknown>
}

/** schemaId を指定して contractMigration の値を取る。**無ければ落とす** */
export declare function migrationFor(schemaId: string, root?: string): Record<string, unknown>
