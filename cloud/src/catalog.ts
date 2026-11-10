import type { Env } from './env'
import { branchesOf } from './registry'

// Worker tomoni: do'konlar orasida katalog ko'chirish (shop/catalogSync.ts dagi DO metodlari ustida).

/** Do'kon DO'si — Toshkentga yaqin (Sharqiy Yevropa) joylashsin. */
export function shopStub(env: Env, tenantId: string) {
  return env.SHOP.get(env.SHOP.idFromName(tenantId), { locationHint: 'eeur' })
}

/** Katalog yozuvchi op'lar — asosiy do'konda muvaffaqiyatli bo'lsa filiallarga yuboriladi (kirimda narx ham o'zgaradi). */
export const CATALOG_FANOUT_OPS = new Set([
  'saveCategory', 'deleteCategory', 'saveProduct', 'setProductActive', 'deleteProduct', 'bulkAdjustPrices',
  'create_stock_receipt', 'void_stock_receipt',
])

const MAX_PAGES = 100

/**
 * `sourceId` katalogini `targetId` ga yetkazadi (filial sinxroni yoki yangi do'kon nusxasi). Sahifalab,
 * kursor bilan; parallel sinxron bo'lsa DO kursorni solishtiradi — eski sahifa yangisining ustiga yozilmaydi.
 */
export async function syncCatalog(env: Env, sourceId: string, targetId: string, withCost = false): Promise<number> {
  const src = shopStub(env, sourceId)
  const dst = shopStub(env, targetId)
  let { cursor } = await dst.catalogState()
  for (let i = 0; i < MAX_PAGES; i++) {
    const ch = await src.catalogChanges(cursor, undefined, withCost)
    if (ch.cursor <= cursor && !ch.more) break
    const r = await dst.applyCatalog(ch, cursor)
    if (!r.applied) { cursor = r.cursor; continue }
    cursor = r.cursor
    if (!ch.more) break
  }
  return cursor
}

/** Asosiy do'kondagi o'zgarishdan keyin — barcha filiallar. Xato bitta filialni to'xtatmaydi. */
export async function syncBranchesOf(env: Env, masterId: string): Promise<void> {
  const branches = await branchesOf(env.DB, masterId)
  await Promise.all(branches.map((b) => syncCatalog(env, masterId, b.id).catch((e) => console.error('catalog sync', b.id, e))))
}

/** Yangi alohida do'konga katalog nusxasi (tannarx va rasmlar bilan). Faqat yaratilganda. */
export async function copyCatalog(env: Env, sourceId: string, targetId: string): Promise<void> {
  await syncCatalog(env, sourceId, targetId, true)
  const src = shopStub(env, sourceId)
  const dst = shopStub(env, targetId)
  let after = 0
  for (let i = 0; i < 1000; i++) {
    const rows = await src.imagesPage(after)
    if (rows.length === 0) break
    await dst.putImages(rows)
    after = rows[rows.length - 1].product_id
  }
}
