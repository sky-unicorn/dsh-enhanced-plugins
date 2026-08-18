import { describe, expect, it } from 'vitest'
import {
  detectHashTrigger, formatFileReference, replaceHashTrigger,
} from '../../src/referenced-file/client/references.ts'
import { ReferencedFilesClient } from '../../src/referenced-file/client/remote.ts'

describe('client # reference codec', () => {
  it('detects a query at the caret after whitespace', () => {
    expect(detectHashTrigger('请查看 #src/ind', 12)).toEqual({ start: 4, end: 12, query: 'src/ind' })
  })

  it('does not reopen an explicit selected marker', () => {
    expect(detectHashTrigger('use #<src/index.ts>', 18)).toBeUndefined()
  })

  it('escapes explicit markers and replaces only the active token', () => {
    expect(formatFileReference('docs/a>b\\c.md')).toBe('#<docs/a\\>b\\\\c.md>')
    expect(replaceHashTrigger('read #sr now', { start: 5, end: 8, query: 'sr' }, 'src/a file.ts')).toEqual({
      draft: 'read #<src/a file.ts> now',
      caret: 21,
    })
  })

  it('rejects invalid caret positions and punctuation queries', () => {
    expect(detectHashTrigger('#src', -1)).toBeUndefined()
    expect(detectHashTrigger('#src,', 5)).toBeUndefined()
  })

  it('rejects a Host response exceeding the 20-candidate wire cap', async () => {
    const rpc = {
      async call() {
        return {
          ok: true as const,
          value: {
            candidates: Array.from({ length: 21 }, (_, index) => ({ path: `file-${String(index)}.ts` })),
            truncated: false,
          },
        }
      },
    }
    const client = new ReferencedFilesClient(rpc as never)
    await expect(client.list('session', '')).rejects.toThrow('invalid response')
  })
})
