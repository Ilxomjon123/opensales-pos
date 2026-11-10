import type { Role } from './auth/session'
import { isSubscriptionActive, type Subscription } from './shop/init'

// D1 registry so'rovlari (tenants, members, invites). Biznes mantiq yo'q — faqat SQL.

export type TenantRow = {
  id: string; name: string; owner_uid: number; trial_until: string; paid_until: string | null; status: 'active' | 'blocked'; created_at: string; ai_enabled?: number
  /** Biznes ildizi (birinchi do'kon id'si). Obuna guruh bo'ylab bir xil. */
  group_id: string
  /** Filial: katalog manbai (asosiy do'kon id'si). NULL — alohida do'kon. */
  catalog_of: string | null
}
export type MemberRow = { uid: number; tenant_id: string; role: Role; name: string; username: string | null; active: number; created_at: string }
export type MemberWithTenant = MemberRow & { tenant: TenantRow }

export type TenantState = 'trial' | 'paid' | 'expired' | 'blocked'

/** Yangi do'konga bepul sinov (kun): `TRIAL_DAYS` var, standart 7 (2026-11-09 user: 30 emas, 1 hafta). */
export const trialDays = (v: string | undefined): number => Math.max(1, Math.min(365, Math.round(Number(v)) || 7))
/** Do'kon holati (admin ro'yxati — bot va ilova bir xil): bloklangan > tugagan > to'langan > sinov. */
export function tenantState(t: TenantRow, now: string): TenantState {
  if (t.status === 'blocked') return 'blocked'
  if (!isSubscriptionActive(subscriptionOf(t), now)) return 'expired'
  return t.paid_until && t.paid_until >= t.trial_until ? 'paid' : 'trial'
}
/** Obuna qachongacha: sinov yoki to'lov muddatidan kechrog'i. */
export function tenantUntil(t: TenantRow): string {
  return [t.trial_until, t.paid_until].filter((x): x is string => !!x).sort().pop()!
}

/** Platforma admini: `ADMIN_CHAT_ID` (vergul bilan bir nechta) — shaxsiy chat id = Telegram user id. */
export function isAdminUid(adminChatId: string | undefined, uid: number): boolean {
  return !!adminChatId && adminChatId.split(',').map((x) => x.trim()).filter(Boolean).includes(String(uid))
}

export function subscriptionOf(t: TenantRow): Subscription {
  return { trialUntil: t.trial_until, paidUntil: t.paid_until, status: t.status }
}

const MEMBER_SELECT = `SELECT m.*, t.id t_id, t.name t_name, t.owner_uid t_owner_uid, t.trial_until t_trial_until, t.paid_until t_paid_until,
            t.status t_status, t.created_at t_created_at, t.ai_enabled t_ai_enabled, t.group_id t_group_id, t.catalog_of t_catalog_of
     FROM members m JOIN tenants t ON t.id = m.tenant_id`

function memberRow(r: Record<string, unknown>): MemberWithTenant {
  return {
    uid: r.uid as number, tenant_id: r.tenant_id as string, role: r.role as Role, name: r.name as string,
    username: (r.username as string | null) ?? null, active: r.active as number, created_at: r.created_at as string,
    tenant: {
      id: r.t_id as string, name: r.t_name as string, owner_uid: r.t_owner_uid as number, trial_until: r.t_trial_until as string,
      paid_until: (r.t_paid_until as string | null) ?? null, status: r.t_status as 'active' | 'blocked', created_at: r.t_created_at as string,
      ai_enabled: (r.t_ai_enabled as number | null) ?? 1, group_id: r.t_group_id as string, catalog_of: (r.t_catalog_of as string | null) ?? null,
    },
  }
}

/** Odamning aniq bir do'kondagi a'zoligi (faolmi — chaqiruvchi tekshiradi). */
export async function findMembership(db: D1Database, uid: number, tenantId: string): Promise<MemberWithTenant | null> {
  const r = await db.prepare(`${MEMBER_SELECT} WHERE m.uid = ? AND m.tenant_id = ?`).bind(uid, tenantId).first<Record<string, unknown>>()
  return r ? memberRow(r) : null
}

