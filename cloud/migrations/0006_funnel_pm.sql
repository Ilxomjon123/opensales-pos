-- Bot shu odamga yoza oladimi (2026-11-10). Telegram bot faqat /start bosgan yoki mini app'da "xabar yozishga
-- ruxsat" bergan odamga yoza oladi; reklamadan ilovani to'g'ridan ochganlarga yozib bo'lmaydi ("chat not found").
--  * pm_at — bot yoza olishi ma'lum bo'lgan vaqt: /start, initData `allows_write_to_pm`, ilovadagi ruxsat oynasi.
--    Telegram "chat not found" / "bot was blocked" desa — NULL (qayta ruxsat bersa yana yoziladi).
--  * Eslatmalar faqat pm_at bor odamlarga (aks holda yiqilib, o'sha eslatma turi butunlay yo'qolardi).
ALTER TABLE funnel_users ADD COLUMN pm_at TEXT;

-- Mavjudlar: /start bosganlar va bot xabari muvaffaqiyatli yetganlar (masalan, 2026-11-10 asoschi xabari).
UPDATE funnel_users SET pm_at = COALESCE(
  started_at,
  (SELECT MIN(n.at) FROM nudges n WHERE n.uid = funnel_users.uid AND n.status = 'sent')
);
