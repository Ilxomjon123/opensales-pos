// Do'kon bazasiga sinxron kirish. Ishlab chiqarishda Durable Object'ning SQLite'i
// (`ctx.storage.sql`), testlarda node:sqlite — op'lar ikkalasida bir xil ishlaydi.
//
// Placeholder `?` (desktop pos-tauri bilan bir xil). Bitta so'rovda 100 tadan ko'p
// parametr bo'lmaydi (DO cheklovi) — ro'yxatlar `IN (SELECT value FROM json_each(?))`.

export type SqlValue = string | number | null | ArrayBuffer | Uint8Array

export interface Sql {
  all<T = Record<string, unknown>>(query: string, ...params: SqlValue[]): T[]
  get<T = Record<string, unknown>>(query: string, ...params: SqlValue[]): T | undefined
  /** Yozish; o'zgargan qatorlar soni. */
  run(query: string, ...params: SqlValue[]): number
  /** Bir nechta DDL/so'rov (`;` bilan), parametrsiz. */
  script(query: string): void
  /** Xatoda to'liq rollback. Ichida await bo'lmaydi. */
  tx<T>(fn: () => T): T
}

// boolean/undefined bog'lab bo'lmaydi — op'lar baribir raqam yuboradi, bu himoya.
function norm(params: SqlValue[]): SqlValue[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p))
}

/** Durable Object SQLite (cloudflare:workers DurableObjectState.storage). */
export function doSql(storage: DurableObjectStorage): Sql {
  // DO BLOB faqat ArrayBuffer qabul qiladi.
  const bind = (p: SqlValue[]) => norm(p).map((x) => (x instanceof Uint8Array ? x.slice().buffer : x)) as (string | number | null | ArrayBuffer)[]
  const exec = (q: string, p: SqlValue[]) => storage.sql.exec(q, ...bind(p))
  return {
    all: <T>(q: string, ...p: SqlValue[]) => exec(q, p).toArray() as T[],
    get: <T>(q: string, ...p: SqlValue[]) => {
      const rows = exec(q, p).toArray()
      return rows[0] as T | undefined
    },
    // rowsWritten indeks yozuvlarini ham sanaydi — desktop `rowsAffected` bilan bir xil
    // bo'lishi uchun SQLite'ning o'z changes() qiymati olinadi.
    run: (q: string, ...p: SqlValue[]) => {
      exec(q, p).toArray()
      return Number((storage.sql.exec('SELECT changes() c').one() as { c: number }).c)
    },
    script: (q: string) => { storage.sql.exec(q) },
    tx: <T>(fn: () => T) => storage.transactionSync(fn),
  }
}

/** Minimal node:sqlite interfeysi (testlar va paritet harness uchun). */
export interface NodeDatabaseLike {
  prepare(q: string): {
    all(...p: unknown[]): unknown[]
    get(...p: unknown[]): unknown
    run(...p: unknown[]): { changes: number | bigint }
  }
  exec(q: string): void
}

export function nodeSql(db: NodeDatabaseLike): Sql {
  let depth = 0
  return {
    all: <T>(q: string, ...p: SqlValue[]) => db.prepare(q).all(...norm(p)) as T[],
    get: <T>(q: string, ...p: SqlValue[]) => (db.prepare(q).get(...norm(p)) ?? undefined) as T | undefined,
    run: (q: string, ...p: SqlValue[]) => Number(db.prepare(q).run(...norm(p)).changes),
    script: (q: string) => db.exec(q),
    tx: <T>(fn: () => T): T => {
      // DO transactionSync ichma-ich chaqirilsa savepoint ishlatadi — shu yerda ham.
      const name = `sp${depth++}`
      db.exec(`SAVEPOINT ${name}`)
      try {
        const out = fn()
        db.exec(`RELEASE ${name}`)
        return out
      } catch (e) {
        db.exec(`ROLLBACK TO ${name}`)
        db.exec(`RELEASE ${name}`)
        throw e
      } finally {
        depth--
      }
    },
  }
}

/** `IN (...)` o'rniga: `id IN (SELECT value FROM json_each(?))` + shu qiymat. */
export function jsonList(ids: readonly (number | string)[]): string {
  return JSON.stringify(ids)
}
