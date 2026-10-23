/** Open (and migrate) the `dsh-plugins` SQLite catalogue. */
import { DatabaseSync } from 'node:sqlite'
import { migratePluginsDb, type PluginsDbHandle } from './migrate.ts'

export type PluginsDb = PluginsDbHandle

/** Open the catalogue database at `file`, creating schema when missing. */
export function openPluginsDb(file: string): PluginsDb {
  const db = new DatabaseSync(file)
  migratePluginsDb(db)
  return { db, close: () => db.close() }
}
