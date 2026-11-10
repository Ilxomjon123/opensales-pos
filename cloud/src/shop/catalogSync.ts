import type { Sql } from './sql'
import { DomainError } from './errors'
import { getMeta } from './init'

// Bir nechta do'kon: katalog sinxroni (asosiy → filial) va yangi do'konga katalog nusxasi.
//
// Asosiy do'konda har tovar/kategoriya o'zgarishi TRIGGER bilan `catalog_ver` ni oshiradi (schema V5).
// Filial `catalog_cursor` dan keyingi o'zgarishlarni sahifalab tortadi va id'larni SAQLAB qo'llaydi —
// sotuv, kirim, ko'chirish ikkala do'konda bir xil tovar id'si bilan ishlaydi. Qoldiq va tannarx
// sinxronlanmaydi (har do'konniki o'zi). Qo'llash holatga asoslangan (upsert) — takror qo'llash zararsiz;
// eski sahifa yangisining ustiga yozilmasligi uchun kursor solishtirib almashtiriladi.

export type CatalogCategory = { id: number; name: string; sort_order: number; is_active: number; sync_ver: number }
export type CatalogProduct = {
  id: number; category_id: number | null; name: string; price: number; cost_price?: number; unit: string; image: string | null
  is_active: number; barcode: string | null; barcode_type: string | null; sync_ver: number
}
export type CatalogTombstone = { kind: 'product' | 'category'; id: number; ver: number }
export type CatalogChanges = { categories: CatalogCategory[]; products: CatalogProduct[]; tombstones: CatalogTombstone[]; cursor: number; more: boolean }

export const CATALOG_PAGE = 500

/** Bu do'kon filialmi — katalog boshqa do'kondan. */
export function catalogSource(sql: Sql): string | null {
  return getMeta(sql, 'catalog_of')
}

/** Filialda katalogni o'zgartirib bo'lmaydi — u asosiy do'konda boshqariladi. */
export function assertCatalogWritable(sql: Sql): void {
  if (catalogSource(sql)) throw new DomainError('cloud.shops.errors.catalogManagedByMaster', {}, 403)
}

export function catalogVersion(sql: Sql): number {
  return Number(getMeta(sql, 'catalog_ver') ?? 0)
}

/**
 * `cursor` dan keyingi o'zgarishlar (har oqimdan ko'pi bilan `limit`). Bir nechta oqim bitta kursorda:
 * qaysi oqim to'lib qolsa, kursor o'sha oqimning oxirgi versiyasigacha kesiladi — hech narsa o'tkazib yuborilmaydi.
 * `withCost` — yangi alohida do'konga nusxa (tannarx ham); filialga tannarx YUBORILMAYDI.
 */
export function catalogChanges(sql: Sql, cursor: number, limit = CATALOG_PAGE, withCost = false): CatalogChanges {
  const top = catalogVersion(sql)
  const cats = sql.all<CatalogCategory>('SELECT id, name, sort_order, is_active, sync_ver FROM categories WHERE sync_ver > ? ORDER BY sync_ver LIMIT ?', cursor, limit)
  const prods = sql.all<CatalogProduct>(
    `SELECT id, category_id, name, price, ${withCost ? 'cost_price, ' : ''}unit, image, is_active, barcode, barcode_type, sync_ver
     FROM products WHERE sync_ver > ? ORDER BY sync_ver LIMIT ?`, cursor, limit,
  )
  const tombs = sql.all<CatalogTombstone>('SELECT kind, id, ver FROM catalog_tombstones WHERE ver > ? ORDER BY ver LIMIT ?', cursor, limit)
  let upTo = top
  for (const [rows, ver] of [[cats, (r: CatalogCategory) => r.sync_ver], [prods, (r: CatalogProduct) => r.sync_ver], [tombs, (r: CatalogTombstone) => r.ver]] as const) {
    if (rows.length === limit) upTo = Math.min(upTo, (ver as (r: unknown) => number)(rows[rows.length - 1]))
  }
  return {
    categories: cats.filter((r) => r.sync_ver <= upTo),
    products: prods.filter((r) => r.sync_ver <= upTo),
    tombstones: tombs.filter((r) => r.ver <= upTo),
    cursor: upTo,
    more: upTo < top,
  }
}

