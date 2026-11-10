import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { route } from '../../src/index'
import { signInitData } from '../../src/auth/initData'

// Worker testlari uchun umumiy yordamchilar: Telegram API ushlash, HTTP chaqiruv, onboarding, RPC.

export type TgCall = { method: string; body: any }
export const tg: { calls: TgCall[] } = { calls: [] }
const realFetch = globalThis.fetch

export function mockTelegram() {
  beforeEach(() => {
    tg.calls = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith('https://tg.mock/')) {
        const method = url.split('/').pop()!
        const body = init?.body instanceof FormData ? Object.fromEntries(init.body as any) : JSON.parse(String(init?.body ?? '{}'))
        tg.calls.push({ method, body })
        return Response.json({ ok: true, result: { message_id: 1 } })
      }
      return realFetch(input as RequestInfo, init)
    })
  })
  afterEach(() => { vi.restoreAllMocks() })
}

export async function call(path: string, init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
  const headers: Record<string, string> = { ...(init.headers ?? {}) }
  if (init.token) headers.Authorization = `Bearer ${init.token}`
  let body: BodyInit | undefined
  if (init.body !== undefined) { body = JSON.stringify(init.body); headers['Content-Type'] = 'application/json' }
  const res = await route(new Request(`https://kassa.test${path}`, { method: init.method ?? 'POST', headers, body }), env, ctx)
  await Promise.all(pending)
  const isJson = (res.headers.get('Content-Type') ?? '').includes('json')
  const bytes = await res.arrayBuffer()
  let json: any = null
  if (isJson) { try { json = JSON.parse(new TextDecoder().decode(bytes)) } catch { /* bo'sh */ } }
  return { status: res.status, json, res, bytes }
}

let nextUid = 7_000_000
export function tgUser(name = 'Ega') {
  return { id: ++nextUid, first_name: name, language_code: 'uz' }
}

export async function initData(user: { id: number }, extra: Record<string, string> = {}) {
  return signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAE', user: JSON.stringify(user), ...extra }, env.BOT_TOKEN)
}

export async function onboard(name = "Asosiy do'kon", user = tgUser()) {
  const r = await call('/api/onboard', { body: { initData: await initData(user), shopName: name } })
  expect(r.status).toBe(200)
  return { user, token: r.json.token as string, shopId: r.json.shop.id as string, json: r.json }
}

export const rpc = (token: string, op: string, args: unknown[] = [], key?: string) =>
  call(`/api/rpc/${op}`, { token, body: { args }, headers: key ? { 'Idempotency-Key': key } : {} })

export const shopDO = (id: string) => env.SHOP.get(env.SHOP.idFromName(id))
