import type { Draft, GroupRow } from '../shop/assistant'
import { EXPENSE_CATEGORIES } from '../assistant/ai'

// Bot yordamchisining tasdiqlash kartasi — Telegram HTML widget (Bot API 10.4), 2026-11-12.
// Bitta xabarning HAMMA amallari bitta kartada (guruh: birinchi qoralama id'si). Widget'da kiritish maydoni yo'q
// (faqat tugmalar) — tahrir tugmalar va kartaning o'z raqam paneli bilan; har tahrir `widget_query`
// (`y<op>:<qoralama id>[:arg]`, ≤64 bayt) → serverda oddiy `applyEdits` → `editMessageWidgetData`.
// Tasdiqlash/bekor — widget OSTIDAGI inline tugmalarda (widget'ni chizmaydigan eski ilovada ham ishlaydi).
// Sof qism (Telegram'siz): holat (chat_data ≤1024), caption, HTML (uz/ru). Yuborish — assistantBot.ts.
// Chegaralar (node testi qulflaydi): HTML ≤32 KB va zlib(9) ≤4096 bayt. Matnlar faqat textContent bilan.

export type WidgetLang = 'uz' | 'ru'

/** Qisqa tur kodlari (chat_data tejash). */
const KIND_CODE = { sale: 's', payment_in: 'i', payment_out: 'o', expense: 'e', receipt: 'r', product: 'p', customer: 'c' } as const
const METHOD_CODE = { cash: 'c', card: 'k', debt: 'd', transfer: 't' } as const
export type MethodCode = (typeof METHOD_CODE)[keyof typeof METHOD_CODE]
export const METHOD_OF: Record<MethodCode, Draft['method']> = { c: 'cash', k: 'card', d: 'debt', t: 'transfer' }

/** Widget qatori. Bo'sh/null maydonlar yozilmaydi. */
export type WidgetRow = {
  /** qoralama id */ i: string
  /** tur kodi */ k: string
  /** holat: o — ochiq, s — saqlandi, x — bekor, u — yangilandi (tuzatish bilan almashdi), e — muddati o'tgan */ s: 'o' | 's' | 'x' | 'u' | 'e'
  /** kim: mijoz / ta'minotchi */ n?: string
  /** yangi mijoz (saqlashda qo'shiladi) */ nw?: 1
  /** mijoz tanlash: aytilgan nom ("yangi" tugmasi uchun) va variantlar */ cq?: string
  co?: [number, string][]
  /** summa yoki jami */ a?: number
  /** summalar boshqa valyutada (tuzatilmagan) */ cu?: string
  m?: MethodCode
  /** qarzga sotuvda hozir to'langani */ pd?: number
  /** xarajat toifasi */ g?: string
  /** tovarlar: nom, miqdor, narx, birlik, aniqlangan(1/0), variantlar [id, nom] */
  it?: [string, number, number | null, string, 0 | 1, [number, string][]?][]
  /** narx tahrirlanadi (sotuvda faqat ega) */ pe?: 1
  /** yangi mijozlar: nom, saldo turi (d — u qarz, c — biz qarz, n — yo'q), summa */
  pp?: [string, 'd' | 'c' | 'n', number | null][]
  /** muammolar matni */ w?: string[]
  /** taklif qilingan kurs (o'tkazish tugmasi) */ fx?: number
  /** natija (chek raqami va h.k.) */ res?: string
  /** oxirgi saqlash xatosi */ e?: string
}
export type WidgetData = { r: number; g: string; c: string; l: WidgetRow[]; more?: number }

const DATA_MAX = 1000
const cut = (s: string | null | undefined, n: number) => {
  const x = (s ?? '').replace(/\s+/g, ' ').trim()
  return x.length > n ? x.slice(0, n - 1) + '…' : x
}
const r2 = (n: number) => Math.round(n * 100) / 100

function status(r: GroupRow): WidgetRow['s'] {
  if (r.draft.status === 'applied') return 's'
  if (r.draft.status === 'cancelled') return r.draft.replacedBy ? 'u' : 'x'
  return r.expired ? 'e' : 'o'
}

