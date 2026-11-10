import { invalid } from './errors'

// Kiruvchi JSON uchun kichik tekshiruvchilar. Klient o'zimizniki bo'lsa ham server unga
// ishonmaydi: har maydon turi va chegarasi shu yerda.

const MAX_MONEY = 1e13 // 10 trln so'm — undan katta qiymat xato kiritish
const MAX_QTY = 1e9

export function int(x: unknown, field: string, opts: { min?: number; max?: number } = {}): number {
  if (typeof x !== 'number' || !Number.isFinite(x) || !Number.isInteger(x)) throw invalid(field)
  if (opts.min !== undefined && x < opts.min) throw invalid(field)
  if (opts.max !== undefined && x > opts.max) throw invalid(field)
  return x
}

export function id(x: unknown, field = 'id'): number {
  return int(x, field, { min: 1, max: Number.MAX_SAFE_INTEGER })
}

export function optId(x: unknown, field = 'id'): number | null {
  return x === null || x === undefined || x === 0 ? null : id(x, field)
}

export function num(x: unknown, field: string, opts: { min?: number; max?: number } = {}): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw invalid(field)
  if (opts.min !== undefined && x < opts.min) throw invalid(field)
  if (opts.max !== undefined && x > opts.max) throw invalid(field)
  return x
}

/** Pul: butun so'mga yaxlitlanadi (desktop Math.round bilan bir xil). */
export function money(x: unknown, field: string, opts: { min?: number } = {}): number {
  const n = num(x, field, { min: opts.min ?? -MAX_MONEY, max: MAX_MONEY })
  return Math.round(n)
}

export function qty(x: unknown, field: string): number {
  return num(x, field, { min: -MAX_QTY, max: MAX_QTY })
}

export function str(x: unknown, field: string, max = 500): string {
  if (typeof x !== 'string' || x.length > max) throw invalid(field)
  return x
}

export function optStr(x: unknown, field: string, max = 500): string | null {
  if (x === null || x === undefined) return null
  return str(x, field, max)
}

export function bool(x: unknown, field: string): boolean {
  if (typeof x === 'boolean') return x
  if (x === 0 || x === 1) return x === 1
  throw invalid(field)
}

export function optBool(x: unknown, field: string, fallback: boolean): boolean {
  return x === undefined ? fallback : bool(x, field)
}

export function obj(x: unknown, field: string): Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw invalid(field)
  return x as Record<string, unknown>
}

export function optObj(x: unknown, field: string): Record<string, unknown> {
  return x === undefined || x === null ? {} : obj(x, field)
}

export function arr(x: unknown, field: string, max = 1000): unknown[] {
  if (!Array.isArray(x) || x.length > max) throw invalid(field)
  return x
}

export function oneOf<T extends string>(x: unknown, field: string, values: readonly T[]): T {
  if (typeof x !== 'string' || !(values as readonly string[]).includes(x)) throw invalid(field)
  return x as T
}

export function optOneOf<T extends string>(x: unknown, field: string, values: readonly T[]): T | undefined {
  return x === undefined || x === null || x === '' ? undefined : oneOf(x, field, values)
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
/** YYYY-MM-DD (desktop sana filtrlari shu formatda). */
export function day(x: unknown, field: string): string {
  if (typeof x !== 'string' || !DAY.test(x)) throw invalid(field)
  return x
}

export function optDay(x: unknown, field: string): string | undefined {
  return x === undefined || x === null || x === '' ? undefined : day(x, field)
}

/** Pozitsion argumentlar massivi (desktop funksiya imzosi bilan bir xil). */
export function args(x: unknown, max = 8): unknown[] {
  if (x === undefined) return []
  if (!Array.isArray(x) || x.length > max) throw invalid('args')
  return x
}
