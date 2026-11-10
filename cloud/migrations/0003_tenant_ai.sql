-- Admin do'kon uchun AI yordamchini yoqib/o'chira oladi. Standart — yoqilgan (mavjud do'konlar ham).
ALTER TABLE tenants ADD COLUMN ai_enabled INTEGER NOT NULL DEFAULT 1;
