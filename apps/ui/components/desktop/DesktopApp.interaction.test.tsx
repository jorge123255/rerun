// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopApp } from './DesktopApp'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

test('a reopened workspace can replace a saved key and recover after a failed save', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const initialData = { profile: { id: 1, displayName: 'Local User' }, workspace: { id: 1, name: 'Workspace' }, agents: [], connections: [{ id: 'example-connection', provider: 'openai' as const, name: 'OpenAI' }] }
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: 'Synthetic save failure' }, { status: 500 })).mockResolvedValueOnce(Response.json({ connection: initialData.connections[0] }))
    vi.stubGlobal('fetch', fetcher)
    const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent === text)!
    const enterKey = async () => {
        const input = container.querySelector<HTMLInputElement>('#openai-key')!
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'example-replacement-key')
            input.dispatchEvent(new Event('input', { bubbles: true }))
            input.dispatchEvent(new Event('change', { bubbles: true }))
        })
    }
    const submit = async () => { await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }) }
    try {
        await act(async () => { root.render(<DesktopApp initialData={initialData} />) })
        expect(container.querySelector('#openai-key')).toBeNull()
        await act(async () => { button('Change API key').click() })
        expect(container.querySelector<HTMLInputElement>('#openai-key')!.type).toBe('password')
        await enterKey()
        await submit()
        expect(container.textContent).toContain('Synthetic save failure')
        expect(container.querySelector('#openai-key')).not.toBeNull()
        await submit()
        expect(fetcher).toHaveBeenCalledTimes(2)
        expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ apiKey: 'example-replacement-key' })
        expect(container.querySelector('#openai-key')).toBeNull()
        expect(container.textContent).toContain('API key saved. Your next message will use it.')
        await act(async () => { button('Change API key').click() })
        expect(container.querySelector<HTMLInputElement>('#openai-key')!.value).toBe('')
    } finally { await act(async () => { root.unmount() }) }
})
