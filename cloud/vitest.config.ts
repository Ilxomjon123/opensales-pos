import path from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Worker testlari: haqiqiy workerd (miniflare) ichida — DO SQLite, D1, routing.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'))
      return {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            BOT_TOKEN: '123456:TEST-bot-token-for-vitest-only',
            SESSION_KEY: 'test-session-key-0123456789abcdef0123456789abcdef',
            TG_WEBHOOK_SECRET: 'test-webhook-secret',
            ADMIN_CHAT_ID: '777',
            APP_URL: 'https://kassa.test',
            TG_API_BASE: 'https://tg.mock',
          },
        },
      }
    }),
  ],
  test: {
    include: ['test/worker/**/*.test.ts'],
    setupFiles: ['./test/worker/apply-migrations.ts'],
  },
})
