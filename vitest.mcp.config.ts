import { dshCheckout, exactDshAliases } from './tests/dsh-aliases.ts'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: exactDshAliases({
      '@deepseek-ai/cordis': resolve(dshCheckout, 'vendor/cordis/lib/index.js'),
      '@deepseek-ai/schemastery': resolve(dshCheckout, 'vendor/schemastery/lib/index.mjs'),
      '@deepseek-ai/dsh-settings': resolve(dshCheckout, 'packages/settings/settings/lib/index.js'),
      '@deepseek-ai/dsh-typert-protocol': resolve(dshCheckout, 'packages/typert/protocol/lib/index.js'),
      '@deepseek-ai/dsh-mcp-client': resolve(dshCheckout, 'packages/mcp/mcp-client/lib/index.js'),
    }),
  },
  test: {
    environment: 'node',
    include: ['tests/mcp-server-manager/**/*.spec.ts'],
  },
})
