import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const dsh = resolve(import.meta.dirname, '../deepseek-harness')
export default defineConfig({
  resolve: { alias: {
    '@deepseek-ai/cordis': resolve(dsh, 'vendor/cordis/lib/index.js'),
    '@deepseek-ai/dsh-session': resolve(dsh, 'packages/core/session/lib/index.js'),
    '@deepseek-ai/dsh-typert-protocol': resolve(dsh, 'packages/typert/protocol/lib/index.js'),
    '@deepseek-ai/dsh-experimental-agent-team': resolve(dsh, 'packages/experimental/agent-team/lib/index.js'),
    '@deepseek-ai/dsh-agent-loop': resolve(dsh, 'packages/core/agent-loop/lib/index.js'),
    '@deepseek-ai/dsh-agent-loop-testkit': resolve(dsh, 'packages/test-support/agent-loop-testkit/lib/index.js'),
    '@deepseek-ai/dsh-llm': resolve(dsh, 'packages/llm/llm/lib/index.js'),
    '@deepseek-ai/dsh-session-persistence-jsonl': resolve(dsh, 'packages/session/session-persistence-jsonl/lib/index.js'),
    '@deepseek-ai/dsh-session-projection': resolve(dsh, 'packages/session/session-projection/lib/index.js'),
    '@deepseek-ai/dsh-subagent': resolve(dsh, 'packages/subagent/subagent/lib/index.js'),
    '@deepseek-ai/dsh-subagent-spawn-in-process': resolve(dsh, 'packages/subagent/subagent-spawn-in-process/lib/index.js'),
    '@deepseek-ai/dsh-client-runtime/client': resolve(import.meta.dirname, 'tests/agent-team-monitor/store.ts'),
    '@deepseek-ai/dsh-client-ui-primitives': resolve(import.meta.dirname, 'tests/agent-team-monitor/icons.tsx'),
  } },
  test: { environment: 'node', include: ['tests/agent-team-monitor/**/*.spec.ts', 'tests/agent-team-monitor/**/*.spec.tsx'] },
})