function result(d: Draft, l: WidgetLang): string | undefined {
  const r = d.result ?? {}
  if ((d.kind === 'sale' || d.kind === 'receipt') && r.receiptNumber) return `#${String(r.receiptNumber)}`
  if (d.kind === 'product' || d.kind === 'customer') return l === 'ru' ? `(${Number(r.count ?? 0)})` : `(${Number(r.count ?? 0)} ta)`
  return undefined
}

export type IssueText = (i: Draft['issues'][number], d: Draft) => string

/** Bitta qoralama → widget qatori (to'liq; sig'dirish — `draftWidgetData` da). */
export function widgetRow(row: GroupRow, l: WidgetLang, issue: IssueText, owner: boolean, error?: string): WidgetRow {
  const d = row.draft
  const s = status(row)
  const k = KIND_CODE[d.kind as keyof typeof KIND_CODE] ?? 's'
  const w: WidgetRow = { i: d.id, k, s }
  const open = s === 'o'
  if (d.kind === 'sale' || d.kind === 'payment_in' || d.kind === 'payment_out') {
    if (d.newCustomer && !d.customerId) { w.n = cut(d.newCustomer, 28); w.nw = 1 }
    else if (d.customerId && d.customerId !== d.walkInId) w.n = cut(d.customerName, 28)
    else if (d.customerQuery) w.n = `«${cut(d.customerQuery, 24)}»`
    if (open && !d.customerId && !d.newCustomer && d.customerOptions.length) {
      w.co = d.customerOptions.slice(0, 5).map((c) => [c.id, cut(c.name, 22)])
      if (owner && d.customerQuery) w.cq = cut(d.customerQuery, 24)
    }
    w.m = METHOD_CODE[d.method]
  }
  if (d.kind === 'receipt' && d.supplier) w.n = cut(d.supplier, 28)
  if (d.kind === 'expense') { w.g = d.category ?? undefined; if (d.note) w.n = cut(d.note, 40) }
  w.a = r2(d.kind === 'customer' ? d.total : d.kind === 'payment_in' || d.kind === 'payment_out' || d.kind === 'expense' ? d.amount ?? 0 : d.total)
  if (d.kind === 'sale' && d.method === 'debt' && d.paid != null) w.pd = r2(d.paid)
  if (d.spokenCurrency && d.issues.some((i) => i.code === 'currencyMismatch')) w.cu = d.spokenCurrency
  if (d.kind === 'sale' || d.kind === 'receipt' || d.kind === 'product') {
    w.it = d.items.map((it) => {
      const ok: 0 | 1 = d.kind === 'product' || it.productId ? 1 : 0
      const base: [string, number, number | null, string, 0 | 1, [number, string][]?] = [cut(it.name ?? it.query, 30), r2(it.qty), it.price == null ? null : r2(it.price), cut(it.unit ?? '', 8), ok]
      if (!ok && open && it.options.length) base.push(it.options.slice(0, 5).map((o) => [o.id, cut(o.name, 26)]))
      return base
    })
    if (d.kind !== 'sale' || owner) w.pe = 1
  }
  if (d.kind === 'customer') w.pp = (d.people ?? []).map((p) => [cut(p.name, 26), p.kind === 'debt' ? 'd' : p.kind === 'credit' ? 'c' : 'n', p.amount == null ? null : r2(p.amount)])
  if (open) {
    const texts = d.issues.map((i) => issue(i, d)).filter(Boolean)
    if (texts.length) w.w = texts.slice(0, 4).map((x) => cut(x, 90))
    if (d.fx && d.issues.length && d.issues.every((i) => i.code === 'currencyMismatch')) w.fx = d.fx.rate
  }
  if (!open) { const res = result(d, l); if (res) w.res = res }
  if (error && open) w.e = cut(error, 90)
  return w
}

const size = (x: unknown) => new TextEncoder().encode(JSON.stringify(x)).length

/**
 * Guruh → chat_data (≤1000 bayt). Sig'masa bosqichma-bosqich qisqaradi: variantlar → tovar qatorlari →
 * ogohlantirishlar → oxirgi qatorlar (`more` — ko'rinmay qolganlar soni, ularni ilovada ochish mumkin).
 */
