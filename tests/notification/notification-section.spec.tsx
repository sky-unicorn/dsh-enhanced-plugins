// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NotificationSection,
  type NotificationSectionFace,
  type NotificationSectionProps,
} from '../../src/notification/client/NotificationSection.tsx'
import { zh } from '../../src/notification/client/locales.ts'
import { DEFAULT_NOTIFICATION_SETTINGS } from '../../src/notification/shared.ts'
import type { NotificationCustomSound, NotificationSettings } from '../../src/notification/shared.ts'

afterEach(cleanup)

function renderSection(
  overrides: Partial<NotificationSectionFace> = {},
  customSounds: NotificationCustomSound[] = [],
  settingsOverrides: Partial<NotificationSettings> = {},
) {
  const selectSound = vi.fn(async () => {})
  const preview = vi.fn(async () => {})
  const upload = vi.fn(async () => {})
  const face: NotificationSectionFace = {
    hooks: { notificationSettings: {} as never },
    soundLibrary: {
      getSnapshot: () => customSounds,
      subscribe: () => () => {},
    },
    set: vi.fn(),
    selectSound,
    reset: vi.fn(),
    upload,
    preview,
    ...overrides,
  }
  const props = {
    ...face,
    useNotificationSettings: () => ({
      status: 'ready',
      value: { ...DEFAULT_NOTIFICATION_SETTINGS, ...settingsOverrides },
      base: { ...DEFAULT_NOTIFICATION_SETTINGS },
      user: {},
      revision: 1,
      writable: true,
      mode: 'host',
    }),
    t: (key: keyof typeof zh) => zh[key],
  } as unknown as NotificationSectionProps
  render(<NotificationSection {...props} />)
  return { selectSound, preview, upload }
}

describe('desktop notification sound controls', () => {
  it('keeps the classic pet by default and writes either additional pet style', () => {
    const set = vi.fn()
    renderSection({ set }, [], { petEnabled: true })

    const character = screen.getByLabelText(zh.petCharacter) as HTMLSelectElement
    expect(character.value).toBe('classic')
    expect(character.textContent).toContain(zh.petCharacterClassic)
    expect(character.textContent).toContain(zh.petCharacterMultiview)
    expect(character.textContent).toContain(zh.petCharacterWhaleGirl)

    fireEvent.change(character, { target: { value: 'multiview' } })
    expect(set).toHaveBeenCalledWith('petCharacter', 'multiview')
    fireEvent.change(character, { target: { value: 'whale-girl' } })
    expect(set).toHaveBeenCalledWith('petCharacter', 'whale-girl')
  })

  it('previews a playable selection after its settings write and supports manual replay', async () => {
    const { selectSound, preview } = renderSection()

    fireEvent.change(screen.getByLabelText(zh.completionSound), { target: { value: 'prominent' } })
    await waitFor(() => expect(preview).toHaveBeenCalledWith('completion'))
    expect(selectSound).toHaveBeenCalledWith('completion', 'prominent')
    expect(selectSound.mock.invocationCallOrder[0]).toBeLessThan(preview.mock.invocationCallOrder[0]!)

    fireEvent.click(screen.getByRole('button', { name: zh.previewCompletionSound }))
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(2))
  })

  it('keeps Off silent when selected', async () => {
    const { selectSound, preview } = renderSection()

    fireEvent.change(screen.getByLabelText(zh.confirmationSound), { target: { value: 'off' } })
    await waitFor(() => expect(selectSound).toHaveBeenCalledWith('confirmation', 'off'))
    expect(preview).not.toHaveBeenCalled()
  })

  it('offers an independent blocked-task sound with automatic and manual preview', async () => {
    const { selectSound, preview } = renderSection()

    fireEvent.change(screen.getByLabelText(zh.blockedSound), { target: { value: 'subtle' } })
    await waitFor(() => expect(selectSound).toHaveBeenCalledWith('blocked', 'subtle'))
    await waitFor(() => expect(preview).toHaveBeenCalledWith('blocked'))

    fireEvent.click(screen.getByRole('button', { name: zh.previewBlockedSound }))
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(2))
  })

  it('writes positive notification gain from both controls', () => {
    const set = vi.fn()
    renderSection({ set })

    fireEvent.change(screen.getByRole('slider', { name: zh.soundGain }), { target: { value: '65' } })
    expect(set).toHaveBeenCalledWith('soundGain', 65)
    fireEvent.change(screen.getByRole('spinbutton', { name: zh.soundGainPercent }), { target: { value: '40' } })
    expect(set).toHaveBeenCalledWith('soundGain', 40)
  })

  it('uploads multiple WAV files into the shared library without changing a selection', async () => {
    const { upload, preview } = renderSection()
    const ready = {
      name: 'ready.wav',
      size: 12,
      arrayBuffer: async () => Uint8Array.from([82, 73, 70, 70, 4, 0, 0, 0, 87, 65, 86, 69]).buffer,
    }
    const attention = { ...ready, name: 'attention.wav' }

    fireEvent.change(screen.getByLabelText(zh.chooseCustomSounds), {
      target: { files: [ready, attention] },
    })
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2))
    expect(upload).toHaveBeenNthCalledWith(1, 'ready.wav', expect.any(String))
    expect(upload).toHaveBeenNthCalledWith(2, 'attention.wav', expect.any(String))
    expect(preview).not.toHaveBeenCalled()
  })

  it('lists shared custom sounds in all three dropdowns and previews the selected file', async () => {
    const sounds = [
      { fileId: 'sound-11111111-1111-1111-1111-111111111111.wav', name: 'ready.wav' },
      { fileId: 'sound-22222222-2222-2222-2222-222222222222.wav', name: 'attention.wav' },
    ]
    const { selectSound, preview } = renderSection({}, sounds)
    const completion = screen.getByLabelText(zh.completionSound)
    const confirmation = screen.getByLabelText(zh.confirmationSound)
    const blocked = screen.getByLabelText(zh.blockedSound)
    expect(completion.textContent).toContain('ready.wav')
    expect(confirmation.textContent).toContain('attention.wav')
    expect(blocked.textContent).toContain('ready.wav')

    fireEvent.change(confirmation, { target: { value: `custom:${sounds[1]!.fileId}` } })
    await waitFor(() => expect(selectSound).toHaveBeenCalledWith(
      'confirmation', `custom:${sounds[1]!.fileId}`,
    ))
    await waitFor(() => expect(preview).toHaveBeenCalledWith('confirmation'))
  })

  it('renders an existing custom selection using its shared-library option', () => {
    const sounds = [{ fileId: 'sound-00000000-0000-0000-0000-000000000001.wav', name: 'done.wav' }]
    renderSection({}, sounds, {
      completionSound: 'custom',
      completionCustomSoundFile: sounds[0]!.fileId,
      completionCustomSoundName: sounds[0]!.name,
    })

    expect((screen.getByLabelText(zh.completionSound) as HTMLSelectElement).value)
      .toBe(`custom:${sounds[0]!.fileId}`)
  })
})
