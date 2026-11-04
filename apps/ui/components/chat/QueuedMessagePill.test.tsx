// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { QueuedMessagePill } from './QueuedMessagePill'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: ReturnType<typeof createRoot> | undefined
afterEach(() => {
    act(() => { root?.unmount() })
    root = undefined
    document.body.innerHTML = ''
})

test('empty queues are inaccessible and inert while retaining the last message for the exit animation', async () => {
    const container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    const send = vi.fn()
    const discard = vi.fn()
    const render = (text: string | null) => act(async () => {
        root!.render(<QueuedMessagePill text={text} busy={false} pending={false} onSendNow={send} onDiscard={discard} />)
    })
    const sendButton = () => container.querySelector<HTMLButtonElement>('[aria-label="Send queued message now"]')!
    const removeButton = () => container.querySelector<HTMLButtonElement>('[aria-label="Remove queued message"]')!
    const strip = () => sendButton().closest<HTMLElement>('.grid')!

    await render(null)
    expect(strip().getAttribute('aria-hidden')).toBe('true')
    expect(strip().hasAttribute('inert')).toBe(true)
    expect(strip().classList.contains('grid-rows-[0fr]')).toBe(true)
    expect(sendButton().disabled).toBe(true)
    expect(removeButton().disabled).toBe(true)
    await act(async () => { sendButton().click(); removeButton().click() })
    expect(send).not.toHaveBeenCalled()
    expect(discard).not.toHaveBeenCalled()

    await render('Follow up after this reply')
    expect(strip().hasAttribute('aria-hidden')).toBe(false)
    expect(strip().hasAttribute('inert')).toBe(false)
    expect(strip().classList.contains('grid-rows-[1fr]')).toBe(true)
    expect(strip().textContent).toContain('Follow up after this reply')
    expect(sendButton().disabled).toBe(false)
    expect(removeButton().disabled).toBe(false)
    await act(async () => { sendButton().click(); removeButton().click() })
    expect(send).toHaveBeenCalledTimes(1)
    expect(discard).toHaveBeenCalledTimes(1)

    await render(null)
    expect(strip().getAttribute('aria-hidden')).toBe('true')
    expect(strip().hasAttribute('inert')).toBe(true)
    expect(strip().classList.contains('grid-rows-[0fr]')).toBe(true)
    expect(strip().textContent).toContain('Follow up after this reply')
    expect(strip().textContent).not.toContain('Attachments only')
    expect(sendButton().disabled).toBe(true)
    expect(removeButton().disabled).toBe(true)
    await act(async () => { sendButton().click(); removeButton().click() })
    expect(send).toHaveBeenCalledTimes(1)
    expect(discard).toHaveBeenCalledTimes(1)
})

test('a real queued message remains accessible while its pending actions are disabled', async () => {
    const container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    await act(async () => {
        root!.render(<QueuedMessagePill text="Still waiting" busy pending onSendNow={() => {}} onDiscard={() => {}} />)
    })
    const send = container.querySelector<HTMLButtonElement>('[aria-label="Send queued message now"]')!
    const strip = send.closest<HTMLElement>('.grid')!
    expect(strip.hasAttribute('aria-hidden')).toBe(false)
    expect(strip.hasAttribute('inert')).toBe(false)
    expect(strip.textContent).toContain('Still waiting')
    expect(send.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Remove queued message"]')!.disabled).toBe(true)
})
