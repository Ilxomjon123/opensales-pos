import { call, RpcError } from '../rpc'
import { t } from '../lib/i18n'

// Desktop `invoke()` o'rniga: vozvrat va kirim Rust buyruqlari bulutda Worker op'lari
// (nomlar bir xil). Xato desktopdagidek `{ code, params }` ko'rinishida rad etiladi —
// returnErrorMessage / stockErrorMessage uni o'zgarishsiz tarjima qiladi.
const RPC_COMMANDS = new Set([
  'return_quote', 'create_return', 'customer_return_quote', 'create_customer_return',
  'create_stock_receipt', 'void_stock_receipt', 'adjust_product_stock',
])
const NOOP = new Set(['ensure_returns_schema', 'ensure_stock_schema'])

export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (NOOP.has(cmd)) return null as T
  if (!RPC_COMMANDS.has(cmd)) throw new Error(`${cmd} is not available in the cloud build`)
  try {
    return await call<T>(cmd, args)
  } catch (e) {
    if (e instanceof RpcError) {
      // Bulutga xos xato (obuna, tarmoq, huquq) — tayyor matn; domen xatosi (qisqa kod) —
      // Rust bilan bir xil `{ code, params }` shakli.
      if (e.code.startsWith('cloud.')) throw new Error(t(e.code, e.params))
      throw { code: e.code, params: e.params }
    }
    throw e
  }
}
