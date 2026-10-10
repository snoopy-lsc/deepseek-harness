import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { include: ['packages/*/tests/**/*.e2e.ts'], testTimeout: 120_000, hookTimeout: 120_000 } })
