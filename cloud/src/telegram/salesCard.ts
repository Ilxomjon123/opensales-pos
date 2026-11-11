import type { CardStats } from '../shop/cardStats'

// Egaga "Savdo" kartasi — Telegram HTML widget (Bot API 10.4). Sof qism (Telegram'siz): holat (chat_data),
// caption (widget'ni qo'llamaydigan ilova uchun matn) va HTML (uz/ru). Yuborish/yangilash — salesWidget.ts.
// Chegaralar (node testi qulflaydi): HTML ≤32 KB va zlib(9) ≤4096 bayt, chat_data ≤1024 bayt.
// Tovar/do'kon nomlari foydalanuvchidan — kartada faqat textContent bilan chiziladi.

/** Karta davri: so'rovda bir harf (`r:<do'kon>:<harf>`), hisobda answers.ts periodRange nomi. */
export const CARD_PERIODS = { t: 'today', y: 'yesterday', w: 'week', m: 'month' } as const
export type CardCode = keyof typeof CARD_PERIODS
export type CardLang = 'uz' | 'ru'

const DATA_MAX = 1000

/**
 * r — vaqt (ms), s — do'kon id (so'rov shu bilan keladi), p — davr harfi, n — do'kon nomi, c — valyuta,
 * v — [savdo, chek, foyda, naqd, karta, nasiya, vozvrat, xarajat, mijozlar qarzi, qarzdorlar], w — 7 kun, t — top tovarlar.
 */
export type SalesCardData = { r: number; s: string; p: CardCode; n: string; c: string; v: number[]; w: number[]; t: [string, number][] }

const money2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100
const cut = (s: string, n: number) => {
  const x = (s ?? '').replace(/\s+/g, ' ').trim()
  return x.length > n ? x.slice(0, n - 1) + '…' : x
}

export function salesCardData(shopId: string, code: CardCode, st: CardStats, now: Date): string {
  const data: SalesCardData = {
    r: now.getTime(),
    s: shopId,
    p: code,
    n: cut(st.shop, 28),
    c: cut(st.currency, 8),
    v: [st.total, st.count, st.profit, st.cash, st.card, st.debt, st.returns, st.expenses, st.receivable, st.debtors].map(money2),
    w: st.week.map(money2),
    t: st.top.slice(0, 3).map((x) => [cut(x.name, 26), money2(x.total)]),
  }
  const size = () => new TextEncoder().encode(JSON.stringify(data)).length
  while (data.t.length && size() > DATA_MAX) data.t.pop()
  if (size() > DATA_MAX) data.n = cut(data.n, 12)
  return JSON.stringify(data)
}

const LABELS = {
  uz: {
    p: ['Bugun', 'Kecha', '7 kun', 'Oy'], sales: 'Savdo', checks: '{n} ta chek', avg: "o'rtacha", profit: 'Foyda', cash: 'Naqd', card: 'Karta',
    debt: 'Nasiyaga', exp: 'Xarajat', ret: 'Qaytarildi', recv: 'Mijozlar qarzi', ppl: 'kishi', week: 'Oxirgi 7 kun', top: "Ko'p sotilgan",
    none: "Bu davrda savdo yo'q", re: '🔄 Yangilash', wait: 'Yangilanmoqda…', fail: 'Yuborilmadi', late: 'Javob kelmadi', deny: "Faqat do'kon egasi",
  },
  ru: {
    p: ['Сегодня', 'Вчера', '7 дней', 'Месяц'], sales: 'Продажи', checks: 'Чеков: {n}', avg: 'средний', profit: 'Прибыль', cash: 'Наличные', card: 'Карта',
    debt: 'В долг', exp: 'Расходы', ret: 'Возвраты', recv: 'Долги клиентов', ppl: 'чел.', week: 'Последние 7 дней', top: 'Топ товаров',
    none: 'За период продаж нет', re: '🔄 Обновить', wait: 'Обновляется…', fail: 'Не отправлено', late: 'Нет ответа', deny: 'Только владелец',
  },
} as const

