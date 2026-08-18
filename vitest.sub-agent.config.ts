import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const dsh = resolve(import.meta.dirname, '../deepseek-harness')

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/cordis': resolve(dsh, 'vendor/cordis/lib/index.js'),
      '@deepseek-ai/dsh-settings': resolve(dsh, 'packages/settings/settings/lib/index.js'),
      '@deepseek-ai/dsh-tool-subagent': resolve(dsh, 'packages/subagent/tool-subagent/lib/index.js'),
      '@deepseek-ai/dsh-typert-protocol': resolve(dsh, 'packages/typert/protocol/lib/index.js'),
      '@deepseek-ai/dsh-client-ui-primitives': resolve(dsh, 'packages/client/ui-primitives/lib/index.js'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/sub-agent/**/*.spec.ts', 'tests/sub-agent/**/*.spec.tsx'],
  },
})
