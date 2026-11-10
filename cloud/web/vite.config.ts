import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { parse as parseSfc } from 'vue/compiler-sfc'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// OpenSales Kassa (Telegram Mini App) — desktop pos-tauri sahifalari bilan BITTA kod.
// Sahifalar `../lib/db` deb import qiladi; bu plugin shunday importlarni absolyut yo'l
// bo'yicha bulut modullariga almashtiradi (ma'lumot — Worker RPC orqali). Desktop
// fayllari o'zgarmaydi; Tauri plaginlari bundle'ga tushsa build yiqiladi.

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '../../src')
const WEB = here

const SWAP: Record<string, string> = {
  [path.join(SRC, 'lib/db.ts')]: path.join(WEB, 'lib/db.ts'),
  [path.join(SRC, 'lib/stock.ts')]: path.join(WEB, 'lib/stock.ts'),
  [path.join(SRC, 'lib/reports.ts')]: path.join(WEB, 'lib/reports.ts'),
  [path.join(SRC, 'lib/print.ts')]: path.join(WEB, 'lib/print.ts'),
  [path.join(SRC, 'lib/xlsx.ts')]: path.join(WEB, 'lib/xlsx.ts'),
  [path.join(SRC, 'lib/platform.ts')]: path.join(WEB, 'lib/platform.ts'),
  [path.join(SRC, 'lib/auth.ts')]: path.join(WEB, 'lib/auth.ts'),
  [path.join(SRC, 'lib/i18n.ts')]: path.join(WEB, 'lib/i18n.ts'),
  [path.join(SRC, 'lib/theme.ts')]: path.join(WEB, 'lib/theme.ts'),
  [path.join(SRC, 'components/SearchableSelect.vue')]: path.join(WEB, 'components/SearchableSelect.vue'),
}
const TAURI_CORE_SHIM = path.join(WEB, 'shim/tauri-core.ts')

function cloudSwap(): Plugin {
  return {
    name: 'opensales-cloud-swap',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer) return null
      const imp = importer.split('?')[0]
      // Bulut modullarining o'zi desktop faylni (masalan, sof funksiyalar uchun) import
      // qilishi mumkin — ularni qayta almashtirmaymiz (aks holda o'ziga aylanib qoladi).
      if (imp.startsWith(WEB + path.sep)) return null
      if (source === '@tauri-apps/api/core' && imp.startsWith(SRC + path.sep)) return TAURI_CORE_SHIM
      const r = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (r && SWAP[r.id]) return SWAP[r.id]
      return null
    },
    generateBundle(_o, bundle) {
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type !== 'chunk') continue
        const bad = chunk.moduleIds.filter((id) => /@tauri-apps[\\/](plugin-|api[\\/](?!core))/.test(id) || id === path.join(SRC, 'lib/db.ts'))
        if (bad.length) this.error(`Desktop-only module in cloud bundle (${name}): ${bad.join(', ')}`)
      }
    },
  }
}

// Ochilish/yopilishi animatsiyali bo'lishi kerak bo'lgan modal komponentlar (ildizi `fixed inset-0`).
const MODAL_TAGS = new Set(['ReturnSaleModal', 'CustomerReturnModal', 'NewReturnModal', 'StockReceiptModal', 'QrScanner', 'LicenseAdmin', 'LogViewer'])

type TplProp = { type: number; name: string; value?: { content: string }; arg?: { content: string }; exp?: { content: string } }
type TplNode = { type: number; tag?: string; content?: string | { content: string }; props?: TplProp[]; children?: TplNode[]; loc: { start: { offset: number }; end: { offset: number } } }

const nodeText = (n: TplNode): string =>
  n.type === 2 ? String(n.content ?? '') : n.type === 5 ? `{{${(n.content as { content: string })?.content ?? ''}}}` : (n.children ?? []).map(nodeText).join('')
const clickOf = (n: TplNode) => n.props?.find((p) => p.type === 7 && p.name === 'on' && p.arg?.content === 'click')?.exp?.content
function* elements(nodes: TplNode[]): Generator<TplNode> {
  for (const n of nodes) { if (n.type === 1) { yield n; yield* elements(n.children ?? []) } }
}
/** Ochiluvchi teg oxiri (`>`) — qo'shtirnoq ichidagilarni hisobga olmay. */
function startTagEnd(code: string, from: number): number {
  let q = ''
  for (let i = from; i < code.length; i++) {
    const c = code[i]
    if (q) { if (c === q) q = '' } else if (c === '"' || c === "'") q = c
    else if (c === '>') return i + 1
  }
  return -1
}
const X_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'

