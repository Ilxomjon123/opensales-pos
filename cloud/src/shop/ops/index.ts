import type { OpTable } from '../rpc'
import { catalogOps } from './catalog'
import { customerOps } from './customers'
import { expenseOps } from './expenses'
import { movementOps } from './movement'
import { reportOps } from './reports'
import { returnOps } from './returns'
import { customerReturnOps } from './returnsCustomer'
import { saleOps } from './sales'
import { settingsOps } from './settings'
import { shiftOps } from './shifts'
import { stockOps } from './stock'
import { assistantOps } from './assistantOps'
import { progressOps } from '../progress'

function merge(...tables: OpTable[]): OpTable {
  const out: OpTable = Object.create(null)
  for (const t of tables) {
    for (const [name, def] of Object.entries(t)) {
      if (name in out) throw new Error(`duplicate op: ${name}`)
      out[name] = def
    }
  }
  return out
}

/** Klient chaqira oladigan barcha op'lar (allowlist). */
export const OPS: OpTable = merge(
  settingsOps, catalogOps, customerOps, shiftOps, saleOps, expenseOps, reportOps, movementOps,
  returnOps, customerReturnOps, stockOps, assistantOps, progressOps,
)
