import { dshCheckout, exactDshAliases } from './tests/dsh-aliases.ts'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const dsh = dshCheckout
export default defineConfig({
  resolve: { alias: exactDshAliases({
      '@deepseek-ai/dsh-tools': resolve(dsh, 'packages/core/tools/lib/index.js'),
      '@deepseek-ai/dsh-settings': resolve(dsh, 'packages/settings/settings/lib/index.js'),
      '@deepseek-ai/dsh-storage': resolve(dsh, 'packages/storage/storage/lib/index.js'),
      '@deepseek-ai/dsh-storage-json': resolve(dsh, 'packages/storage/storage-json/lib/index.js'),
      '@deepseek-ai/dsh-storage-domain': resolve(dsh, 'packages/storage/storage-domain/lib/index.js'),
      '@deepseek-ai/cordis': resolve(dsh, 'vendor/cordis/lib/index.js'),
      '@deepseek-ai/dsh-session': resolve(dsh, 'packages/core/session/lib/index.js'),
      '@deepseek-ai/dsh-typert-protocol': resolve(dsh, 'packages/typert/protocol/lib/index.js'),
      '@deepseek-ai/dsh-experimental-agent-team': resolve(dsh, 'packages/experimental/agent-team/lib/index.js'),
      '@deepseek-ai/dsh-llm-retry': resolve(dsh, 'packages/llm/llm-retry/lib/index.js'),
      '@deepseek-ai/dsh-plan-mode': resolve(dsh, 'packages/plan/plan-mode/lib/index.js'),
      '@deepseek-ai/dsh-agent': resolve(dsh, 'packages/core/agent/lib/index.js'),
      '@deepseek-ai/dsh-agent-loop': resolve(dsh, 'packages/core/agent-loop/lib/index.js'),
      '@deepseek-ai/dsh-agent-loop-testkit': resolve(dsh, 'packages/test-support/agent-loop-testkit/lib/index.js'),
      '@deepseek-ai/dsh-llm': resolve(dsh, 'packages/llm/llm/lib/index.js'),
      '@deepseek-ai/dsh-session-persistence-jsonl': resolve(dsh, 'packages/session/session-persistence-jsonl/lib/index.js'),
      '@deepseek-ai/dsh-session-projection': resolve(dsh, 'packages/session/session-projection/lib/index.js'),
      '@deepseek-ai/dsh-session-query-sqlite': resolve(dsh, 'packages/session-query/session-query-sqlite/lib/index.js'),
      '@deepseek-ai/dsh-subagent': resolve(dsh, 'packages/subagent/subagent/lib/index.js'),
      '@deepseek-ai/dsh-subagent-spawn-in-process': resolve(dsh, 'packages/subagent/subagent-spawn-in-process/lib/index.js'),
      '@deepseek-ai/dsh-client-ui-primitives': resolve(import.meta.dirname, 'tests/agent-team-monitor/icons.tsx')
    }) },
  test: { environment: 'node', include: ['tests/model-router/**/*.spec.ts', 'tests/model-router/**/*.spec.tsx'] },
    })