/**
 * Modal oynaga o'ng yuqori burchakda ✕ (telefonda yopishning odatiy joyi). ✕ modalning o'z
 * "Bekor qilish" (bo'lmasa "Yopish") tugmasi bilan AYNAN bir xil ifodani chaqiradi — yopishdagi
 * mantiq (masalan, ConfirmDialog va'dasini hal qilish) buzilmaydi. ✕ allaqachon bo'lsa — qo'shilmaydi.
 */
function modalCloseInserts(code: string, nodes: TplNode[]): [number, string][] {
  const out: [number, string][] = []
  for (const n of elements(nodes)) {
    const cls = n.props?.find((p) => p.type === 6 && p.name === 'class')?.value?.content ?? ''
    if (!(/\bfixed\b/.test(cls) && /\binset-0\b/.test(cls) && /\bbg-black\//.test(cls))) continue
    const card = (n.children ?? []).find((c) => c.type === 1)
    if (!card) continue
    const buttons = [...elements(card.children ?? [])].filter((b) => b.tag === 'button')
    const pick = (re: RegExp) => buttons.find((b) => re.test(nodeText(b)) && clickOf(b))
    const close = clickOf(pick(/common\.cancel|cancelText/) ?? pick(/common\.close/) ?? ({} as TplNode))
    if (!close) continue
    const hasX = buttons.some((b) => clickOf(b) === close && (b.children ?? []).some((c) => c.type === 1 && c.tag === 'X'))
    if (hasX) continue
    const at = startTagEnd(code, card.loc.start.offset)
    if (at < 0) continue
    out.push([at, `<button type="button" class="os-modal-x" :aria-label="$t('common.close')" @click="${close.replace(/"/g, '&quot;')}">${X_SVG}</button>`])
  }
  return out
}

/** `v-if` li modal ildizlarini topadi (statik klassda `fixed inset-0` yoki MODAL_TAGS), allaqachon <Transition> ichidagini emas. */
function modalSpans(nodes: TplNode[], inTransition = false, out: [number, number][] = []): [number, number][] {
  nodes.forEach((n, i) => {
    if (n.type !== 1) return
    const tag = n.tag ?? ''
    const props = n.props ?? []
    const vIf = props.some((p) => p.type === 7 && p.name === 'if')
    // Keyingi element v-else/v-else-if bo'lsa — zanjirni buzmaslik uchun o'ramaymiz.
    const next = nodes.slice(i + 1).find((x) => x.type === 1)
    const chained = !!next?.props?.some((p) => p.type === 7 && (p.name === 'else' || p.name === 'else-if'))
    const cls = props.find((p) => p.type === 6 && p.name === 'class')?.value?.content ?? ''
    const modal = MODAL_TAGS.has(tag) || (/\bfixed\b/.test(cls) && /\binset-0\b/.test(cls))
    if (vIf && modal && !chained && !inTransition) out.push([n.loc.start.offset, n.loc.end.offset])
    modalSpans(n.children ?? [], inTransition || /^transition(-group)?$/i.test(tag) || /^Transition(Group)?$/.test(tag), out)
  })
  return out
}

/**
 * Telefon uslubi, faqat bulut build'ida (desktop fayllari o'zgarmaydi), kompilyatsiyadan oldin:
 * 1) `v-if` li modallar `<Transition name="os-modal">` ga o'raladi — ochilish/yopilish silliq
 *    (style.css → os-modal). 2) Native `<select>` → `GlassSelect`, `<input type="date">` →
 *    `GlassDate` (main.ts'da global): native ro'yxat va OS kalendari Telegram webview'da eski
 *    ko'rinadi. `v-model`, `<option>`, `min/max`, `id` saqlanadi.
 */
const MONEY_FIELD = /price|cost|amount|paid|cash|card|discount/i

function cloudTemplates(): Plugin {
  const own = path.join(WEB, 'components') + path.sep
  return {
    name: 'opensales-cloud-templates',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]
      if (!file.endsWith('.vue') || id.includes('?vue&') || file.startsWith(own)) return null
      if (!file.startsWith(SRC + path.sep) && !file.startsWith(WEB + path.sep)) return null
      let out = code
      const ast = parseSfc(code, { filename: file }).descriptor.template?.ast as { children: TplNode[] } | undefined
      if (ast) {
        // Hamma qo'shimchalar asl matn joylashuvlari bo'yicha, oxiridan boshiga qo'llanadi.
        const ins: [number, string][] = modalCloseInserts(code, ast.children)
        for (const [a, b] of modalSpans(ast.children)) ins.push([a, '<Transition name="os-modal">'], [b, '</Transition>'])
        ins.sort((x, y) => y[0] - x[0])
        for (const [at, text] of ins) out = `${out.slice(0, at)}${text}${out.slice(at)}`
      }
      out = out
        .replace(/<select(\s|>)/g, '<GlassSelect$1')
        .replace(/<\/select>/g, '</GlassSelect>')
        // type="date" tugmaga o'tmasin (button type="date" → submit bo'lib qoladi).
        .replace(/<input(\s[^>]*?\btype="date"[^>]*?)\s*\/?>/g, (_m, a: string) => `<GlassDate${a.replace(/\s+type="date"/, '')} />`)
        // Pul maydonlari (narx, summa, naqd...) → MoneyInput: 15 000 000 guruhlash + valyuta. Miqdorlar (qty, stock) tegilmaydi.
        .replace(/<input\b((?:[^>"']|"[^"]*"|'[^']*')*?)\s*\/?>/g, (m, a: string) => {
          if (!/\btype="number"/.test(a)) return m
          const vm = /v-model\.number="([^"]+)"/.exec(a)
          const last = vm?.[1].split('.').pop() ?? ''
          // Miqdorlar va o'z kengligini hisoblaydigan maydon (:style) — o'zgarmaydi; `data-money` belgisi bo'lsa
          // (kassa savatidagi narx) — baribir MoneyInput, desktop kengligi (:style) tashlanadi.
          const forced = /\sdata-money\b/.test(a)
          if (!vm || !MONEY_FIELD.test(last) || /^(qty|stock|copies|value|count|percent)$|(Qty|Stock|Count)$/.test(last) || (/:style=/.test(a) && !forced)) return m
          const rest = a.replace(/\s+data-money\b/, '').replace(/\s+:style="[^"]*"/, '').replace(/\s+type="number"/, '').replace(/\s+(min|step|inputmode)="[^"]*"/g, '').replace(`v-model.number="${vm[1]}"`, `v-model="${vm[1]}"`)
          return `<MoneyInput${rest} />`
        })
      return out === code ? null : { code: out, map: null }
    },
  }
}

