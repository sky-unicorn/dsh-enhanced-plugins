// @vitest-environment jsdom
import { act, createRef, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
import { NativeModelLock } from '../../src/model-router/client/NativeModelLock.tsx'

it('covers only the local native seat, closes its menu and restores the same control on off/dispose', async () => {
  const container = document.createElement('div')
  container.innerHTML = '<div><div data-slot="conversation.input.right"><div id="anchor"></div></div><div data-slot="conversation.input.model"><div><button aria-haspopup="menu" aria-expanded="true">original</button></div></div></div><div data-slot="conversation.input.model"><button>other composer</button></div>'
  document.body.append(container)
  const anchor = createRef<HTMLElement>()
  Object.assign(anchor, { current: container.querySelector('#anchor') })
  const seats = container.querySelectorAll<HTMLElement>('[data-slot="conversation.input.model"]')
  const seat = seats[0]!
  const native = seat.querySelector('button')!
  let clicks = 0
  native.onclick = () => { clicks++; native.setAttribute('aria-expanded', 'false') }
  const root = createRoot(anchor.current!)
  const render = (active: boolean, label = 'Collaboration active') => act(async () => root.render(<NativeModelLock anchor={anchor} active={active} label={label} title="Managed"/>))
  await render(false)
  expect(seat.className).toBe('')
  await render(true)
  expect(clicks).toBe(1)
  expect(seat.className).not.toBe('')
  expect(seats[1]!.className).toBe('')
  const status = seat.querySelector<HTMLButtonElement>('[data-dsh-router-model-status]')!
  expect(status.disabled).toBe(true)
  expect(status.hasAttribute('aria-haspopup')).toBe(false)
  await render(true, '多模型协作中')
  expect(status.textContent).toBe('多模型协作中')
  await render(false)
  expect(seat.className).toBe('')
  expect(seat.querySelector('[data-dsh-router-model-status]')).toBeNull()
  expect(seat.querySelector('button')).toBe(native)
  native.click()
  expect(clicks).toBe(2)
  await render(true)
  await act(async () => root.unmount())
  expect(seat.className).toBe('')
  expect(seat.querySelector('button')).toBe(native)
  container.remove()
})

it('waits for the parent composer ref before locating the native seat', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  function Composer() {
    const anchor = useRef<HTMLDivElement>(null)
    return <div><div data-slot="conversation.input.right"><div ref={anchor}><NativeModelLock anchor={anchor} active label="Managed" title="Managed"/></div></div><div data-slot="conversation.input.model"><button>original</button></div></div>
  }
  const root = createRoot(container)
  await act(async () => root.render(<Composer/>))
  expect(container.querySelector('[data-dsh-router-model-status]')?.textContent).toBe('Managed')
  await act(async () => root.unmount())
  container.remove()
})
