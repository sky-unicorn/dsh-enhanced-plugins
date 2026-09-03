import { dshCheckout, exactDshAliases } from './tests/dsh-aliases.ts'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const dsh = dshCheckout

export default defineConfig({
  resolve: {
    alias: exactDshAliases({
      '@deepseek-ai/dsh-credentials': resolve(dsh, 'packages/credentials/credentials/lib/index.js'),
      '@deepseek-ai/dsh-client-ui-primitives': resolve(dsh, 'packages/client/ui-primitives/lib/index.js')
    }),
  },
  test: {
    environment: 'node',
    include: ['tests/plugin-market/**/*.spec.ts', 'tests/plugin-market/**/*.spec.tsx'],
  },
    })
