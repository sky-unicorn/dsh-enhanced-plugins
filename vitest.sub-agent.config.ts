import { dshCheckout, exactDshAliases } from './tests/dsh-aliases.ts'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const dsh = dshCheckout

export default defineConfig({
  resolve: {
    alias: exactDshAliases({
      '@deepseek-ai/cordis': resolve(dsh, 'vendor/cordis/lib/index.js'),
      '@deepseek-ai/schemastery': resolve(dsh, 'vendor/schemastery/lib/index.mjs'),
      '@deepseek-ai/dsh-app-boot': resolve(dsh, 'packages/boot/app-boot/lib/index.js'),
      '@deepseek-ai/dsh-config-editor': resolve(dsh, 'packages/boot/config-editor/lib/index.js'),
      '@deepseek-ai/dsh-settings': resolve(dsh, 'packages/settings/settings/lib/index.js'),
      '@deepseek-ai/dsh-tool-subagent': resolve(dsh, 'packages/subagent/tool-subagent/lib/index.js'),
      '@deepseek-ai/dsh-typert-protocol': resolve(dsh, 'packages/typert/protocol/lib/index.js'),
      '@deepseek-ai/dsh-client-ui-primitives': resolve(dsh, 'packages/client/ui-primitives/lib/index.js')
    }),
  },
  test: {
    environment: 'node',
    include: ['tests/sub-agent/**/*.spec.ts', 'tests/sub-agent/**/*.spec.tsx'],
  },
})
