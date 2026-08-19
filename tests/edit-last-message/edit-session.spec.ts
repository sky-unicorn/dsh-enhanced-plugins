import { describe, expect, it, vi } from 'vitest'
import { EditLastMessageClient } from '../../src/edit-last-message/client/edit-session.ts'

describe('EditLastMessageClient', () => {
  it('rewrites the addressed message through the same-session plugin Remote', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true,
      value: { accepted: true, replacementSeq: 42 },
    })
    const client = new EditLastMessageClient({ call } as never)

    await expect(client.rewrite('session-1' as never, { messageSeq: 7, text: 'revised' }))
      .resolves.toEqual({ accepted: true, replacementSeq: 42 })
    expect(call).toHaveBeenCalledWith('/api', 'editLastMessage/rewrite', {
      args: { request: { sessionId: 'session-1', messageSeq: 7, text: 'revised' } },
    })
  })

  it('surfaces Host refusal without creating or opening another session', async () => {
    const call = vi.fn().mockResolvedValue({ ok: false, error: { message: 'session is running' } })
    const client = new EditLastMessageClient({ call } as never)
    await expect(client.rewrite('session-1' as never, { messageSeq: 7, text: 'revised' }))
      .rejects.toThrow('session is running')
    expect(call).toHaveBeenCalledTimes(1)
  })
})