function productHasHistory(sql: Sql, id: number): boolean {
  return !!sql.get(
    `SELECT 1 FROM sale_items WHERE product_id = ?
     UNION ALL SELECT 1 FROM stock_receipt_items WHERE product_id = ?
     UNION ALL SELECT 1 FROM sale_return_items WHERE product_id = ?
     UNION ALL SELECT 1 FROM stock_adjustments WHERE product_id = ? LIMIT 1`, id, id, id, id,
  )
}

/**
 * Filialda (yoki yangi do'kon nusxasida) qo'llash. `from` — chaqiruvchi o'qigan kursor: joriy kursor
 * boshqa bo'lsa (parallel sinxron oldinroq yetib kelgan) — hech narsa qilinmaydi. Qaytaradi: yangi kursor.
 */
export function applyCatalog(sql: Sql, ch: CatalogChanges, from: number): { applied: boolean; cursor: number } {
  return sql.tx(() => {
    const cur = Number(getMeta(sql, 'catalog_cursor') ?? 0)
    if (cur !== from) return { applied: false, cursor: cur }
    for (const c of ch.categories) {
      sql.run(
        `INSERT INTO categories(id, name, sort_order, is_active) VALUES(?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order, is_active = excluded.is_active`,
        c.id, c.name, c.sort_order, c.is_active,
      )
    }
    for (const p of ch.products) {
      // Shtrix-kod boshqa tovardan ko'chgan bo'lsa — eski egasidan olinadi (keyingi qatorda o'zi keladi).
      if (p.barcode) sql.run('UPDATE products SET barcode = NULL, barcode_type = NULL WHERE barcode = ? AND id != ?', p.barcode, p.id)
      const cat = p.category_id !== null && sql.get('SELECT 1 FROM categories WHERE id = ?', p.category_id) ? p.category_id : null
      sql.run(
        `INSERT INTO products(id, category_id, name, price, cost_price, stock, unit, image, is_active, barcode, barcode_type) VALUES(?,?,?,?,?,0,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET category_id = excluded.category_id, name = excluded.name, price = excluded.price, unit = excluded.unit,
           image = excluded.image, is_active = excluded.is_active, barcode = excluded.barcode, barcode_type = excluded.barcode_type`,
        p.id, cat, p.name, p.price, p.cost_price ?? 0, p.unit, p.image, p.is_active, p.barcode, p.barcode_type,
      )
    }
    for (const t of ch.tombstones) {
      if (t.kind === 'category') sql.run('DELETE FROM categories WHERE id = ?', t.id)
      // Filialda sotilgan/kirim qilingan tovar tarixi buzilmasin — o'chirish o'rniga nofaol.
      else if (productHasHistory(sql, t.id)) sql.run('UPDATE products SET is_active = 0 WHERE id = ?', t.id)
      else sql.run('DELETE FROM products WHERE id = ?', t.id)
    }
    sql.run("INSERT INTO meta(key, value) VALUES('catalog_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(ch.cursor))
    return { applied: true, cursor: ch.cursor }
  })
}

export type ImageRow = { product_id: number; mime: string; data: ArrayBuffer; version: string }

/** Rasm nusxasi (yangi alohida do'konga) — sahifalab, id bo'yicha. */
export function imagesPage(sql: Sql, afterId: number, limit = 40): ImageRow[] {
  return sql.all<ImageRow>('SELECT product_id, mime, data, version FROM product_images WHERE product_id > ? ORDER BY product_id LIMIT ?', afterId, limit)
}

export function putImages(sql: Sql, rows: ImageRow[], now: string): void {
  sql.tx(() => {
    for (const r of rows) {
      if (!sql.get('SELECT 1 FROM products WHERE id = ?', r.product_id)) continue
      sql.run(
        `INSERT INTO product_images(product_id, mime, data, version, updated_at) VALUES(?,?,?,?,?)
         ON CONFLICT(product_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, version = excluded.version, updated_at = excluded.updated_at`,
        r.product_id, r.mime, r.data, r.version, now,
      )
    }
  })
}