const PERIOD_NAME: Record<CardLang, Record<CardCode, string>> = {
  uz: { t: 'Bugun', y: 'Kecha', w: '7 kun', m: 'Shu oy' },
  ru: { t: 'Сегодня', y: 'Вчера', w: '7 дней', m: 'Этот месяц' },
}

const num = (n: number) => {
  const r = money2(n)
  const [i, f] = String(Math.abs(r)).split('.')
  return (r < 0 ? '−' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (f ? ',' + f : '')
}

/** Widget'ni qo'llamaydigan ilova, chat ro'yxati va bildirishnoma shu matnni ko'rsatadi. */
export function salesCaption(st: CardStats, code: CardCode, lang: CardLang): string {
  const m = (x: number) => `${num(x)} ${st.currency}`
  const p = PERIOD_NAME[lang][code]
  return lang === 'ru'
    ? `🧾 ${st.shop} · ${p}: продажи ${m(st.total)}, чеков: ${st.count}, прибыль ${m(st.profit)}.`
    : `🧾 ${st.shop} · ${p}: savdo ${m(st.total)}, ${st.count} ta chek, foyda ${m(st.profit)}.`
}

export function salesCardHtml(lang: CardLang): string {
  return TEMPLATE.replace('__T__', JSON.stringify(LABELS[lang]))
}

// String.raw — regex'dagi `\d`, `\B` o'zgarmasdan qolsin. Skriptda apostrof yo'q (matnlar __T__ JSON'ida).
const TEMPLATE = String.raw`<!doctype html><html><head><style>
:root{--t:var(--tg-theme-text-color,#000);--h:var(--tg-theme-hint-color,#8e8e93);--b:var(--tg-theme-button-color,#000);--bt:var(--tg-theme-button-text-color,#fff);--s:var(--tg-theme-secondary-bg-color,#efeff4)}
body{margin:0;padding:10px 12px 12px;font:14px/1.3 system-ui,sans-serif;color:var(--t)}
.top{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
h3{margin:0;font-size:1.05em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.h{color:var(--h);font-size:.8em}
.chips{display:flex;gap:6px;margin:8px 0 10px}
button{font:inherit;border:0;border-radius:10px;padding:6px 10px;background:var(--s);color:var(--t)}
.chips button{flex:1;padding:5px 0;font-size:.85em}
.chips .on,.foot button{background:var(--b);color:var(--bt)}
.big{font-size:1.7em;font-weight:700;font-variant-numeric:tabular-nums;margin:1px 0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:10px 0 6px}
.tile{background:var(--s);border-radius:10px;padding:6px 8px;min-width:0}
.tile b{display:block;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.line{display:flex;justify-content:space-between;gap:8px;font-size:.88em;margin:3px 0}
.line span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.line span:last-child{font-variant-numeric:tabular-nums;white-space:nowrap}
.sec{color:var(--h);font-size:.8em;margin:10px 0 3px}
.chart,.days{display:flex;gap:5px}
.chart{align-items:flex-end;height:52px}
.chart i{flex:1;background:var(--b);border-radius:3px 3px 0 0;min-height:2px}
.days span{flex:1;text-align:center;color:var(--h);font-size:.7em}
.foot{display:flex;align-items:center;gap:8px;margin-top:10px}
</style></head><body>
<div class="top"><h3 id="n"></h3><span class="h" id="at"></span></div>
<div class="chips" id="chips"></div>
<div id="main"></div>
<div class="foot"><button id="re"></button><span class="h" id="st"></span></div>
<script>
var W=window.TelegramWidget,T=__T__,P=["t","y","w","m"],D=null,wait=null,timer=0;
function $(i){return document.getElementById(i)}
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function parse(){try{var x=JSON.parse(W&&W.chatData);if(x&&x.v)return x}catch(e){}return null}
function z(n){return(n<10?"0":"")+n}
function hm(ms){var d=new Date(ms+18e6);return z(d.getUTCDate())+"."+z(d.getUTCMonth()+1)+" "+z(d.getUTCHours())+":"+z(d.getUTCMinutes())}
function num(v){var r=Math.round(v*100)/100,a=Math.abs(r),i=Math.floor(a),f=Math.round((a-i)*100);return(r<0?"−":"")+String(i).replace(/\B(?=(\d{3})+(?!\d))/g," ")+(f?","+z(f):"")}
function money(v){return num(v)+" "+D.c}
function line(box,a,b){var r=el("div","line");r.appendChild(el("span","",a));r.appendChild(el("span","",b));box.appendChild(r)}
function tile(box,a,b){var t=el("div","tile");t.appendChild(el("span","h",a));t.appendChild(el("b","",b));box.appendChild(t)}
function draw(){
 var n=parse();if(n&&(!D||n.r>=D.r))D=n;
 if(wait&&D&&D.r>wait.r&&D.p===wait.p){wait=null;clearTimeout(timer);$("st").textContent=""}
 var cur=wait?wait.p:(D?D.p:"t"),c=$("chips"),m=$("main");c.innerHTML="";m.innerHTML="";$("re").textContent=T.re;
 P.forEach(function(p,i){var b=el("button",p===cur?"on":"",T.p[i]);b.onclick=function(){ask(p)};c.appendChild(b)});
 if(!D)return;
 var v=D.v;$("n").textContent="🧾 "+D.n;$("at").textContent=hm(D.r);
 m.appendChild(el("div","h",T.sales));
 m.appendChild(el("div","big",money(v[0])));
 m.appendChild(el("div","h",v[1]?T.checks.replace("{n}",v[1])+" · "+T.avg+" "+num(Math.round(v[0]/v[1])):T.none));
 var g=el("div","grid");tile(g,T.profit,money(v[2]));tile(g,T.cash,money(v[3]));tile(g,T.card,money(v[4]));tile(g,T.debt,money(v[5]));m.appendChild(g);
 if(v[7])line(m,T.exp,money(v[7]));
 if(v[6])line(m,T.ret,money(v[6]));
 line(m,T.recv+(v[9]?" · "+v[9]+" "+T.ppl:""),money(v[8]));
 m.appendChild(el("div","sec",T.week));
 var mx=Math.max.apply(null,D.w.concat([1])),ch=el("div","chart"),ds=el("div","days");
 D.w.forEach(function(x,i){var b=el("i");b.style.height=Math.max(0,Math.round(x*100/mx))+"%";ch.appendChild(b);ds.appendChild(el("span","",z(new Date(D.r-(6-i)*864e5).getUTCDate())))});
 m.appendChild(ch);m.appendChild(ds);
 if(D.t.length){m.appendChild(el("div","sec",T.top));D.t.forEach(function(x){line(m,x[0],money(x[1]))})}
}
function ask(p,bg){
 if(!W||!D)return;
 try{W.request("r:"+D.s+":"+p).then(function(a){if(a.result!=="ok"){wait=null;$("st").textContent=a.result==="forbidden"?T.deny:T.fail;draw()}},function(e){wait=null;if(!bg)$("st").textContent=T.fail+(e&&e.code?": "+e.code:"");draw()})}catch(e){if(!bg)$("st").textContent=T.fail;return}
 wait={p:p,r:D.r};$("st").textContent=bg?"":T.wait;draw();
 clearTimeout(timer);timer=setTimeout(function(){if(wait){wait=null;$("st").textContent=T.late;draw()}},25e3);
}
$("re").onclick=function(){ask(wait?wait.p:(D?D.p:"t"))};
if(W){W.onEvent("chatDataChanged",draw);W.onEvent("activated",function(){if(D&&Date.now()-D.r>12e4)ask(D.p,1)})}
draw();
if(W&&W.ready)W.ready();
if(D&&Date.now()-D.r>12e4)ask(D.p,1);
</script></body></html>`
