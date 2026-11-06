// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: { root: Root; host: HTMLElement }[] = []
function render(node: ReactNode) {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push({ root, host })
    act(() => root.render(node))
    return { rerender: (next: ReactNode) => act(() => root.render(next)) }
}
const screen = {
    getByRole: (role: string, options?: { name: string }) => {
        const element = [...document.querySelectorAll(role === 'button' ? 'button' : `[role="${role}"]`)].find(candidate => !options || candidate.getAttribute('aria-label') === options.name || candidate.textContent?.trim() === options.name)
        if (!element) throw new Error('Missing ' + role)
        return element
    },
}
const fireEvent = { click: (element: Element) => act(() => { (element as HTMLElement).click() }) }
const setValue = (element: Element, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    act(() => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
const inputByPlaceholder = (placeholder: string) => [...document.querySelectorAll<HTMLInputElement>('input')].find(input => input.placeholder === placeholder)

import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteMachinePairing } from './RemoteMachinePairing'

afterEach(() => {
    for (const { root, host } of roots.splice(0)) {
        act(() => root.unmount())
        host.remove()
    }
    document.body.innerHTML = ''
    vi.restoreAllMocks()
})

const key = 'engine-key-1234567890123456'
const noop = () => {}

describe('RemoteMachinePairing', () => {
    it('walks menu to the manual form with the original labels and a masked key', () => {
        render(<RemoteMachinePairing hasConnection={false} busy={null} error={null} pendingRetry={false} onConnect={noop} onRetry={noop} onSettle={noop} />)
        expect(document.body.textContent).toContain('Add a server')
        fireEvent.click(screen.getByRole('button', { name: 'Enter address and key' }))
        expect(document.body.textContent).toContain('Enter a server by hand')
        const address = inputByPlaceholder('http://192.168.1.20:3000')
        const apiKey = inputByPlaceholder('RERUN_API_KEY of the engine')
        expect(address).toBeTruthy()
        expect(apiKey).toBeTruthy()
        expect(apiKey!.type).toBe('password')
    })

    it('keeps Connect disabled until both fields are filled', () => {
        render(<RemoteMachinePairing hasConnection={false} busy={null} error={null} pendingRetry={false} onConnect={noop} onRetry={noop} onSettle={noop} />)
        fireEvent.click(screen.getByRole('button', { name: 'Enter address and key' }))
        const connect = () => screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement
        expect(connect().disabled).toBe(true)
        setValue(inputByPlaceholder('http://192.168.1.20:3000')!, 'https://machine.example')
        expect(connect().disabled).toBe(true)
        setValue(inputByPlaceholder('RERUN_API_KEY of the engine')!, key)
        expect(connect().disabled).toBe(false)
    })

    it('sends the trimmed address and the key to onConnect', () => {
        const onConnect = vi.fn()
        render(<RemoteMachinePairing hasConnection={false} busy={null} error={null} pendingRetry={false} onConnect={onConnect} onRetry={noop} onSettle={noop} />)
        fireEvent.click(screen.getByRole('button', { name: 'Enter address and key' }))
        setValue(inputByPlaceholder('http://192.168.1.20:3000')!, '  https://machine.example  ')
        setValue(inputByPlaceholder('RERUN_API_KEY of the engine')!, key)
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
        expect(onConnect).toHaveBeenCalledExactlyOnceWith('https://machine.example', key)
    })

    it('explains the pairing-token branch truthfully as unsupported', () => {
        render(<RemoteMachinePairing hasConnection={false} busy={null} error={null} pendingRetry={false} onConnect={noop} onRetry={noop} onSettle={noop} />)
        fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
        expect(document.body.textContent).toContain('Pairing tokens are part of hosted Rerun and have no local port on the Mac.')
        expect(document.body.textContent).toContain('enter its address and key instead')
        fireEvent.click(screen.getByRole('button', { name: 'Back' }))
        expect(document.body.textContent).not.toContain('Pairing tokens are part of hosted Rerun')
        expect(document.body.textContent).toContain('Add a server')
    })

    it('offers Retry and Check acknowledgement while a lost-ack change is pending', () => {
        const onRetry = vi.fn()
        const onSettle = vi.fn()
        render(<RemoteMachinePairing hasConnection={false} busy={null} error={'kept'} pendingRetry onConnect={noop} onRetry={onRetry} onSettle={onSettle} />)
        expect(document.body.textContent).toContain('same request identity')
        fireEvent.click(screen.getByRole('button', { name: 'Check acknowledgement' }))
        expect(onSettle).toHaveBeenCalledTimes(1)
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
        expect(onRetry).toHaveBeenCalledTimes(1)
    })

    it('warns that connecting replaces an existing machine', () => {
        render(<RemoteMachinePairing hasConnection busy={null} error={null} pendingRetry={false} onConnect={noop} onRetry={noop} onSettle={noop} />)
        expect(document.body.textContent).toContain('already has a server')
        expect(document.body.textContent).toContain('Connecting replaces it after you confirm.')
    })

    it('calls onBack from the manual form when a connection exists', () => {
        const onBack = vi.fn()
        render(<RemoteMachinePairing hasConnection busy={null} error={null} pendingRetry={false} onConnect={noop} onRetry={noop} onSettle={noop} onBack={onBack} />)
        fireEvent.click(screen.getByRole('button', { name: 'Enter address and key' }))
        fireEvent.click(screen.getByRole('button', { name: 'Back' }))
        expect(onBack).toHaveBeenCalledTimes(1)
    })
})
