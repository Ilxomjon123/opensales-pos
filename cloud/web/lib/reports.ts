import { call, RpcError } from '../rpc'
import { t } from './i18n'
import type * as D from '../../../src/lib/reports'

export type { ReportPeriod, ReportTopProduct, ReportLowStock, ReportSummary } from '../../../src/lib/reports'

async function rpc<T>(op: string, ...args: unknown[]): Promise<T> {
  try { return await call<T>(op, args) } catch (e) { throw e instanceof RpcError ? new Error(t(e.code, e.params)) : e }
}

export const firstSaleDate: typeof D.firstSaleDate = () => rpc('firstSaleDate')
export const reportSummary: typeof D.reportSummary = (from, to) => rpc('reportSummary', from, to)
