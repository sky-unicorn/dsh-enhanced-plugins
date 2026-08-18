import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ModelInputTypesCard, type ModelInputTypesCardProps } from '../../src/model-input-types/client/ModelInputTypesCard.tsx'
import type { ModelInputTypesState } from '../../src/model-input-types/client/controller.ts'
import { en } from '../../src/model-input-types/client/locales.ts'

function propsOf(state: ModelInputTypesState, selectModelType = vi.fn()): ModelInputTypesCardProps {
  return {
    t: key => en[key],
    useModelInputTypes: selector => selector(state),
    selectModelType,
  } as ModelInputTypesCardProps
}

describe('ModelInputTypesCard', () => {
  it('renders all request-type choices and sends the selected row identity', () => {
    const selectModelType = vi.fn()
    render(<ModelInputTypesCard {...propsOf({
      available: true,
      writable: true,
      loading: false,
      saving: null,
      error: null,
      saved: false,
      providers: [{
        provider: 'gateway',
        displayName: 'Gateway',
        models: [{ id: 'vision', name: 'Vision', type: 'text' }],
      }],
    }, selectModelType)} />)

    fireEvent.click(screen.getByRole('button', { name: `${en.expand}: ${en.title}` }))
    const select = screen.getByRole('combobox', { name: 'Model type for gateway / vision' })
    expect([...select.querySelectorAll('option')].map(option => option.textContent)).toEqual([
      en.providerDefault,
      en.textOnly,
      en.textAndImages,
    ])
    fireEvent.change(select, { target: { value: 'multimodal' } })
    expect(selectModelType).toHaveBeenCalledWith('gateway', 0, 'vision', 'multimodal')
  })

  it('renders nothing while the owning namespace is unavailable', () => {
    const { container } = render(<ModelInputTypesCard {...propsOf({
      available: false,
      writable: false,
      loading: false,
      saving: null,
      error: null,
      saved: false,
      providers: [],
    })} />)
    expect(container.innerHTML).toBe('')
  })
})