export function draftWidgetData(g: string, rows: GroupRow[], l: WidgetLang, issue: IssueText, owner: boolean, currency: string, now: Date, errors: Record<string, string> = {}): string {
  const data: WidgetData = { r: now.getTime(), g, c: cut(currency, 8), l: rows.map((r) => widgetRow(r, l, issue, owner, errors[r.draft.id])) }
  const steps: ((w: WidgetRow) => void)[] = [
    (w) => { if (w.co) w.co = w.co.slice(0, 3); w.it?.forEach((it) => { if (it[5]) it[5] = it[5].slice(0, 3) }) },
    (w) => { delete w.co; w.it?.forEach((it) => { it.length = 5 }) },
    (w) => { if (w.it && w.it.length > 4) w.it = w.it.slice(0, 4); w.it?.forEach((it) => { it[0] = cut(it[0], 16) }) },
    (w) => { if (w.w) w.w = w.w.slice(0, 1).map((x) => cut(x, 50)); if (w.n) w.n = cut(w.n, 16) },
    (w) => { delete w.it; delete w.pp },
  ]
  for (const step of steps) {
    if (size(data) <= DATA_MAX) break
    data.l.forEach(step)
  }
  while (size(data) > DATA_MAX && data.l.length > 1) { data.l.pop(); data.more = (data.more ?? 0) + 1 }
  return JSON.stringify(data)
}

const LABELS = {
  uz: {
    k: { s: 'Sotuv', i: "Mijozdan to'lov", o: 'Qarz berildi', e: 'Xarajat', r: 'Kirim', p: 'Yangi tovar', c: 'Yangi mijoz' },
    many: '{n} ta amal', tap: "✎ — tahrirlash", m: { c: 'naqd', k: 'karta', d: 'qarzga', t: "o'tkazma" },
    st: { s: '✅ Saqlandi', x: '❌ Bekor qilindi', u: '↪️ Yangilandi', e: "⌛ Muddati o'tgan" },
    nw: '🆕 yangi mijoz', pick: 'Qaysi mijoz?', newc: '🆕 «{n}» — yangi', amt: 'Summa', price: 'Narx', qty: 'Miqdor', paid: "Hozir to'landi",
    owes: 'qarzi', owed: 'haqi', stock: 'qoldiq', fx: "💱 {r} kursida o'tkazish", save: '✓ Saqlash', cancel: 'Bekor',
    wait: 'Saqlanmoqda…', fail: 'Yuborilmadi', late: 'Javob kelmadi',
    er: { gone: "Bu qoralama eskirgan — qaytadan ayting", forbidden: "Ruxsat yo'q", bad: "Bo'lmadi" },
    cats: EXPENSE_CATEGORIES,
  },
  ru: {
    k: { s: 'Продажа', i: 'Оплата от клиента', o: 'Выдано в долг', e: 'Расход', r: 'Приход', p: 'Новый товар', c: 'Новый клиент' },
    many: 'Операций: {n}', tap: '✎ — изменить', m: { c: 'наличные', k: 'карта', d: 'в долг', t: 'перевод' },
    st: { s: '✅ Сохранено', x: '❌ Отменено', u: '↪️ Обновлено', e: '⌛ Истекло' },
    nw: '🆕 новый клиент', pick: 'Какой клиент?', newc: '🆕 «{n}» — новый', amt: 'Сумма', price: 'Цена', qty: 'Кол-во', paid: 'Оплачено сейчас',
    owes: 'долг', owed: 'мы должны', stock: 'остаток', fx: '💱 Пересчитать по {r}', save: '✓ Готово', cancel: 'Отмена',
    wait: 'Сохраняется…', fail: 'Не отправлено', late: 'Нет ответа',
    er: { gone: 'Черновик устарел — скажите заново', forbidden: 'Нет доступа', bad: 'Не получилось' },
    cats: EXPENSE_CATEGORIES,
  },
} as const

export function draftWidgetHtml(l: WidgetLang): string {
  return TEMPLATE.replace('__T__', JSON.stringify(LABELS[l]))
}

