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
    const initialData = { profile: { id: 1, displayName: 'Local User' }, workspace: { id: 1, name: 'Workspace' }, agents: [], theme: 'system' as const, default: null, connections: [{ id: 'example-connection', name: 'OpenAI', provider: 'openai' as const, models: ['gpt-6-sol'], extraModels: [], connected: true, credentialRejected: false, planLimits: null, createdAt: '' }] }
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: 'Synthetic save failure' }, { status: 500 })).mockResolvedValueOnce(Response.json({ connections: initialData.connections, default: null }))
    vi.stubGlobal('fetch', fetcher)
    const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === text)!
    const enterKey = async () => {
        const input = container.querySelector<HTMLInputElement>('#desktop-api-key')!
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'example-replacement-key')
            input.dispatchEvent(new Event('input', { bubbles: true }))
            input.dispatchEvent(new Event('change', { bubbles: true }))
        })
    }
    const submit = async () => { await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }) }
    try {
        await act(async () => { root.render(<DesktopApp initialData={initialData} />) })
        expect(container.querySelector('#desktop-api-key')).toBeNull()
        await act(async () => { button('Settings').click() })
        expect(container.querySelector<HTMLInputElement>('#desktop-api-key')!.type).toBe('password')
        await enterKey()
        await submit()
        expect(container.textContent).toContain('Synthetic save failure')
        expect(container.querySelector('#desktop-api-key')).not.toBeNull()
        await submit()
        expect(fetcher).toHaveBeenCalledTimes(2)
        expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ action: 'key', provider: 'openai', connectionId: 'example-connection', apiKey: 'example-replacement-key' })
        expect(container.textContent).toContain('API key saved.')
        expect(container.querySelector<HTMLInputElement>('#desktop-api-key')!.value).toBe('')
    } finally { await act(async () => { root.unmount() }) }
})

test('a board tile opens the saved conversation and New chat starts a separate session', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const agent = { id: 'researcher', name: 'Researcher', description: 'Finds answers', createdAt: '', updatedAt: '' }
    const session = { id: 'previous', agentId: agent.id, title: 'First chat', createdAt: '', updatedAt: '' }
    const sent: unknown[] = []
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/sessions')) return Response.json({ sessions: [session] })
        if (url === '/api/desktop/sessions/previous/messages') return Response.json({ messages: [{ id: 'reply', role: 'assistant', parts: [{ type: 'text', text: 'Saved answer' }] }] })
        if (url === '/api/desktop/chat') {
            const body = JSON.parse(String(init?.body))
            sent.push(body)
            return new Response('data: {"type":"finish"}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-session-id': body.sessionId ?? 'created' } })
        }
        if (url === '/api/desktop/sessions/created/messages') return Response.json({ messages: [] })
        throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetcher)
    const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.textContent?.trim() === label)!
    const send = async (text: string) => {
        const input = container.querySelector<HTMLTextAreaElement>('#desktop-message')!
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
            input.dispatchEvent(new Event('input', { bubbles: true }))
            input.dispatchEvent(new Event('change', { bubbles: true }))
        })
        await act(async () => { input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    }
    try {
        await act(async () => { root.render(<DesktopApp initialData={{ profile: { id: 1, displayName: 'Local' }, workspace: { id: 1, name: 'Studio' }, agents: [agent], theme: 'system' as const, default: null, connections: [{ id: 'key', name: 'OpenAI', provider: 'openai' as const, models: ['gpt-6-sol'], extraModels: [], connected: true, credentialRejected: false, planLimits: null, createdAt: '' }] }} />) })
        const tile = container.querySelector<HTMLElement>('[aria-label="Open chat with Researcher"]')!
        await act(async () => { tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
        expect(container.textContent).toContain('Saved answer')
        await send('Continue')
        await act(async () => { button('New chat').click() })
        await send('Start fresh')
        expect(sent).toEqual([{ agentId: 'researcher', sessionId: 'previous', text: 'Continue' }, { agentId: 'researcher', text: 'Start fresh' }])
        await act(async () => { button('Team board').click() })
        expect(container.querySelector('[aria-label="Open chat with Researcher"]')).not.toBeNull()
        await act(async () => { button('Add coworker').click() })
        expect(container.querySelector('#coworker-name')).not.toBeNull()
        await act(async () => { button('Cancel').click() })
        expect(container.querySelector('[aria-label="Open chat with Researcher"]')).not.toBeNull()
    } finally { await act(async () => { root.unmount() }) }
})
