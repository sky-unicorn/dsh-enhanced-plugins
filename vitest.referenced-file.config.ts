import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = import.meta.dirname

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-llm': resolve(root, 'tests/referenced-file/stubs/dsh-llm.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/referenced-file/**/*.spec.ts'],
  },
})
