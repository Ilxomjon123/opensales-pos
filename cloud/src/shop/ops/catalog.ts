import { DomainError, invalid } from '../errors'
import { assertCatalogWritable } from '../catalogSync'
import type { Ctx, OpTable } from '../rpc'
import * as v from '../v'

// Kategoriyalar va mahsulotlar — src/lib/db.ts porti (SQL so'zma-so'z, faqat sinxron).
// Farqlar: rasm base64 emas, alohida BLOB (product_images) + manzil; kassir tannarxni
// ko'rmaydi; kirish ma'lumotlari tekshiriladi.

type ProductRow = {
  id: number
  category_id: number | null
  name: string
  price: number
  cost_price: number
  stock: number
  unit: string
  image: string | null
  barcode: string | null
  barcode_type: string | null
  is_active: number
}

const IMAGE_MAX_BYTES = 300 * 1024
const DATA_URL = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/

/** products.image: bulutda rasm versiyasi (`v` + hex); import qilingan eski yozuvda data URL. */
function presentImage(ctx: Ctx, p: { id: number; image: string | null }): string | null {
  if (!p.image) return null
  if (p.image.startsWith('data:')) return p.image
  return ctx.imageUrl(p.id, p.image)
}

export function presentProduct<T extends ProductRow>(ctx: Ctx, p: T): T {
  const out = { ...p, image: presentImage(ctx, p) }
  if (ctx.actor.role !== 'owner') out.cost_price = 0
  return out
}

