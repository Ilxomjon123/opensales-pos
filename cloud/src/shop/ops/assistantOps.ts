import type { OpTable } from '../rpc'
import { DomainError } from '../errors'
import * as v from '../v'
import { catalogOps } from './catalog'
import { customerOps } from './customers'
import { stockOps } from './stock'

// AI yordamchisi uchun yig'ma op: bir nechta yangi tovar + boshlang'ich qoldiq — BITTA tranzaksiyada
// (dispatch). Har tovar oddiy `saveProduct` bilan yaratiladi, qoldiq esa `adjust_product_stock`
// ('initial', jurnal yoziladi — "Davr harakati" buzilmaydi). Biri xato bo'lsa — hech biri yozilmaydi.

const MAX_ITEMS = 50

export const assistantOps: OpTable = {
  // Yangi mijozlar + boshlang'ich saldo — bitta tranzaksiyada; saldo desktop formasidagi kabi `setCustomerBalance`
  // (qarzdor — manfiy, haqdor — musbat). Bunday ism bazada bo'lsa — hech biri yozilmaydi.
  assistant_create_customers: {
    access: 'owner',
    write: true,
    run(ctx, raw) {
      const a = v.obj(v.args(raw)[0], 'request')
      const people = v.arr(a.people, 'people', MAX_ITEMS)
      if (!people.length) throw new DomainError('cloud.errors.invalidInput', { field: 'people' }, 400)
      const created: { id: number; name: string; balance: number }[] = []
      for (const [i, r] of people.entries()) {
        const p = v.obj(r, `people.${i}`)
        const name = v.str(p.name, `people.${i}.name`, 200).trim()
        if (ctx.sql.get('SELECT 1 FROM customers WHERE lower(trim(name)) = lower(?) LIMIT 1', name)) throw new DomainError('cloud.ai.errors.customerExists', { name }, 409)
        const id = customerOps.saveCustomer.run(ctx, [name, p.phone ?? null]) as number
        const balance = v.money(p.balance ?? 0, `people.${i}.balance`)
        if (balance !== 0) customerOps.setCustomerBalance.run(ctx, [id, balance])
        created.push({ id, name, balance })
      }
      return { created }
    },
  },
  assistant_create_products: {
    access: 'owner',
    write: true,
    run(ctx, raw) {
      const a = v.obj(v.args(raw)[0], 'request')
      const items = v.arr(a.items, 'items', MAX_ITEMS)
      if (!items.length) throw new DomainError('cloud.errors.invalidInput', { field: 'items' }, 400)
      const created: { id: number; name: string; stock: number }[] = []
      for (const [i, r] of items.entries()) {
        const it = v.obj(r, `items.${i}`)
        const name = v.str(it.name, `items.${i}.name`, 200).trim()
        const dup = ctx.sql.get<{ id: number }>('SELECT id FROM products WHERE lower(trim(name)) = lower(?) LIMIT 1', name)
        if (dup) throw new DomainError('cloud.ai.errors.productExists', { name }, 409)
        const id = catalogOps.saveProduct.run(ctx, [{ name, price: it.price, cost_price: it.cost_price ?? 0, unit: it.unit ?? 'dona' }]) as number
        const stock = v.num(it.stock ?? 0, `items.${i}.stock`, { min: 0, max: 1e9 })
        if (stock > 0) stockOps.adjust_product_stock.run(ctx, { productId: id, newStock: stock, kind: 'initial', note: 'AI yordamchi' })
        created.push({ id, name, stock })
      }
      return { created }
    },
  },
}
