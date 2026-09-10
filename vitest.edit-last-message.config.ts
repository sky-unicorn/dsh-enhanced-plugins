import { dshCheckout, exactDshAliases } from './tests/dsh-aliases.ts'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = import.meta.dirname
const dsh = dshCheckout

export default defineConfig({
  resolve: {
    alias: exactDshAliases({
      '@dsh-test/session-format-v0-to-v1-validation': resolve(
        dsh,
        'packages/session/session-format-v0-to-v1/src/payload-validation.ts',
      ),
      '@deepseek-ai/dsh-llm': resolve(root, 'tests/edit-last-message/stubs/dsh-llm.ts'),
      '@deepseek-ai/dsh-session-format': resolve(dsh, 'packages/session/session-format/lib/index.js'),
      '@deepseek-ai/dsh-session-format-v2-to-v3': resolve(dsh, 'packages/session/session-format-v2-to-v3/lib/index.js'),
      '@deepseek-ai/dsh-session': resolve(dsh, 'packages/core/session/lib/index.js'),
      '@deepseek-ai/dsh-client-ui-primitives': resolve(root, 'tests/edit-last-message/stubs/dsh-ui-primitives.tsx'),
      '@deepseek-ai/dsh-client-ui-attachment': resolve(root, 'tests/edit-last-message/stubs/dsh-ui-attachment.tsx')
    }),
  },
  test: {
    environment: 'jsdom',
    include: ['tests/edit-last-message/**/*.spec.ts', 'tests/edit-last-message/**/*.spec.tsx'],
  },
})
