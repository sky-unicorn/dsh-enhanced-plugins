// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { McpCardShell } from '../../src/mcp-server-manager/client/McpCardShell.tsx'
import { en } from '../../src/mcp-server-manager/client/locales.ts'

afterEach(cleanup)

it('saves explicitly and discards the current draft when the configuration page closes', () => {
  const save = vi.fn()
  const discard = vi.fn()
  const state = { available: true, writable: true, dirty: true, invalid: false, saving: false, failed: false }
  const page = render(<McpCardShell t={key => en[key]} state={state} onSave={save} onDiscard={discard}>
    <input aria-label="Fixture server" />
  </McpCardShell>)
  expect(screen.getByRole('textbox')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.save }))
  expect(save).toHaveBeenCalledTimes(1)
  expect(discard).not.toHaveBeenCalled()
  page.unmount()
  expect(discard).toHaveBeenCalledTimes(1)
})
