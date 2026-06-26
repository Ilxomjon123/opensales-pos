/**
 * OpenSales POS — backup proxy (Cloudflare Worker).
 *
 * Maqsad: GitHub backup tokenini mijoz app'idan butunlay olib tashlash.
 * POS faqat shu Worker bilan gaplashadi; token Worker secret'ida turadi.
 * POS bundle'da token YO'Q → o'rnatilgan app'dan o'g'irlab bo'lmaydi.
 *
 * Bu Worker Laravel backend'dan MUSTAQIL — POS to'liq offline ishlaydi,
 * faqat backup sync paytida (internet bor bo'lganda) shu Worker'ga boradi.
 *
 * Auth: POS har so'rovda yuboradi
 *   X-Device-Id    — qurilma ID (litsenziya payload'idagi `d` bilan mos bo'lishi shart)
 *   X-License-Key  — owner imzolagan Ed25519 kalit ("<payloadB64url>.<sigB64url>")
 * Worker imzoni LICENSE_PUBKEY bilan tekshiradi. Faqat haqiqiy litsenziyali
 * POS proxy'dan foydalana oladi (begona odam URL'ni topsa ham — yo'q).
 *
 * Scoping:
 *   - YOZISH (PUT): faqat `backups/<X-Device-Id>/...` — boshqa do'kon backupiga
 *     yozib bo'lmaydi (vandalizm yo'q).
 *   - O'QISH (list/raw): har qanday `backups/...` — yangi kompga ko'chirish
 *     (eski device backupini tiklash) shu uchun ishlaydi.
 *
 * Endpointlar (POS backup.ts mos):
 *   GET  /list?path=backups            → GitHub contents (JSON massiv)
 *   GET  /raw?path=backups/<dev>/<f>   → fayl (raw bayt yoki matn)
 *   PUT  /put?path=backups/<dev>/<f>   → body {content(b64), message} — create/update
 *
 * Cloudflare Worker → Settings → Variables (Secret):
 *   GH_TOKEN        — fine-grained PAT, faqat backup repo, contents:write
 *   GH_REPO         — "egasi/opensales-pos-backups"
 *   LICENSE_PUBKEY  — base64 Ed25519 public key (POS'dagi VITE_LICENSE_PUBKEY bilan bir xil)
 */

const GH = 'https://api.github.com';

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'X-Device-Id,X-License-Key,Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      const url = new URL(request.url);
      if (url.pathname === '/' || url.pathname === '/health') {
        return json({ ok: true }, 200, cors);
      }

      // --- Auth: license imzosini tekshir ---
      const deviceId = (request.headers.get('X-Device-Id') || '').trim();
      const licenseKey = (request.headers.get('X-License-Key') || '').trim();
      if (!deviceId || !licenseKey) return json({ error: 'no auth' }, 401, cors);
      if (!env.LICENSE_PUBKEY) return json({ error: 'pubkey not configured' }, 500, cors);
      const ok = await verifyLicense(deviceId, licenseKey, env.LICENSE_PUBKEY);
      if (!ok) return json({ error: 'bad license' }, 403, cors);

      if (!env.GH_TOKEN || !env.GH_REPO) return json({ error: 'gh not configured' }, 500, cors);

      const path = (url.searchParams.get('path') || '').replace(/^\/+/, '');
      // Yo'l faqat backups/ ichida bo'lsin (path traversal yo'q).
      if (!path.startsWith('backups/') && path !== 'backups') {
        return json({ error: 'path must be under backups/' }, 400, cors);
      }
      if (path.includes('..')) return json({ error: 'bad path' }, 400, cors);

      if (url.pathname === '/list' && request.method === 'GET') {
        return await ghList(path, env, cors);
      }
      if (url.pathname === '/raw' && request.method === 'GET') {
        return await ghRaw(path, env, cors);
      }
      if (url.pathname === '/put' && request.method === 'PUT') {
        // Yozish faqat o'z device papkasiga.
        if (!path.startsWith(`backups/${deviceId}/`)) {
          return json({ error: 'can only write own device backups' }, 403, cors);
        }
        return await ghPut(path, request, env, cors);
      }
      return json({ error: 'not found' }, 404, cors);
    } catch (err) {
      return json({ error: 'worker: ' + (err && err.message ? err.message : String(err)) }, 502, cors);
    }
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// --- GitHub contents API proxy ---
function ghHeaders(env, accept) {
  return { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: accept, 'User-Agent': 'opensales-pos-backup' };
}
async function ghList(path, env, cors) {
  const res = await fetch(`${GH}/repos/${env.GH_REPO}/contents/${encodePath(path)}`, {
    headers: ghHeaders(env, 'application/vnd.github+json'),
  });
  if (!res.ok) return json([], 200, cors); // bo'sh/yo'q → []
  const j = await res.json();
  return json(Array.isArray(j) ? j : [], 200, cors);
}
async function ghRaw(path, env, cors) {
  const res = await fetch(`${GH}/repos/${env.GH_REPO}/contents/${encodePath(path)}`, {
    headers: ghHeaders(env, 'application/vnd.github.raw'),
  });
  if (!res.ok) return new Response('not found', { status: res.status, headers: cors });
  // Baytlarni o'zgartirmasdan uzatamiz (db fayllar binary).
  return new Response(res.body, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream', ...cors },
  });
}
async function ghPut(path, request, env, cors) {
  let payload;
  try { payload = await request.json(); } catch { return json({ error: 'bad body' }, 400, cors); }
  const content = payload && payload.content;
  const message = (payload && payload.message) || `backup ${path}`;
  if (typeof content !== 'string') return json({ error: 'content required' }, 400, cors);

  // Mavjud bo'lsa sha (update uchun) — server o'zi oladi.
  let sha;
  const head = await fetch(`${GH}/repos/${env.GH_REPO}/contents/${encodePath(path)}`, {
    headers: ghHeaders(env, 'application/vnd.github+json'),
  });
  if (head.ok) { try { sha = (await head.json()).sha; } catch {} }

  const res = await fetch(`${GH}/repos/${env.GH_REPO}/contents/${encodePath(path)}`, {
    method: 'PUT',
    headers: { ...ghHeaders(env, 'application/vnd.github+json'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content, ...(sha ? { sha } : {}) }),
  });
  return json({ ok: res.ok }, res.ok ? 200 : 502, cors);
}
function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

// --- Ed25519 license imzo tekshiruvi (SubtleCrypto) ---
function b64ToBytes(s) {
  let t = s.trim().replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const bin = atob(t);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
async function verifyLicense(deviceId, licenseKey, pubkeyB64) {
  try {
    const [p, s] = licenseKey.split('.');
    if (!p || !s) return false;
    const msg = b64ToBytes(p);
    const sig = b64ToBytes(s);
    const pub = b64ToBytes(pubkeyB64);
    const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
    const valid = await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, msg);
    if (!valid) return false;
    const payload = JSON.parse(new TextDecoder().decode(msg));
    // Imzo device_id'ga bog'liq → boshqa qurilma nomidan ish ko'rib bo'lmaydi.
    return typeof payload.d === 'string' && payload.d === deviceId;
  } catch { return false; }
}
