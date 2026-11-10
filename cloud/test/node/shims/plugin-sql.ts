// Desktop `@tauri-apps/plugin-sql` o'rniga: paritet testida desktop src/lib/db.ts funksiyalari
// node:sqlite bazada ishlaydi. Baza testdan `setParityDatabase()` bilan beriladi.
import type { DatabaseSync } from 'node:sqlite'

let current: DatabaseSync | null = null
export function setParityDatabase(db: DatabaseSync) { current = db }

export default class Database {
  static async load(_url: string): Promise<Database> {
    if (!current) throw new Error('parity database not set')
    return new Database(current)
  }
  constructor(private readonly db: DatabaseSync) {}
  async select<T>(query: string, params: unknown[] = []): Promise<T> {
    return this.db.prepare(query).all(...(params as never[])) as T
  }
  async execute(query: string, params: unknown[] = []): Promise<{ rowsAffected: number; lastInsertId: number }> {
    const r = this.db.prepare(query).run(...(params as never[]))
    return { rowsAffected: Number(r.changes), lastInsertId: Number(r.lastInsertRowid) }
  }
}
