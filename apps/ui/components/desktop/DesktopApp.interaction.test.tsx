// @vitest-environment happy-dom

import { ThemeProvider } from '@rerun/ui/theme'
import type { ConnectionsList } from '@rerun/contracts'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopApp } from './DesktopApp'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settingsUrl = '/api/desktop/settings'
const disconnected: ConnectionsList = { connections: [], default: null }
const unexpectedRequests: string[] = []
function mockDesktopFetch(reply: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        const response = reply(url, init)
        if (response) return response
        const message = `${init?.method ?? 'GET'} ${url}`
        unexpectedRequests.push(message)
        throw new Error(`Unexpected request: ${message}`)
    })
    vi.stubGlobal('fetch', fetcher)
    return fetcher
}
afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    expect(unexpectedRequests.splice(0)).toEqual([])
})

test('the open board follows sign-in, default provider changes, and sign-out', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    let providers = disconnected
    const fetcher = mockDesktopFetch((url, init) => {
        if (url === settingsUrl && (init?.method ?? 'GET') === 'GET') return Response.json(providers)
    })
    const coworker = { id: 'researcher', name: 'Researcher', description: '', createdAt: '', updatedAt: '' }
    const openai = { id: 'key', name: 'OpenAI', provider: 'openai' as const, models: ['gpt-6-sol'], extraModels: [], connected: true, credentialRejected: false, planLimits: null, createdAt: '' }
    const codex = { ...openai, id: 'mac-chatgpt', name: 'ChatGPT (Codex)', provider: 'codex' as const, models: ['gpt-5.6-sol'] }
    const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    try {
        await act(async () => { root.render(<DesktopApp initialData={{ ...disconnected, theme: 'system', profile: { id: 1, displayName: 'Local' }, workspace: { id: 1, name: 'Studio' }, agents: [coworker] }} />) })
        const sidebar = container.querySelector('aside')!
        const boardTile = container.querySelector('[aria-label="Open chat with Researcher"]')
        expect(boardTile).not.toBeNull()
        expect(sidebar.textContent).toContain('Set up provider')

        providers = { connections: [openai, codex], default: { connectionId: codex.id, model: codex.models[0] } }
        await tick()
        expect(sidebar.textContent).toContain('Codex is connected')
        expect(sidebar.textContent).toContain(codex.models[0])
        expect(container.textContent).not.toContain('Set up provider')

        providers = { ...providers, default: { connectionId: openai.id, model: openai.models[0] } }
        await tick()
        expect(sidebar.textContent).toContain('OpenAI is connected')
        expect(sidebar.textContent).toContain(openai.models[0])
        expect(sidebar.textContent).not.toContain('Codex is connected')

        visibility.mockReturnValue('hidden')
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
        const readCount = fetcher.mock.calls.length
        providers = disconnected
        await tick()
        expect(fetcher).toHaveBeenCalledTimes(readCount)
        visibility.mockReturnValue('visible')
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
        expect(sidebar.textContent).toContain('Set up provider')
        expect(sidebar.textContent).not.toContain('OpenAI is connected')
        expect(container.querySelector('[aria-label="Open chat with Researcher"]')).toBe(boardTile)
    } finally {
        await act(async () => { root.unmount() })
        visibility.mockRestore()
        vi.useRealTimers()
    }
})

