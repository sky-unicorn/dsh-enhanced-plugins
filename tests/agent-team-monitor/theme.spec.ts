import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('consumes semantic tokens without pinning a color or branching on the Host theme', () => {
  const root = resolve(import.meta.dirname, '../../src/agent-team-monitor/client')
  const css = ['Panel.module.css', 'RoleSessions.module.css'].map(file => readFileSync(resolve(root, file), 'utf8')).join('\n')
  expect(css).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(|hsla?\(|--dsw-static-|--dsw-specific-|prefers-color-scheme|data-ds-dark-theme|\.dark\b|\.light\b/i)
  expect(css).toContain('--dsw-alias-bg-layer-2')
  expect(css).toContain(':focus-visible')
  for (const file of ['Panel.tsx', 'RoleSessions.tsx']) expect(readFileSync(resolve(root, file), 'utf8')).not.toMatch(/matchMedia|getComputedStyle/)
})