/** Odamning barcha do'konlari (faol va o'chirilgan), ochilgan tartibda. */
export async function listMemberships(db: D1Database, uid: number): Promise<MemberWithTenant[]> {
  const r = await db.prepare(`${MEMBER_SELECT} WHERE m.uid = ? ORDER BY t.created_at, t.id`).bind(uid).all<Record<string, unknown>>()
  return r.results.map(memberRow)
}

/**
 * Kirishda va botda standart do'kon: oxirgi tanlangani (faol bo'lsa) → birinchi faol a'zolik →
 * (hammasi o'chirilgan bo'lsa) birinchisi — chaqiruvchi "o'chirilgan" deb javob beradi. A'zolik yo'q — null.
 */
export async function defaultMembership(db: D1Database, uid: number): Promise<MemberWithTenant | null> {
  const all = await listMemberships(db, uid)
  if (all.length === 0) return null
  const pref = await db.prepare('SELECT active_tenant FROM user_prefs WHERE uid = ?').bind(uid).first<{ active_tenant: string | null }>()
  return all.find((m) => m.active && m.tenant_id === pref?.active_tenant) ?? all.find((m) => m.active) ?? all[0]
}

export async function setActiveTenant(db: D1Database, uid: number, tenantId: string, now = new Date()): Promise<void> {
  await db.prepare(
    'INSERT INTO user_prefs(uid, active_tenant, updated_at) VALUES(?,?,?) ON CONFLICT(uid) DO UPDATE SET active_tenant = excluded.active_tenant, updated_at = excluded.updated_at',
  ).bind(uid, tenantId, now.toISOString()).run()
}

