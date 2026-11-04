// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopQuickReplies } from './DesktopQuickReplies'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const message = (id = 'one', replies = ['Find more', 'Export CSV']) => ({ id, role: 'assistant', parts: [{ type: 'tool-suggest_replies', state: 'input-available', input: { replies } }] })
const roots: Root[] = []
function mount() {
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    roots.push(root)
    return root
}
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => { root.unmount() }); document.body.innerHTML = '' })
const buttons = () => [...document.querySelectorAll('button')]

test('original suggestion pills send the chosen label once and latch only after explicit acceptance', async () => {
    let finish!: (accepted: boolean) => void
    const onSend = vi.fn((_text: string) => new Promise<boolean>(resolve => { finish = resolve }))
    const root = mount()
    await act(async () => { root.render(<DesktopQuickReplies message={message()} onSend={onSend} />) })
    expect(buttons().map(button => button.textContent)).toEqual(['Find more', 'Export CSV'])
    expect(buttons().every(button => button.classList.contains('rounded-full'))).toBe(true)
    await act(async () => { buttons()[0].click(); buttons()[1].click() })
    expect(onSend).toHaveBeenCalledExactlyOnceWith('Find more')
    expect(buttons().every(button => button.disabled)).toBe(true)
    await act(async () => { finish(true) })
    expect(buttons().every(button => button.disabled)).toBe(true)
})

test.each([false, undefined, 'accepted'])('a non-true result releases the activation latch: %j', async result => {
    const onSend = vi.fn(async (_text: string) => result as boolean)
    const root = mount()
    await act(async () => { root.render(<DesktopQuickReplies message={message()} onSend={onSend} />) })
    await act(async () => { buttons()[0].click() })
    expect(buttons().every(button => !button.disabled)).toBe(true)
    await act(async () => { buttons()[1].click() })
    expect(onSend.mock.calls.map(([text]) => text)).toEqual(['Find more', 'Export CSV'])
})

test.each(['reject', 'throw'] as const)('a %s failure releases the latch without an uncaught click error', async mode => {
    const onSend = vi.fn((_text: string): Promise<boolean> => {
        if (mode === 'throw') throw new Error('Send failed')
        return Promise.reject(new Error('Send failed'))
    })
    const root = mount()
    await act(async () => { root.render(<DesktopQuickReplies message={message()} onSend={onSend} />) })
    await act(async () => { buttons()[0].click() })
    expect(buttons().every(button => !button.disabled)).toBe(true)
    await act(async () => { buttons()[0].click() })
    expect(onSend).toHaveBeenCalledTimes(2)
})

test('a stale activation settling cannot release a newer message’s pending latch', async () => {
    let rejectOld!: (cause: Error) => void, finishNew!: (accepted: boolean) => void
    const oldSend = vi.fn((_text: string) => new Promise<boolean>((_resolve, reject) => { rejectOld = reject }))
    const newSend = vi.fn((_text: string) => new Promise<boolean>(resolve => { finishNew = resolve }))
    const root = mount()
    await act(async () => { root.render(<DesktopQuickReplies message={message('old')} onSend={oldSend} />) })
    await act(async () => { buttons()[0].click() })
    await act(async () => { root.render(<DesktopQuickReplies message={message('new')} onSend={newSend} />) })
    await act(async () => { buttons()[1].click() })
    await act(async () => { rejectOld(new Error('Old send failed')) })
    expect(buttons().every(button => button.disabled)).toBe(true)
    expect(newSend).toHaveBeenCalledExactlyOnceWith('Export CSV')
    await act(async () => { finishNew(false) })
    expect(buttons().every(button => !button.disabled)).toBe(true)
})

test('hidden, disabled and pending states never dispatch, and labels remain plain text', async () => {
    const onSend = vi.fn(async (_text: string) => true)
    const root = mount()
    const unsafe = message('one', ['<img src=x onerror=alert(1)>'])
    await act(async () => { root.render(<DesktopQuickReplies message={unsafe} show={false} onSend={onSend} />) })
    expect(buttons()).toHaveLength(0)
    for (const state of [{ disabled: true }, { pending: true }]) {
        await act(async () => { root.render(<DesktopQuickReplies message={unsafe} {...state} onSend={onSend} />) })
        expect(buttons()[0].textContent).toBe('<img src=x onerror=alert(1)>')
        expect(document.querySelector('img')).toBeNull()
        await act(async () => { buttons()[0].click() })
    }
    expect(onSend).not.toHaveBeenCalled()
})