function randomVersion(): string {
  const b = new Uint8Array(6)
  crypto.getRandomValues(b)
  return 'v' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

function decodeImage(dataUrl: string): { mime: string; bytes: Uint8Array } {
  const m = DATA_URL.exec(dataUrl)
  if (!m) throw new DomainError('cloud.errors.imageInvalid', {}, 400)
  const bin = atob(m[2])
  if (bin.length > IMAGE_MAX_BYTES) throw new DomainError('cloud.errors.imageTooLarge', { max: Math.round(IMAGE_MAX_BYTES / 1024) }, 413)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const mime = m[1]
  const isWebp = bytes.length > 12 && bin.slice(0, 4) === 'RIFF' && bin.slice(8, 12) === 'WEBP'
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const isPng = bytes[0] === 0x89 && bin.slice(1, 4) === 'PNG'
  const ok = (mime === 'image/webp' && isWebp) || (mime === 'image/jpeg' && isJpeg) || (mime === 'image/png' && isPng)
  if (!ok) throw new DomainError('cloud.errors.imageInvalid', {}, 400)
  return { mime, bytes }
}

/**
 * Formadan kelgan rasm maydoni: data URL → yangi rasm; null/'' → o'chirish; mavjud
 * manzil (ro'yxatdan kelgan) → o'zgarmaydi. Qaytaradi: products.image ga yoziladigan qiymat.
 */
function resolveImage(ctx: Ctx, productId: number | null, image: unknown, current: string | null): { value: string | null; store?: { mime: string; bytes: Uint8Array } } {
  if (image === null || image === undefined || image === '') return { value: null }
  if (typeof image !== 'string') throw invalid('image')
  if (image.startsWith('data:')) {
    const dec = decodeImage(image)
    return { value: randomVersion(), store: dec }
  }
  // O'zgarmagan rasm: klient ro'yxatdagi manzilni qaytaradi.
  if (current && productId && image === presentImage(ctx, { id: productId, image: current })) return { value: current }
  throw invalid('image')
}

function writeImage(ctx: Ctx, productId: number, value: string | null, store?: { mime: string; bytes: Uint8Array }) {
  if (store && value) {
    ctx.sql.run(
      `INSERT INTO product_images(product_id, mime, data, version, updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(product_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, version = excluded.version, updated_at = excluded.updated_at`,
      productId, store.mime, store.bytes, value, ctx.now(),
    )
  } else if (value === null) {
    ctx.sql.run('DELETE FROM product_images WHERE product_id = ?', productId)
  }
}

type BulkPriceParams = { scope: 'all' | 'category'; categoryId?: number | null; mode: 'percent' | 'amount'; direction: 'up' | 'down'; value: number }

function bulkParams(x: unknown): BulkPriceParams {
  const o = v.obj(x, 'params')
  return {
    scope: v.oneOf(o.scope, 'scope', ['all', 'category'] as const),
    categoryId: v.optId(o.categoryId, 'categoryId'),
    mode: v.oneOf(o.mode, 'mode', ['percent', 'amount'] as const),
    direction: v.oneOf(o.direction, 'direction', ['up', 'down'] as const),
    value: v.num(o.value ?? 0, 'value', { min: -1e12, max: 1e12 }),
  }
}
function bulkWhere(params: BulkPriceParams): { sql: string; args: number[] } {
  if (params.scope === 'category' && params.categoryId) return { sql: 'WHERE category_id = ?', args: [params.categoryId] }
  return { sql: '', args: [] }
}
function applyBulkDelta(cur: number, params: BulkPriceParams): number {
  const sign = params.direction === 'up' ? 1 : -1
  const val = Math.max(0, params.value || 0)
  if (params.mode === 'percent') return Math.max(0, Math.round(cur * (1 + (sign * val) / 100)))
  return Math.max(0, Math.round(cur + sign * val))
}

export const catalogOps: OpTable = {
  // ---- Kategoriyalar ----
  listCategories: {
    access: 'cashier',
    write: false,
    run: (ctx) => ctx.sql.all('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order, name'),
  },
  saveCategory: {
    access: 'owner',
    write: true,
    run(ctx, raw) {
      assertCatalogWritable(ctx.sql)
      const [nameRaw, idRaw] = v.args(raw)
      const name = v.str(nameRaw, 'name', 120).trim()
      if (!name) throw invalid('name')
      const id = v.optId(idRaw)
      if (id) ctx.sql.run('UPDATE categories SET name = ? WHERE id = ?', name, id)
      else ctx.sql.run('INSERT INTO categories(name) VALUES(?)', name)
      return null
    },
  },
  deleteCategory: {
    access: 'owner',
    write: true,
    run(ctx, raw) {
      assertCatalogWritable(ctx.sql)
      const id = v.id(v.args(raw)[0])
      const r = ctx.sql.get<{ c: number }>('SELECT COUNT(*) c FROM products WHERE category_id = ? AND is_active = 1', id)
      if ((r?.c ?? 0) > 0) throw new DomainError('categories.hasProducts')
      ctx.sql.run('DELETE FROM categories WHERE id = ?', id)
      return null
    },
  },

  // ---- Mahsulotlar ----
  listProducts: {
    access: 'cashier',
    write: false,
    run(ctx, raw) {
      const [activeOnly] = v.args(raw)
      const where = v.optBool(activeOnly, 'activeOnly', true) ? 'WHERE is_active = 1' : ''
      return ctx.sql.all<ProductRow>(`SELECT * FROM products ${where} ORDER BY name`).map((p) => presentProduct(ctx, p))
    },
  },
  // Qoldiq bu yerda YOZILMAYDI — faqat jurnal orqali (adjust_product_stock, kirim, sotuv,
  // vozvrat). Yangi mahsulot 0 qoldiq bilan. Qaytaradi: mahsulot id.
  saveProduct: {
    access: 'owner',
    write: true,
    run(ctx, raw) {
      assertCatalogWritable(ctx.sql)
      const p = v.obj(v.args(raw)[0], 'product')
      const id = v.optId(p.id)
      const name = v.str(p.name, 'name', 200).trim()
      if (!name) throw invalid('name')
      const price = v.money(p.price, 'price', { min: 0 })
      const cost = v.money(p.cost_price ?? 0, 'cost_price', { min: 0 })
      const unit = v.str(p.unit ?? 'dona', 'unit', 20).trim() || 'dona'
      const categoryId = v.optId(p.category_id, 'category_id')
      const barcode = (v.optStr(p.barcode, 'barcode', 600) ?? '').trim() || null
      if (barcode && barcode.length > 512) throw new DomainError('products.barcodeTooLong')
      if (barcode) {
        const dup = ctx.sql.get<{ id: number; name: string }>('SELECT id, name FROM products WHERE barcode = ? AND id != ? LIMIT 1', barcode, id ?? 0)
        if (dup) throw new DomainError('products.barcodeInUse', { name: dup.name })
      }
      const barcodeType = barcode ? (v.optStr(p.barcode_type, 'barcode_type', 32) || null) : null

      if (id) {
        const cur = ctx.sql.get<{ image: string | null }>('SELECT image FROM products WHERE id = ?', id)
        if (!cur) throw new DomainError('cloud.errors.notFound', { what: 'product' }, 404)
        const img = resolveImage(ctx, id, p.image, cur.image)
        ctx.sql.run(
          'UPDATE products SET category_id=?, name=?, price=?, cost_price=?, unit=?, image=?, barcode=?, barcode_type=? WHERE id=?',
          categoryId, name, price, cost, unit, img.value, barcode, barcodeType, id,
        )
        writeImage(ctx, id, img.value, img.store)
        return id
      }
      const img = resolveImage(ctx, null, p.image, null)
      const r = ctx.sql.get<{ id: number }>(
        'INSERT INTO products(category_id, name, price, cost_price, stock, unit, image, barcode, barcode_type) VALUES(?,?,?,?,0,?,?,?,?) RETURNING id',
        categoryId, name, price, cost, unit, img.value, barcode, barcodeType,
      )!
      writeImage(ctx, r.id, img.value, img.store)
      return r.id
    },
  },
  findProductByBarcode: {
    access: 'cashier',
    write: false,
    run(ctx, raw) {
      const c = v.str(v.args(raw)[0], 'code', 600).trim()
      if (!c) return null
      const r = ctx.sql.get<ProductRow>('SELECT * FROM products WHERE barcode = ? AND is_active = 1 LIMIT 1', c)
      return r ? presentProduct(ctx, r) : null
    },
  },
  getProductWithCategory: {
    access: 'owner',
    write: false,
    run(ctx, raw) {
      const id = v.id(v.args(raw)[0])
      const r = ctx.sql.get<ProductRow & { category: string | null }>(
        'SELECT p.*, c.name category FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?', id,
      )
      return r ? presentProduct(ctx, r) : null
    },
  },
  setProductActive: {
    access: 'owner',
    write: true,
    run(ctx, raw) {
      assertCatalogWritable(ctx.sql)
      const [idRaw, active] = v.args(raw)
      ctx.sql.run('UPDATE products SET is_active = ? WHERE id = ?', v.bool(active, 'active') ? 1 : 0, v.id(idRaw))
      return null
    },
  },
  deleteProduct: {
    access: 'owner',
    write: true,
    run(ctx, raw) {
      assertCatalogWritable(ctx.sql)
      const id = v.id(v.args(raw)[0])
      const sales = ctx.sql.get<{ c: number }>('SELECT COUNT(*) c FROM sale_items WHERE product_id = ?', id)
      if ((sales?.c ?? 0) > 0) throw new DomainError('products.hasSales')
      const receipts = ctx.sql.get<{ c: number }>('SELECT COUNT(*) c FROM stock_receipt_items WHERE product_id = ?', id)
      if ((receipts?.c ?? 0) > 0) throw new DomainError('products.hasReceipts')
      ctx.sql.run('DELETE FROM products WHERE id = ?', id)
      return null
    },
  },

  // ---- Narxlarni ommaviy o'zgartirish ----
  bulkPricePreview: {
    access: 'owner',
    write: false,
    run(ctx, raw) {
      const [pRaw, limitRaw] = v.args(raw)
      const params = bulkParams(pRaw)
      const limit = limitRaw === undefined ? 12 : v.int(limitRaw, 'limit', { min: 0, max: 200 })
      const { sql, args } = bulkWhere(params)
      const rows = ctx.sql.all<{ id: number; name: string; price: number }>(`SELECT id, name, price FROM products ${sql} ORDER BY name`, ...args)
      return {
        count: rows.length,
        preview: rows.slice(0, limit).map((p) => ({ id: p.id, name: p.name, old_price: p.price, new_price: applyBulkDelta(p.price, params) })),
      }
    },
  },
  bulkAdjustPrices: {
    access: 'owner',
    write: true,
    run(ctx, raw) {
      assertCatalogWritable(ctx.sql)
      const params = bulkParams(v.args(raw)[0])
      const { sql, args } = bulkWhere(params)
      const sign = params.direction === 'up' ? 1 : -1
      const val = Math.max(0, params.value || 0)
      // Desktop SQL'ga qiymatni matn sifatida qo'yadi; bu yerda bog'langan parametr.
      let expr: string
      let exprArgs: number[]
      if (params.mode === 'percent') {
        const factor = 1 + (sign * val) / 100
        if (!Number.isFinite(factor)) return 0
        expr = 'CAST(ROUND(price * ?) AS INTEGER)'
        exprArgs = [factor]
      } else {
        expr = 'CAST(ROUND(price + (?)) AS INTEGER)'
        exprArgs = [Math.round(sign * val)]
      }
      return ctx.sql.run(
        `UPDATE products SET price = CASE WHEN ${expr} < 0 THEN 0 ELSE ${expr} END ${sql}`,
        ...exprArgs, ...exprArgs, ...args,
      )
    },
  },
}
