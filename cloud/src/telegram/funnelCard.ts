import type { FunnelRow } from '../funnel'

// Varonka kartasining sof qismi (Telegram'siz): holat (chat_data), caption va widget HTML'i.
// Node testi shu faylni to'g'ridan import qiladi (o'lcham chegaralari — test/node/funnelCard.test.ts).

export const FUNNEL_PERIODS = [1, 7, 30, 0] as const
const DATA_MAX = 1000

/** chat_data: r — yangilangan vaqt (ms), d — davr (kun, 0 = hammasi), s — bosqichlar, p — oxirgi odamlar. */
export type FunnelWidgetData = { r: number; d: number; s: number[]; p: [string, string, number, number, number][] }

const STAGE_KEYS = ['entered', 'started', 'opened', 'shop', 'product', 'sale', 'day2', 'pm'] as const

const cut = (s: string | null | undefined, n: number) => {
  const x = (s ?? '').replace(/\s+/g, ' ').trim()
  return x.length > n ? x.slice(0, n - 1) + '…' : x
}

/** Varonka hisobotidan kartaning ixcham holati — JSON har doim DATA_MAX baytdan oshmaydi. */
export function funnelWidgetData(report: { days: number; stages: Record<string, number>; rows: Pick<FunnelRow, 'name' | 'username' | 'uid' | 'shop_name' | 'products' | 'sales' | 'pm_at'>[] }, now: Date): string {
  const data: FunnelWidgetData = {
    r: now.getTime(),
    d: report.days,
    s: STAGE_KEYS.map((k) => Number(report.stages[k] ?? 0)),
    p: report.rows.slice(0, 5).map((x) => [
      cut(x.name || (x.username ? '@' + x.username : String(x.uid)), 18),
      cut(x.shop_name, 18),
      Number(x.products ?? 0),
      Number(x.sales ?? 0),
      x.pm_at ? 1 : 0,
    ]),
  }
  const size = () => new TextEncoder().encode(JSON.stringify(data)).length
  while (data.p.length && size() > DATA_MAX) data.p.pop()
  return JSON.stringify(data)
}

const periodLabel = (d: number) => (d === 0 ? 'hammasi' : `${d} kun`)

/** Widget'ni qo'llamaydigan Telegram (va chat ro'yxati, bildirishnoma) shu matnni ko'rsatadi. */
export function funnelCaption(stages: Record<string, number>, days: number): string {
  const n = (k: string) => Number(stages[k] ?? 0)
  return `📊 Varonka · ${periodLabel(days)}: ${n('entered')} kirdi → ${n('shop')} do'kon → ${n('product')} tovar → ${n('sale')} sotuv. Jonli karta ko'rinmasa — Telegram'ni yangilang.`
}

/**
 * Karta HTML'i. Ranglar Telegram mavzusidan (`--tg-theme-*`), shriftlar faqat tizimniki; balandlik o'zgaruvchan
 * (Telegram 50–600 px ga qisadi). `TelegramWidget` Telegram ichida skript boshlanishidan oldin bor.
 */
