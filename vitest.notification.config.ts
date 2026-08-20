import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = import.meta.dirname
const dsh = resolve(root, '../deepseek-harness')

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/cordis': resolve(dsh, 'vendor/cordis/lib/index.js'),
      '@deepseek-ai/dsh-settings': resolve(dsh, 'packages/settings/settings/lib/index.js'),
      '@deepseek-ai/dsh-typert-protocol': resolve(root, 'tests/mcp-server-manager/stubs/dsh-typert-protocol.ts'),
      '@deepseek-ai/dsh-client-ui-primitives': resolve(root, 'tests/notification/stubs/ui-primitives.tsx'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/notification/**/*.spec.ts', 'tests/notification/**/*.spec.tsx'],
  },
})
