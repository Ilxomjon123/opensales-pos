import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Sayt sarlavhalari: Permissions-Policy ilova ishlatadigan qurilmalarni TAQIQLAMASIN. 2026-11-09:
// `microphone=()` tufayli Telegram ruxsat oynasida "Ruxsat" bosilsa ham WebView mikrofonni rad etardi —
// yordamchi ovozi ishlamas, ruxsat oynasi har bosishda qayta chiqardi.
describe('static headers', () => {
  const headers = readFileSync(decodeURIComponent(new URL('../../web/public/_headers', import.meta.url).pathname), 'utf8')
  const policy = /Permissions-Policy:\s*(.+)/.exec(headers)?.[1] ?? ''

  it('allows the microphone (assistant voice) and camera (barcode scanner, photos) for this origin', () => {
    expect(policy).toMatch(/(^|,\s*)microphone=\(self\)/)
    expect(policy).toMatch(/(^|,\s*)camera=\(self\)/)
  })

  it('keeps index.html revalidated so a deploy reaches open mini apps', () => {
    expect(headers).toMatch(/\/index\.html\s+Cache-Control: no-cache/)
  })
})

// Worker yo'llari: `run_worker_first` da bo'lmagan yo'lni statik SPA (index.html, 200 text/html) yutadi.
// 2026-11-09: `/rimg/*` (chek rasmi) ro'yxatda yo'q edi — Telegram photo_url'dan HTML olib, ulashilgan chek
// rasmsiz chiqdi va xabar yuborilmadi (qizil «!»). Worker route() ishlatadigan har prefiks shu ro'yxatda bo'lsin.
describe('worker routes reach the worker', () => {
  const read = (rel: string) => readFileSync(decodeURIComponent(new URL(rel, import.meta.url).pathname), 'utf8')
  const wrangler = read('../../wrangler.jsonc')
  const list = /"run_worker_first":\s*\[([^\]]*)\]/.exec(wrangler)?.[1] ?? ''
  const first = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1])
  const index = read('../../src/index.ts')
  const body = index.slice(index.indexOf('export async function route('))
  const prefixes = new Set<string>()
  for (const m of body.matchAll(/p(?: ===|\.startsWith\()\s*'\/([a-z]+)[/']/g)) prefixes.add(m[1])
  for (const m of body.matchAll(/\/\^\\\/([a-z]+)\\\//g)) prefixes.add(m[1])

  it('finds the worker prefixes', () => {
    expect([...prefixes].sort()).toEqual(expect.arrayContaining(['api', 'img', 'rimg', 'tg']))
  })

  it.each([...prefixes])('/%s/* is in run_worker_first', (prefix) => {
    expect(first).toContain(`/${prefix}/*`)
  })
})

// Telegram to'liq ekran (Main App): Android WebView'da env(safe-area-inset-*) doim 0 — chekkalar SDK
// `--tg-(content-)safe-area-inset-*` dan. 2026-11-09: Kassa sarlavhasi «Yopish» tugmasi ostida qoldi.
// Bulut CSS'da env() faqat --safe-top/--safe-bottom ta'rifida bo'lsin; qolgan joylar shu o'zgaruvchilarni ishlatsin.
describe('fullscreen safe areas', () => {
  const read = (rel: string) => readFileSync(decodeURIComponent(new URL(rel, import.meta.url).pathname), 'utf8')
  const files = ['../../web/style.css', '../../web/components/Assistant.vue', '../../web/App.vue']

  it.each(files)('%s uses the Telegram-aware inset variables, not raw env()', (f) => {
    const lines = read(f).split('\n').filter((l) => l.includes('env(safe-area-inset') && !/--safe-(top|bottom):/.test(l))
    expect(lines).toEqual([])
  })

  it('defines the insets from Telegram SDK variables and pads the app shell', () => {
    const css = read('../../web/style.css')
    expect(css).toMatch(/--safe-top:[^;]*--tg-safe-area-inset-top/)
    expect(css).toMatch(/--chrome-top:[^;]*--tg-content-safe-area-inset-top/)
    expect(css).toMatch(/--safe-bottom:[^;]*--tg-safe-area-inset-bottom/)
    expect(css).toMatch(/\.app-shell\s*\{\s*padding-top:\s*var\(--chrome-top\)/)
    expect(read('../../web/App.vue')).toContain('class="app-shell ')
  })

  it('shared Pos page reads the cloud variables (desktop falls back to env)', () => {
    const pos = read('../../../src/pages/Pos.vue')
    expect(pos).toContain('var(--page-safe-top,env(safe-area-inset-top))')
    expect(pos).toContain('var(--page-safe-bottom,env(safe-area-inset-bottom))')
  })
})