export const FUNNEL_WIDGET_HTML = `<!doctype html><html><head><style>
:root{--t:var(--tg-theme-text-color,#000);--h:var(--tg-theme-hint-color,#8e8e93);--b:var(--tg-theme-button-color,#000);--bt:var(--tg-theme-button-text-color,#fff);--s:var(--tg-theme-secondary-bg-color,#efeff4)}
body{margin:0;padding:10px 12px 12px;font:14px/1.3 system-ui,sans-serif;color:var(--t)}
.top{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
h3{margin:0;font-size:1.05em}
.at{color:var(--h);font-size:.8em}
.chips{display:flex;gap:6px;margin:8px 0 10px}
button{font:inherit;border:0;border-radius:10px;padding:6px 10px;background:var(--s);color:var(--t)}
.chips button{flex:1;padding:5px 0;font-size:.85em}
.chips .on{background:var(--b);color:var(--bt)}
.row{display:grid;grid-template-columns:7.2em 1fr 3.6em;align-items:center;gap:8px;margin:4px 0;font-size:.88em}
.bar{height:8px;border-radius:4px;background:var(--s);overflow:hidden}
.bar i{display:block;height:100%;border-radius:4px;background:var(--b)}
.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.n small{color:var(--h)}
.pm{color:var(--h);font-size:.8em;margin:6px 0 8px}
.p{display:flex;justify-content:space-between;gap:8px;font-size:.85em;padding:3px 0;border-top:1px solid var(--s)}
.p span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.p span:last-child{white-space:nowrap;color:var(--h);font-variant-numeric:tabular-nums}
.foot{display:flex;align-items:center;gap:8px;margin-top:10px}
.foot button{background:var(--b);color:var(--bt)}
.st{color:var(--h);font-size:.8em}
</style></head><body>
<div class="top"><h3>📊 Varonka</h3><span class="at" id="at"></span></div>
<div class="chips" id="chips"></div>
<div id="stages"></div>
<div class="pm" id="pm"></div>
<div id="people"></div>
<div class="foot"><button id="re">🔄 Yangilash</button><span class="st" id="st"></span></div>
<script>
var W=window.TelegramWidget,P=[1,7,30,0],L=['Kirdi','/start bosdi','Ilovani ochdi',"Do'kon ochdi","Tovar qo'shdi",'Sotuv qildi','2-kun qaytdi'],D=null,wait=null,timer=0;
function $(i){return document.getElementById(i)}
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function parse(){try{var x=JSON.parse(W&&W.chatData);if(x&&x.s)return x}catch(e){}return null}
function hm(ms){var d=new Date(ms+18e6);function z(n){return(n<10?'0':'')+n}return z(d.getUTCDate())+'.'+z(d.getUTCMonth()+1)+' '+z(d.getUTCHours())+':'+z(d.getUTCMinutes())}
function lbl(d){return d===0?'Hammasi':d+' kun'}
function draw(){
 var n=parse();if(n&&(!D||n.r>=D.r))D=n;
 if(wait&&D&&D.r>wait.r&&D.d===wait.d){wait=null;clearTimeout(timer);$('st').textContent=''}
 var cur=wait?wait.d:(D?D.d:7),c=$('chips');c.innerHTML='';
 P.forEach(function(d){var b=el('button',d===cur?'on':'',lbl(d));b.onclick=function(){ask(d)};c.appendChild(b)});
 var s=$('stages');s.innerHTML='';$('people').innerHTML='';
 if(!D){$('at').textContent='';return}
 $('at').textContent=hm(D.r);
 var all=D.s[0]||0;
 L.forEach(function(t,i){var v=D.s[i]||0,pc=all?Math.round(v*100/all):0,r=el('div','row');r.appendChild(el('span','',t));var b=el('div','bar'),f=el('i');f.style.width=pc+'%';b.appendChild(f);r.appendChild(b);var q=el('span','n',String(v)+' ');q.appendChild(el('small','',pc+'%'));r.appendChild(q);s.appendChild(r)});
 $('pm').textContent='Bot yoza oladi: '+(D.s[7]||0)+' / '+all;
 D.p.forEach(function(x){var r=el('div','p');r.appendChild(el('span','',x[0]+(x[1]?' · '+x[1]:'')));r.appendChild(el('span','',(x[4]?'':'🔕 ')+'📦'+x[2]+' 🧾'+x[3]));$('people').appendChild(r)});
}
function ask(d,bg){
 if(!W)return;
 try{W.request('d:'+d).then(function(a){if(a.result!=='ok'){wait=null;$('st').textContent=a.result==='forbidden'?'Ruxsat yo\\'q':'Xato: '+a.result;draw()}},function(e){wait=null;if(!bg)$('st').textContent='Yuborilmadi: '+(e&&e.code||'?');draw()})}catch(e){if(!bg)$('st').textContent='Yuborilmadi';return}
 wait={d:d,r:D?D.r:0};$('st').textContent=bg?'':'Yangilanmoqda…';draw();
 clearTimeout(timer);timer=setTimeout(function(){if(wait){wait=null;$('st').textContent='Javob kelmadi';draw()}},25e3);
}
$('re').onclick=function(){ask(wait?wait.d:(D?D.d:7))};
if(W){W.onEvent('chatDataChanged',draw);W.onEvent('activated',function(){if(D&&Date.now()-D.r>12e4)ask(D.d,1)})}
draw();
if(W&&W.ready)W.ready();
if(D&&Date.now()-D.r>12e4)ask(D.d,1);
</script></body></html>`