// String.raw — regex'dagi `\d`, `\B` o'zgarmasdan qolsin. Shablonda teskari qo'shtirnoq va `${` yo'q.
// FAQAT Mac'da sinalgan konstruksiyalar (Varonka/Savdo kartalarida bor): 2026-11-12 macOS Telegram shu kartada yiqilib
// (telefonda ishladi), «2 crash» qoidasi bilan botning HAMMA widget'larini to'xtatdi. Shuning uchun bu yerda YO'Q:
// div'ga bosish (faqat <button>, ichida faqat matn), `#id` CSS selektori, background:none, opacity, flex-wrap,
// grid span/repeat(), rgba(). Qulf: test/node/draftWidget.test.ts.
const TEMPLATE = String.raw`<!doctype html><html><head><style>
:root{--t:var(--tg-theme-text-color,#000);--h:var(--tg-theme-hint-color,#8e8e93);--b:var(--tg-theme-button-color,#2481cc);--bt:var(--tg-theme-button-text-color,#fff);--s:var(--tg-theme-secondary-bg-color,#efeff4);--bg:var(--tg-theme-bg-color,#fff);--d:var(--tg-theme-destructive-text-color,#e53935)}
body{margin:0;padding:8px 10px 10px;font:14px/1.3 system-ui,sans-serif;color:var(--t)}
.top{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.top b{white-space:nowrap}
.h{color:var(--h);font-size:.8em}
.row{background:var(--s);border-radius:10px;padding:7px 9px;margin-top:6px}
.done{color:var(--h)}
.line{display:flex;align-items:center;gap:6px}
.nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sub{font-size:.88em;margin-top:3px}
.am{font-variant-numeric:tabular-nums;white-space:nowrap}
.w{color:var(--d);font-size:.8em;margin-top:3px}
button{font:inherit;border:0;border-radius:8px;padding:5px 9px;background:var(--bg);color:var(--t)}
.on{background:var(--b);color:var(--bt)}
.x{padding:2px 8px}
.fl{display:flex;gap:5px;margin-top:6px}
.fl button{flex:1;padding:6px 0}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:6px}
.ed{border-top:1px solid var(--bg);margin-top:7px}
.pv{font-size:1.5em;font-weight:700;text-align:right;font-variant-numeric:tabular-nums;padding:2px 2px 4px}
.kp{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:5px}
.kp button{padding:9px 0;background:var(--s)}
.ms{margin-top:6px}
</style></head><body>
<div class="top"><b id="h"></b><span class="h" id="at"></span></div>
<div id="b"></div>
<div class="h ms" id="ms"></div>
<script>
var W=window.TelegramWidget,T=__T__,D=null,op=null,pad=null,busy=0,tm=0,IC={s:"🧾",i:"💵",o:"📤",e:"💸",r:"📦",p:"🆕",c:"👥"},MS={s:["c","k","d"],i:["c","k","t"],o:["c","k","t"]};
function $(i){return document.getElementById(i)}
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function bt(x,c,f){var b=el("button",c,x);b.onclick=function(){try{f()}catch(e){oops(e)}};return b}
function parse(){try{var x=JSON.parse(W&&W.chatData);if(x&&x.l)return x}catch(e){}return null}
function z(n){return(n<10?"0":"")+n}
function hm(ms){var d=new Date(ms+18e6);return z(d.getUTCHours())+":"+z(d.getUTCMinutes())}
function num(v){var r=Math.round(v*100)/100,a=Math.abs(r),i=Math.floor(a),f=Math.round((a-i)*100);return(r<0?"−":"")+String(i).replace(/\B(?=(\d{3})+(?!\d))/g," ")+(f?","+z(f):"")}
function mo(v,r){return num(v)+" "+(r.cu||D.c)}
function st(x){$("ms").textContent=x||""}
function oops(e){st("⚠️ "+(e&&e.message||e))}
function ask(q){if(!W||busy)return;try{W.request(q).then(function(a){var r=a&&a.result;if(r!=="ok"){busy=0;st(T.er[r]||T.fail);draw()}},function(e){busy=0;st(T.fail+(e&&e.code?": "+e.code:""));draw()})}catch(e){st(T.fail);return}busy=1;st(T.wait);clearTimeout(tm);tm=setTimeout(function(){if(busy){busy=0;st(T.late);draw()}},2e4);draw()}
function pd(q,t,v,w){pad={q:q,t:t+(w?" · "+w:""),v:v>0?String(Math.round(v*100)/100):""};draw()}
function key(k){var v=pad.v;if(k==="⌫")v=v.slice(0,-1);else if(k===","){if(v.indexOf(".")<0)v=(v||"0")+"."}else if(v.length<12)v=v==="0"?k:v+k;if(/\.\d{3}/.test(v))return;pad.v=v;draw()}
function kp(b){var p=pad.v.split("."),g=el("div","kp"),f=el("div","fl");b.appendChild(el("div","h",pad.t));b.appendChild(el("div","pv",num(+p[0]||0)+(p.length>1?","+p[1]:"")));
 ["1","2","3","⌫","4","5","6","000","7","8","9","0"].forEach(function(k){g.appendChild(bt(k,"",function(){key(k)}))});b.appendChild(g);
 f.appendChild(bt(",","",function(){key(",")}));f.appendChild(bt(T.cancel,"",function(){pad=null;draw()}));f.appendChild(bt(T.save,"on",function(){var v=+pad.v,q=pad.q;if(!(v>=0)||pad.v==="")return;pad=null;ask(q+v)}));b.appendChild(f)}
function line(x,r,it,j,ed){var l=el("div","line sub"),p=r.k==="p",c;l.appendChild(el("span","nm",(it[4]?"• ":"❓ ")+it[0]+(p?(it[1]?" · "+T.stock+" "+num(it[1])+" "+it[3]:""):it[4]?" × "+num(it[1])+(it[3]?" "+it[3]:""):"")));
 if(it[2]!=null)l.appendChild(el("b","am",mo(p?it[2]:it[1]*it[2],r)));x.appendChild(l);if(!ed)return;
 if(!it[4]&&it[5]){c=el("div","g2");it[5].forEach(function(o){c.appendChild(bt(o[1],"",function(){ask("yi:"+r.i+":"+j+":p:"+o[0])}))});x.appendChild(c);return}
 c=el("div","fl");
 if(!p){c.appendChild(bt("−","",function(){ask("yi:"+r.i+":"+j+":q:"+Math.max(0,it[1]-1))}));c.appendChild(bt("+","",function(){ask("yi:"+r.i+":"+j+":q:"+(it[1]+1))}))}
 c.appendChild(bt((p?T.stock:T.qty)+" ✎","",function(){pd("yi:"+r.i+":"+j+":q:",p?T.stock:T.qty,it[1],it[0])}));
 if(r.pe)c.appendChild(bt(T.price+" ✎","",function(){pd("yi:"+r.i+":"+j+":v:",T.price,it[2],it[0])}));
 c.appendChild(bt("✕","",function(){ask("yi:"+r.i+":"+j+":q:0")}));x.appendChild(c)}
function edit(x,r){var p=el("div","ed"),c;
 if(r.co){p.appendChild(el("div","h sub",T.pick));c=el("div","g2");r.co.forEach(function(o){c.appendChild(bt(o[1],"",function(){ask("yc:"+r.i+":"+o[0])}))});if(r.cq)c.appendChild(bt(T.newc.replace("{n}",r.cq),"",function(){ask("yc:"+r.i+":n")}));p.appendChild(c)}
 if(MS[r.k]){c=el("div","fl");MS[r.k].forEach(function(m){c.appendChild(bt(T.m[m],r.m===m?"on":"",function(){ask("ym:"+r.i+":"+m)}))});p.appendChild(c)}
 c=el("div","fl");
 if("ioe".indexOf(r.k)>=0)c.appendChild(bt(T.amt+" ✎","",function(){pd("ya:"+r.i+":",T.amt,r.a,r.n||T.k[r.k])}));
 if(r.k==="s"&&r.m==="d")c.appendChild(bt(T.paid+" ✎","",function(){pd("yd:"+r.i+":",T.paid,r.pd,r.n)}));
 if(r.fx)c.appendChild(bt(T.fx.replace("{r}",num(r.fx)),"on",function(){ask("yr:"+r.i+":"+r.fx)}));
 if("ioe".indexOf(r.k)>=0||r.k==="s"&&r.m==="d"||r.fx)p.appendChild(c);
 if(r.k==="e"){c=el("div","g2");T.cats.forEach(function(g,j){c.appendChild(bt(g,r.g===g?"on":"",function(){ask("yg:"+r.i+":"+j)}))});p.appendChild(c)}
 x.appendChild(p)}
function row(b,r){var o=r.s==="o",x=el("div","row"+(o?"":" done")),t=el("div","line"),many=D.l.length>1,s=[],ed=o&&op===r.i;
 if(many)t.appendChild(el("span","",IC[r.k]));t.appendChild(el("span","nm",many?T.k[r.k]+(r.n?" · "+r.n:""):(r.n||"")));
 if(r.a!=null&&r.k!=="p")t.appendChild(el("b","am",mo(r.a,r)));
 if(o){t.appendChild(bt("✎",ed?"x on":"x",function(){op=ed?null:r.i;draw()}));t.appendChild(bt("✕","x",function(){ask("yx:"+r.i)}))}x.appendChild(t);
 if(!o)s.push(T.st[r.s]+(r.res?" "+r.res:""));if(r.m)s.push(T.m[r.m]);if(r.pd!=null)s.push(T.paid+" "+mo(r.pd,r));if(r.nw)s.push(T.nw);if(r.g)s.push(r.g);
 if(s.length)x.appendChild(el("div","h",s.join(" · ")));
 (r.it||[]).forEach(function(it,j){line(x,r,it,j,ed)});
 (r.pp||[]).forEach(function(q,j){var l=el("div","line sub");l.appendChild(el("span","nm",q[0]+(q[1]!=="n"?" — "+(q[1]==="d"?T.owes:T.owed):"")));if(q[2]!=null)l.appendChild(el("b","am",mo(q[2],r)));if(ed){l.appendChild(bt("✎","x",function(){pd("yh:"+r.i+":"+j+":",T.amt,q[2],q[0])}));l.appendChild(bt("✕","x",function(){ask("yh:"+r.i+":"+j+":x")}))}x.appendChild(l)});
 (r.w||[]).forEach(function(w){x.appendChild(el("div","w","⚠️ "+w))});if(r.e)x.appendChild(el("div","w",r.e));
 if(ed)edit(x,r);b.appendChild(x)}
function draw(){try{dr()}catch(e){oops(e)}}
function dr(){var n=parse();if(n&&(!D||n.r>D.r)){if(D&&busy){busy=0;clearTimeout(tm);st("")}D=n}else if(n&&!D)D=n;
 var b=$("b");b.innerHTML="";if(!D)return;var o=D.l.some(function(r){return r.s==="o"});
 $("h").textContent=D.l.length>1?T.many.replace("{n}",D.l.length+(D.more||0)):IC[D.l[0].k]+" "+T.k[D.l[0].k];$("at").textContent=o?T.tap:hm(D.r);
 if(pad&&o){kp(b);return}pad=null;D.l.forEach(function(r){row(b,r)});if(D.more)b.appendChild(el("div","h","+"+D.more))}
if(W)W.onEvent("chatDataChanged",draw);
draw();
if(W&&W.ready)W.ready();
</script></body></html>`

/** Widget'ni qo'llamaydigan ilova, chat ro'yxati va bildirishnoma uchun qisqa matn (oddiy matn, escape chaqiruvchida). */
export function draftWidgetCaption(rows: Draft[], l: WidgetLang, kindLabel: (d: Draft) => string, money: (n: number, d: Draft) => string): string {
  if (rows.length === 1) {
    const d = rows[0]
    const w = widgetRow({ draft: d, expired: false }, l, () => '', true)
    return [kindLabel(d), w.n, w.a ? money(w.a, d) : null].filter(Boolean).join(' · ')
  }
  const parts = rows.map((d) => {
    const w = widgetRow({ draft: d, expired: false }, l, () => '', true)
    return [w.n, w.a ? money(w.a, d) : null].filter(Boolean).join(' ')
  })
  const head = l === 'ru' ? `🧾 Операций: ${rows.length}` : `🧾 ${rows.length} ta amal`
  return cut(`${head}: ${parts.join(', ')}`, 400)
}
