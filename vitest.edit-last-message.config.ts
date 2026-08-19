import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = import.meta.dirname

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-llm': resolve(root, 'tests/edit-last-message/stubs/dsh-llm.ts'),
      '@deepseek-ai/dsh-client-runtime/client': resolve(root, 'tests/edit-last-message/stubs/dsh-client-runtime.ts'),
      '@deepseek-ai/dsh-client-ui-primitives': resolve(root, 'tests/edit-last-message/stubs/dsh-ui-primitives.tsx'),
      '@deepseek-ai/dsh-client-ui-attachment': resolve(root, 'tests/edit-last-message/stubs/dsh-ui-attachment.tsx'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/edit-last-message/**/*.spec.ts', 'tests/edit-last-message/**/*.spec.tsx'],
  },
})
