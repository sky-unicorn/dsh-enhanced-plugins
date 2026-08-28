import { exactDshAliases } from './tests/dsh-aliases.ts'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = import.meta.dirname

export default defineConfig({
  resolve: {
    alias: exactDshAliases({
      '@deepseek-ai/dsh-client-ui-primitives': resolve(root, 'tests/model-input-types/stubs/dsh-ui-primitives.tsx')
    }),
  },
  test: {
    environment: 'jsdom',
    include: ['tests/model-input-types/**/*.spec.ts', 'tests/model-input-types/**/*.spec.tsx'],
  },
    })