export function randomId(bytes = 16): string {
  const b = new Uint8Array(bytes)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/**
 * Birinchi do'kon (yangi biznes ildizi) + egasi — onboarding. Bitta odam ikki marta bossa (yoki ikki tab)
 * ikkinchisi xato bermaydi: odam allaqachon biror do'konda EGA bo'lsa o'sha a'zolik qaytadi. Boshqa
 * do'konda faqat kassir bo'lgan odam o'z biznesini ochishi mumkin (har odamda bitta ildiz — unikal indeks).
 */
export async function createTenant(db: D1Database, p: { uid: number; name: string; username: string | null; shopName: string; trialDays: number; now: Date }): Promise<{ member: MemberWithTenant; created: boolean } | null> {
  const owned = async () => (await listMemberships(db, p.uid)).find((m) => m.role === 'owner' && m.active) ?? null
  const existing = await owned()
  if (existing) return { member: existing, created: false }
  const id = randomId()
  const nowIso = p.now.toISOString()
  const trialUntil = new Date(p.now.getTime() + p.trialDays * 86400_000).toISOString()
  try {
    // batch — bitta tranzaksiya: tenant va a'zo birga yoziladi yoki hech biri.
    await db.batch([
      db.prepare('INSERT INTO tenants(id, name, owner_uid, group_id, catalog_of, trial_until, paid_until, status, created_at) VALUES(?,?,?,?,NULL,?,NULL,\'active\',?)')
        .bind(id, p.shopName, p.uid, id, trialUntil, nowIso),
      db.prepare('INSERT INTO members(uid, tenant_id, role, name, username, active, created_at) VALUES(?,?,\'owner\',?,?,1,?)')
        .bind(p.uid, id, p.name, p.username, nowIso),
    ])
  } catch (e) {
    // Parallel ikkinchi so'rov: ildiz unikal — birinchisi yozgan a'zolikni qaytaramiz.
    const again = await owned()
    if (again) return { member: again, created: false }
    throw e
  }
  await setActiveTenant(db, p.uid, id, p.now)
  const member = await findMembership(db, p.uid, id)
  return member ? { member, created: true } : null
}

/** Guruhda ko'pi bilan shuncha do'kon (filiallar bilan). */
export const MAX_SHOPS_PER_GROUP = 10

export type CreateShopError = 'limit' | 'nameTaken' | 'badCatalogSource'

/**
 * Mavjud biznesga yangi do'kon: obuna muddatlari ildizdan (alohida sinov YO'Q — user qarori 2026-11-09).
 * `catalogOf` — filial: katalog manbai shu guruhdagi alohida (filial bo'lmagan) do'kon.
 * Yaratuvchi va biznes egasi (ildiz owner_uid) — ikkalasi ham ega. Ikki marta bosish: bir daqiqa ichida
 * o'sha nom bilan o'sha odam ochgan do'kon qaytadi.
 */
export async function createShop(db: D1Database, p: { creator: { uid: number; name: string; username: string | null }; groupId: string; shopName: string; catalogOf: string | null; now: Date }): Promise<{ member: MemberWithTenant; created: boolean } | { error: CreateShopError }> {
  const root = await findTenant(db, p.groupId)
  if (!root || root.group_id !== root.id) return { error: 'badCatalogSource' }
  const same = await db.prepare('SELECT * FROM tenants WHERE group_id = ? AND lower(name) = lower(?)').bind(p.groupId, p.shopName).first<TenantRow>()
  if (same) {
    const recent = same.owner_uid === p.creator.uid && p.now.getTime() - Date.parse(same.created_at) < 60_000 && same.catalog_of === p.catalogOf
    const m = recent ? await findMembership(db, p.creator.uid, same.id) : null
    return m ? { member: m, created: false } : { error: 'nameTaken' }
  }
  if (p.catalogOf) {
    const src = await findTenant(db, p.catalogOf)
    if (!src || src.group_id !== p.groupId || src.catalog_of) return { error: 'badCatalogSource' }
  }
  const count = await db.prepare('SELECT COUNT(*) c FROM tenants WHERE group_id = ?').bind(p.groupId).first<{ c: number }>()
  if ((count?.c ?? 0) >= MAX_SHOPS_PER_GROUP) return { error: 'limit' }
  const id = randomId()
  const nowIso = p.now.toISOString()
  const owners = [{ uid: p.creator.uid, name: p.creator.name, username: p.creator.username }]
  if (root.owner_uid !== p.creator.uid) {
    const rootOwner = await findMembership(db, root.owner_uid, root.id)
    owners.push({ uid: root.owner_uid, name: rootOwner?.name ?? String(root.owner_uid), username: rootOwner?.username ?? null })
  }
  try {
    await db.batch([
      db.prepare('INSERT INTO tenants(id, name, owner_uid, group_id, catalog_of, trial_until, paid_until, status, created_at, ai_enabled) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .bind(id, p.shopName, p.creator.uid, p.groupId, p.catalogOf, root.trial_until, root.paid_until, root.status, nowIso, root.ai_enabled ?? 1),
      ...owners.map((o) => db.prepare('INSERT INTO members(uid, tenant_id, role, name, username, active, created_at) VALUES(?,?,\'owner\',?,?,1,?)')
        .bind(o.uid, id, o.name, o.username, nowIso)),
    ])
  } catch (e) {
    // Parallel ikki so'rov bir xil nom bilan — unikal indeks; birinchisini qaytaramiz.
    const again = await db.prepare('SELECT * FROM tenants WHERE group_id = ? AND lower(name) = lower(?)').bind(p.groupId, p.shopName).first<TenantRow>()
    const m = again ? await findMembership(db, p.creator.uid, again.id) : null
    if (m) return { member: m, created: false }
    throw e
  }
  const member = await findMembership(db, p.creator.uid, id)
  return member ? { member, created: true } : { error: 'badCatalogSource' }
}

/** Guruh do'konlari (ildiz birinchi). */
export async function groupTenants(db: D1Database, groupId: string): Promise<TenantRow[]> {
  const r = await db.prepare('SELECT * FROM tenants WHERE group_id = ? ORDER BY (id = group_id) DESC, created_at, id').bind(groupId).all<TenantRow>()
  return r.results
}

/** Filiallar: shu do'kondan katalog oladiganlar. */
export async function branchesOf(db: D1Database, tenantId: string): Promise<TenantRow[]> {
  const r = await db.prepare('SELECT * FROM tenants WHERE catalog_of = ? ORDER BY created_at').bind(tenantId).all<TenantRow>()
  return r.results
}

// ---- Taklif havolalari (kassir yoki egasi) ----

export async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}

export const INVITE_TTL_DAYS = 7
export const INVITE_RE = /^[a-f0-9]{32}$/

/** Taklif: `owner` — boshqa Telegram akkauntni to'liq huquq bilan ulash (faqat asosiy ega yaratadi — handler tekshiradi). */
export async function createInvite(db: D1Database, tenantId: string, createdBy: number, now: Date, role: Role = 'cashier'): Promise<{ token: string; expiresAt: string }> {
  const token = randomId(16)
  const expiresAt = new Date(now.getTime() + INVITE_TTL_DAYS * 86400_000).toISOString()
  await db.prepare('INSERT INTO invites(token_hash, tenant_id, role, created_by, expires_at, created_at) VALUES(?,?,?,?,?,?)')
    .bind(await sha256hex(token), tenantId, role, createdBy, expiresAt, now.toISOString()).run()
  return { token, expiresAt }
}

/** Bot matni uchun: taklif hali ishlaydimi, qaysi rol va do'kon. */
export async function inviteInfo(db: D1Database, token: string, now: Date): Promise<{ role: Role; shopName: string } | null> {
  if (!INVITE_RE.test(token)) return null
  const r = await db.prepare(
    'SELECT i.role, t.name FROM invites i JOIN tenants t ON t.id = i.tenant_id WHERE i.token_hash = ? AND i.used_by IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?',
  ).bind(await sha256hex(token), now.toISOString()).first<{ role: Role; name: string }>()
  return r ? { role: r.role, shopName: r.name } : null
}

export type InviteError = 'invalid' | 'expired' | 'used' | 'alreadyMember'

/**
 * Taklifni qabul qilish: bir martalik. Muvaffaqiyatda yangi (yoki mavjud) a'zolik. Bir odam bir nechta
 * do'konda a'zo bo'la oladi (2026-11-09) — boshqa do'kondagi a'zolik to'sqinlik qilmaydi.
 */
export async function acceptInvite(db: D1Database, token: string, user: { uid: number; name: string; username: string | null }, now: Date): Promise<{ member: MemberWithTenant } | { error: InviteError }> {
  if (!INVITE_RE.test(token)) return { error: 'invalid' }
  const hash = await sha256hex(token)
  const inv = await db.prepare('SELECT * FROM invites WHERE token_hash = ?').bind(hash).first<{ tenant_id: string; role: Role; expires_at: string; used_by: number | null; revoked_at: string | null }>()
  if (!inv || inv.revoked_at) return { error: 'invalid' }
  const existing = await findMembership(db, user.uid, inv.tenant_id)
  if (existing) {
    // O'sha do'kon a'zosi havolani qayta ochgan — o'zgarish yo'q. Faqat faol kassir "egasi"
    // taklifini ochsa — egaga ko'tariladi (havola sarflanadi); egani taklif bilan pasaytirib bo'lmaydi.
    if (inv.used_by === user.uid) return { member: existing }
    if (existing.active && (existing.role === 'owner' || existing.role === inv.role)) return { member: existing }
  }
  if (inv.used_by !== null) return { error: 'used' }
  if (now.toISOString() >= inv.expires_at) return { error: 'expired' }
  const nowIso = now.toISOString()
  // Shartli UPDATE — ikki kishi bir vaqtda bossa faqat biri oladi.
  const claim = await db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE token_hash = ? AND used_by IS NULL AND revoked_at IS NULL')
    .bind(user.uid, nowIso, hash).run()
  if (!claim.meta.changes) return { error: 'used' }
  if (existing) {
    await db.prepare('UPDATE members SET active = 1, role = ?, name = ?, username = ? WHERE uid = ? AND tenant_id = ?').bind(inv.role, user.name, user.username, user.uid, inv.tenant_id).run()
  } else {
    await db.prepare('INSERT INTO members(uid, tenant_id, role, name, username, active, created_at) VALUES(?,?,?,?,?,1,?)')
      .bind(user.uid, inv.tenant_id, inv.role, user.name, user.username, nowIso).run()
  }
  await setActiveTenant(db, user.uid, inv.tenant_id, now)
  const member = await findMembership(db, user.uid, inv.tenant_id)
  return member ? { member } : { error: 'invalid' }
}

export async function listMembers(db: D1Database, tenantId: string): Promise<MemberRow[]> {
  const r = await db.prepare('SELECT * FROM members WHERE tenant_id = ? ORDER BY role DESC, created_at').bind(tenantId).all<MemberRow>()
  return r.results
}

export async function listInvites(db: D1Database, tenantId: string, now: Date) {
  const r = await db.prepare(
    'SELECT role, created_at, expires_at FROM invites WHERE tenant_id = ? AND used_by IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC',
  ).bind(tenantId, now.toISOString()).all<{ role: Role; created_at: string; expires_at: string }>()
  return r.results
}

export async function revokeInvites(db: D1Database, tenantId: string, now: Date): Promise<number> {
  const r = await db.prepare('UPDATE invites SET revoked_at = ? WHERE tenant_id = ? AND used_by IS NULL AND revoked_at IS NULL').bind(now.toISOString(), tenantId).run()
  return r.meta.changes ?? 0
}

/**
 * A'zoni yoqish/o'chirish. Asosiy ega (do'konni ochgan, tenants.owner_uid) hech qachon o'zgarmaydi;
 * ikkinchi egalar — faqat `canOwners` (chaqiruvchi asosiy ega) bo'lsa; kassirlar — har qanday ega.
 */
export async function setMemberActive(db: D1Database, tenantId: string, uid: number, active: boolean, canOwners = false): Promise<MemberRow | null> {
  const where = "tenant_id = ? AND uid = ? AND uid != (SELECT owner_uid FROM tenants WHERE id = ?) AND (role = 'cashier' OR ? = 1)"
  await db.prepare(`UPDATE members SET active = ? WHERE ${where}`).bind(active ? 1 : 0, tenantId, uid, tenantId, canOwners ? 1 : 0).run()
  return db.prepare(`SELECT * FROM members WHERE ${where}`).bind(tenantId, uid, tenantId, canOwners ? 1 : 0).first<MemberRow>()
}

// ---- Admin ----

export async function listTenants(db: D1Database, limit = 30) {
  const r = await db.prepare(
    `SELECT t.*, (SELECT COUNT(*) FROM members m WHERE m.tenant_id = t.id AND m.active = 1) members,
            (SELECT username FROM members m WHERE m.uid = t.owner_uid AND m.tenant_id = t.id) owner_username
     FROM tenants t ORDER BY (SELECT r.created_at FROM tenants r WHERE r.id = t.group_id) DESC, (t.id = t.group_id) DESC, t.created_at LIMIT ?`,
  ).bind(limit).all<TenantRow & { members: number; owner_username: string | null }>()
  return r.results
}

export async function findTenant(db: D1Database, id: string): Promise<TenantRow | null> {
  return db.prepare('SELECT * FROM tenants WHERE id = ?').bind(id).first<TenantRow>()
}

/** Prefiks bo'yicha (admin qisqa id yozadi). Bir nechta mos kelsa — null. */
export async function findTenantByPrefix(db: D1Database, prefix: string): Promise<TenantRow | null> {
  if (!/^[a-f0-9]{4,32}$/.test(prefix)) return null
  const r = await db.prepare('SELECT * FROM tenants WHERE id LIKE ? LIMIT 2').bind(prefix + '%').all<TenantRow>()
  return r.results.length === 1 ? r.results[0] : null
}

/** Obuna guruh bo'ylab (birinchi do'konga bog'langan): biznesning BARCHA do'konlari yangilanadi; qaytgan ro'yxat — DO'larga yuborish uchun. */
export async function setPaidUntil(db: D1Database, id: string, paidUntil: string): Promise<TenantRow[]> {
  await db.prepare('UPDATE tenants SET paid_until = ? WHERE group_id = (SELECT group_id FROM tenants WHERE id = ?)').bind(paidUntil, id).run()
  return groupOf(db, id)
}

export async function setTenantAi(db: D1Database, id: string, enabled: boolean): Promise<void> {
  await db.prepare('UPDATE tenants SET ai_enabled = ? WHERE id = ?').bind(enabled ? 1 : 0, id).run()
}

export async function setTenantStatus(db: D1Database, id: string, status: 'active' | 'blocked'): Promise<TenantRow[]> {
  await db.prepare('UPDATE tenants SET status = ? WHERE group_id = (SELECT group_id FROM tenants WHERE id = ?)').bind(status, id).run()
  return groupOf(db, id)
}

async function groupOf(db: D1Database, id: string): Promise<TenantRow[]> {
  const r = await db.prepare('SELECT * FROM tenants WHERE group_id = (SELECT group_id FROM tenants WHERE id = ?) ORDER BY created_at').bind(id).all<TenantRow>()
  return r.results
}
