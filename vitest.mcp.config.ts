import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = import.meta.dirname

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-settings': resolve(root, 'tests/mcp-server-manager/stubs/dsh-settings.ts'),
      '@deepseek-ai/dsh-typert-protocol': resolve(root, 'tests/mcp-server-manager/stubs/dsh-typert-protocol.ts'),
      '@deepseek-ai/dsh-client-runtime/client': resolve(root, 'tests/mcp-server-manager/stubs/dsh-client-runtime-client.ts'),
      '@deepseek-ai/dsh-mcp-client': resolve(root, 'tests/mcp-server-manager/stubs/dsh-mcp-client.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/mcp-server-manager/**/*.spec.ts'],
  },
})
