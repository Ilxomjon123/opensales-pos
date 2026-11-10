import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Node testlari: op'lar node:sqlite ustida (tez) + desktop bilan paritet. Desktop
// src/lib/*.ts Tauri plaginlarini import qiladi — ular shu yerda shim'larga almashadi.
const here = path.dirname(fileURLToPath(import.meta.url))
const shim = (p: string) => path.join(here, 'test/node/shims', p)

export default defineConfig({
  test: {
    include: ['test/node/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@tauri-apps/plugin-sql': shim('plugin-sql.ts'),
      '@tauri-apps/api/core': shim('tauri-core.ts'),
    },
  },
})