/** FAQAT lokal dev: Telegram'siz brauzerda initData imzolab beradi (token .dev.vars'dan). */
function devInitData(): Plugin {
  return {
    name: 'opensales-dev-initdata',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev/init-data', async (req, res) => {
        const vars = fs.readFileSync(path.join(here, '../.dev.vars'), 'utf8')
        const token = /^BOT_TOKEN\s*=\s*"?([^"\n]+)"?/m.exec(vars)?.[1]
        if (!token) { res.statusCode = 500; res.end('BOT_TOKEN missing in .dev.vars'); return }
        const url = new URL(req.url ?? '', 'http://x')
        const uid = Number(url.searchParams.get('uid') || '700000001')
        const name = url.searchParams.get('name') || 'Dev Ega'
        const startParam = url.searchParams.get('start')
        const { signInitData } = await server.ssrLoadModule(path.join(here, '../src/auth/initData.ts'))
        const fields: Record<string, string> = {
          auth_date: String(Math.floor(Date.now() / 1000)),
          query_id: 'AAEdev',
          user: JSON.stringify({ id: uid, first_name: name, username: `dev${uid}`, language_code: url.searchParams.get('lang') || 'uz' }),
        }
        if (startParam) fields.start_param = startParam
        res.setHeader('Content-Type', 'text/plain')
        res.end(await signInitData(fields, token))
      })
    },
  }
}

export default defineConfig({
  root: here,
  envDir: path.resolve(here, '../..'),
  // comments: false — izohli ildiz dev'da fragment bo'lib, <Transition> modalni animatsiya qilmasdi.
  plugins: [cloudSwap(), cloudTemplates(), devInitData(), vue({ template: { compilerOptions: { comments: false } } }), tailwindcss()],
  resolve: {
    alias: { '@': SRC },
  },
  build: {
    outDir: path.resolve(here, '../dist-web'),
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
  },
  server: {
    port: 5190,
    strictPort: true,
    host: '127.0.0.1',
    // Telefonda sinash uchun vaqtinchalik HTTPS tunnel (cloudflared quick tunnel) — faqat dev server.
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/api': 'http://127.0.0.1:8790',
      '/img': 'http://127.0.0.1:8790',
    },
  },
})