test('a reopened workspace can replace a saved key and recover after a failed save', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const initialData = { profile: { id: 1, displayName: 'Local User' }, workspace: { id: 1, name: 'Workspace' }, agents: [], theme: 'system' as const, default: null, connections: [{ id: 'example-connection', name: 'OpenAI', provider: 'openai' as const, models: ['gpt-6-sol'], extraModels: [], connected: true, credentialRejected: false, planLimits: null, createdAt: '' }] }
    let finishRead!: (res: Response) => void
    const delayedRead = new Promise<Response>(resolve => { finishRead = resolve })
    const writes: unknown[] = []
    const fetcher = mockDesktopFetch((url, init) => {
        if (url !== settingsUrl) return
        if ((init?.method ?? 'GET') === 'GET') return delayedRead
        if (init?.method === 'PATCH') {
            writes.push(JSON.parse(String(init.body)))
            return writes.length === 1 ? Response.json({ error: 'Synthetic save failure' }, { status: 500 }) : Response.json({ connections: initialData.connections, default: null })
        }
    })
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
        expect(writes).toHaveLength(2)
        expect(writes[1]).toEqual({ action: 'key', provider: 'openai', connectionId: 'example-connection', apiKey: 'example-replacement-key' })
        expect(container.textContent).toContain('API key saved.')
        expect(container.querySelector<HTMLInputElement>('#desktop-api-key')!.value).toBe('')
        expect(fetcher.mock.calls.some(([url, init]) => url === settingsUrl && (init?.method ?? 'GET') === 'GET')).toBe(true)
        await act(async () => { finishRead(Response.json(disconnected)) })
        expect(container.querySelector('aside')?.textContent).toContain('OpenAI is connected')
    } finally { await act(async () => { root.unmount() }) }
})

test('a board tile opens the saved conversation and New chat starts a separate session', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const agent = { id: 'researcher', name: 'Researcher', description: 'Finds answers', createdAt: '', updatedAt: '' }
    const session = { id: 'previous', agentId: agent.id, title: 'First chat', createdAt: '', updatedAt: '' }
    const sent: unknown[] = []
    const providers: ConnectionsList = { default: null, connections: [{ id: 'key', name: 'OpenAI', provider: 'openai', models: ['gpt-6-sol'], extraModels: [], connected: true, credentialRejected: false, planLimits: null, createdAt: '' }] }
    mockDesktopFetch((url, init) => {
        if (url === settingsUrl && (init?.method ?? 'GET') === 'GET') return Response.json(providers)
        if (url.endsWith('/sessions')) return Response.json({ sessions: [session] })
        if (url === '/api/desktop/sessions/previous/messages') return Response.json({ messages: [{ id: 'reply', role: 'assistant', parts: [{ type: 'text', text: 'Saved answer' }] }] })
        if (url === '/api/desktop/chat') {
            const body = JSON.parse(String(init?.body))
            sent.push(body)
            return new Response('data: {"type":"finish"}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-session-id': body.sessionId ?? 'created' } })
        }
        if (url === '/api/desktop/sessions/created/messages') return Response.json({ messages: [] })
    })
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
        await act(async () => { root.render(<DesktopApp initialData={{ profile: { id: 1, displayName: 'Local' }, workspace: { id: 1, name: 'Studio' }, agents: [agent], theme: 'system' as const, ...providers }} />) })
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

test('applying a new appearance keeps the saved choice active', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const writes: unknown[] = []
    mockDesktopFetch((url, init) => {
        if (url !== settingsUrl) return
        if ((init?.method ?? 'GET') === 'GET') return Response.json(disconnected)
        if (init?.method === 'PATCH') {
            writes.push(JSON.parse(String(init.body)))
            return Response.json(disconnected)
        }
    })
    const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label)!
    try {
        await act(async () => { root.render(<ThemeProvider><DesktopApp initialData={{
            theme: 'light', profile: { id: 1, displayName: 'Local' }, workspace: { id: 1, name: 'Studio' },
            default: null, connections: [], agents: [],
        }} /></ThemeProvider>) })
        await act(async () => { button('Settings').click() })
        await act(async () => { button('Workspace').click() })
        await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Dark"]')!.click() })
        expect(writes).toEqual([{ action: 'appearance', theme: 'dark' }])
        expect(document.documentElement.classList.contains('dark')).toBe(true)
    } finally {
        await act(async () => { root.unmount() })
        document.documentElement.classList.remove('dark', 'light')
    }
})
