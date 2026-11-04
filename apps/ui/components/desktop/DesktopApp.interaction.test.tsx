// @vitest-environment happy-dom

import { ThemeProvider } from '@rerun/ui/theme'
import type { ConnectionsList } from '@rerun/contracts'
import { act } from 'react'
import { MotionConfig } from 'motion/react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopApp } from './DesktopApp'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settingsUrl = '/api/desktop/settings'
const disconnected: ConnectionsList = { connections: [], default: null }
const unexpectedRequests: string[] = []
function mockDesktopFetch(reply: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
    const drafts = createDesktopDraftFixture()
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        const draftResponse = drafts.handle(url, init)
        if (draftResponse) return draftResponse
        const response = reply(url, init)
        if (response) return response
        if (url.endsWith('/approvals') && (init?.method ?? 'GET') === 'GET') return Response.json({ approval: null })
        if (url.endsWith('/questions') && (init?.method ?? 'GET') === 'GET') return Response.json({ question: null })
        if (url.endsWith('/tabs') && init?.method === 'PUT') return Response.json({ tabs: { revision: JSON.parse(String(init.body)).baseRevision + 1 } })
        if (/^\/api\/desktop\/agents\/[^/]+\/queue\?/.test(url) && (init?.method ?? 'GET') === 'GET') return Response.json({ queued: null })
        // The Team board polls its own activity route; tests that do not exercise it see everyone idle.
        if (url === '/api/desktop/board-activity') return Response.json({ agents: {} })
        // An open conversation checks whether an engine run is still generating (for Stop).
        if (/^\/api\/desktop\/sessions\/[^/]+\/stop$/.test(url) && !init?.method) return Response.json({ running: false })
        if (/\/api\/desktop\/agents\/[^/]+\/model(?:\?|$)/.test(url)) return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null, effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } })
        if (/^\/api\/desktop\/sessions\/[^/]+\/feedback(?:\?|$)/.test(url) && !init?.method) return Response.json({ votes: [] })
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
        const workspaceMenu = container.querySelector('nav[aria-label="Workspace"]')!
        const boardTile = container.querySelector('[aria-label="Open chat with Researcher"]')
        expect(boardTile).not.toBeNull()
        expect(workspaceMenu.textContent).toContain('Set up provider')

        providers = { connections: [openai, codex], default: { connectionId: codex.id, model: codex.models[0] } }
        await tick()
        expect(workspaceMenu.textContent).toContain('Codex is connected')
        expect(workspaceMenu.textContent).toContain(codex.models[0])
        expect(container.textContent).not.toContain('Set up provider')

        providers = { ...providers, default: { connectionId: openai.id, model: openai.models[0] } }
        await tick()
        expect(workspaceMenu.textContent).toContain('OpenAI is connected')
        expect(workspaceMenu.textContent).toContain(openai.models[0])
        expect(workspaceMenu.textContent).not.toContain('Codex is connected')

        visibility.mockReturnValue('hidden')
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
        const readCount = fetcher.mock.calls.length
        providers = disconnected
        await tick()
        expect(fetcher).toHaveBeenCalledTimes(readCount)
        visibility.mockReturnValue('visible')
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
        expect(workspaceMenu.textContent).toContain('Set up provider')
        expect(workspaceMenu.textContent).not.toContain('OpenAI is connected')
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
        await act(async () => { container.querySelector<HTMLButtonElement>('[title="Open model settings"]')!.click() })
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
        expect(container.querySelector('nav[aria-label="Workspace"]')?.textContent).toContain('OpenAI is connected')
    } finally { await act(async () => { root.unmount() }) }
})

test('Codex Settings refreshes the account model list while keeping the selected Terra model', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const terra = 'gpt-5.6-terra'
    const accountModel = 'test-account-model'
    const connection = { id: 'mac-chatgpt', name: 'ChatGPT (Codex)', provider: 'codex' as const, models: [terra], extraModels: [], connected: true, credentialRejected: false, planLimits: null, createdAt: '' }
    let providers: ConnectionsList = { connections: [connection], default: { connectionId: connection.id, model: terra } }
    const actions: unknown[] = []
    mockDesktopFetch((url, init) => {
        if (url === settingsUrl && (init?.method ?? 'GET') === 'GET') return Response.json(providers)
        if (url === '/api/desktop/codex-login' && init?.method === 'POST') {
            actions.push(JSON.parse(String(init.body)))
            const status = actions.length === 2 ? { phase: 'connected', catalogError: 'Catalog temporarily unavailable.' } : { phase: 'connected' }
            const models = ['gpt-5.6-sol', terra, accountModel]
            if (actions.length === 3) models.push('another-test-model')
            providers = { ...providers, connections: [{ ...connection, models }] }
            return Response.json({ status, providers })
        }
    })
    const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === label)!
    const assertChoices = (labels: string[]) => {
        const select = container.querySelector<HTMLSelectElement>('#desktop-default')!
        expect([...select.options].map(option => option.textContent).sort()).toEqual([...labels].sort())
        expect(select.options[select.selectedIndex]?.textContent).toBe('GPT-5.6 Terra')
    }
    const refreshed = ['GPT-5.6 Sol', 'GPT-5.6 Terra', accountModel]
    try {
        await act(async () => { root.render(<DesktopApp initialData={{ ...providers, theme: 'system', profile: { id: 1, displayName: 'Local' }, workspace: { id: 1, name: 'Studio' }, agents: [] }} />) })
        await act(async () => { container.querySelector<HTMLButtonElement>('[title="Open model settings"]')!.click() })
        expect(actions).toEqual([{ action: 'refresh' }])
        assertChoices(refreshed)
        await act(async () => { button('Refresh models').click() })
        expect(container.querySelector('[role="alert"]')?.textContent).toBe('Catalog temporarily unavailable.')
        assertChoices(refreshed)
        await act(async () => { button('Refresh models').click() })
        expect(actions).toEqual([{ action: 'refresh' }, { action: 'refresh' }, { action: 'refresh' }])
        expect(container.querySelector('[role="alert"]')).toBeNull()
        assertChoices([...refreshed, 'another-test-model'])
    } finally { await act(async () => { root.unmount() }) }
})

test('reasoning effort uses the active model’s supported levels and the saved workspace choice', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const terra = 'gpt-5.6-terra', sol = 'gpt-5.6-sol', luna = 'gpt-5.6-luna'
    const codex = {
        id: 'mac-chatgpt', name: 'ChatGPT (Codex)', provider: 'codex' as const, models: [terra, sol, luna],
        extraModels: [], connected: true, credentialRejected: false, planLimits: null, createdAt: '',
        codexReasoning: {
            [terra]: { supported: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default: 'medium' },
            [sol]: { supported: ['high', 'xhigh'], default: 'high' },
            [luna]: { supported: ['low', 'medium'], default: 'low' },
        },
    }
    const atModel = (model: string) => ({ connectionId: codex.id, model })
    let providers: ConnectionsList = { connections: [codex], default: { ...atModel(terra), reasoningEffort: 'high' } }
    const replies = [
        { ...atModel(terra), reasoningEffort: 'xhigh' }, { ...atModel(sol), reasoningEffort: 'xhigh' },
        atModel(luna), { ...atModel(luna), reasoningEffort: 'medium' }, atModel(luna),
    ]
    const writes: unknown[] = []
    mockDesktopFetch((url, init) => {
        if (url === settingsUrl && (init?.method ?? 'GET') === 'GET') return Response.json(providers)
        if (url === '/api/desktop/codex-login' && init?.method === 'POST' && JSON.parse(String(init.body)).action === 'refresh')
            return Response.json({ status: { phase: 'connected' }, providers })
        if (url === settingsUrl && init?.method === 'PATCH' && writes.length < replies.length) {
            providers = { ...providers, default: replies[writes.length] }
            writes.push(JSON.parse(String(init.body)))
            return Response.json(providers)
        }
    })
    const open = (name: string) => act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === name)!.click() })
    const field = (id: string) => container.querySelector<HTMLSelectElement>(id)!
    const change = (select: HTMLSelectElement, value: string) => act(async () => {
        select.value = value
        select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const chooseModel = (name: string) => {
        const select = field('#desktop-default')
        return change(select, [...select.options].find(o => o.textContent === name)!.value)
    }
    const effort = () => field('#desktop-reasoning-effort')
    const levels = () => [...effort().options].map(o => o.value)
    try {
        await act(async () => { root.render(<DesktopApp initialData={{ ...providers, theme: 'system', profile: { id: 1, displayName: 'Local' }, workspace: { id: 1, name: 'Studio' }, agents: [] }} />) })
        await act(async () => { container.querySelector<HTMLButtonElement>('[title="Open model settings"]')!.click() })
        expect(levels()).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
        expect(effort().options[0].textContent).toBe('Model default (Medium)')
        expect(effort().value).toBe('high')
        await change(effort(), 'xhigh')
        await open('Team board')
        await act(async () => { container.querySelector<HTMLButtonElement>('[title="Open model settings"]')!.click() })
        expect(effort().value).toBe('xhigh')
        await chooseModel('GPT-5.6 Sol')
        expect(levels()).toEqual(['', 'high', 'xhigh'])
        expect(effort().value).toBe('xhigh')
        await chooseModel('GPT-5.6 Luna')
        expect(levels()).toEqual(['', 'low', 'medium'])
        expect(effort().value).toBe('')
        expect(effort().options[0].textContent).toBe('Model default (Low)')
        await change(effort(), 'medium')
        expect(effort().value).toBe('medium')
        await change(effort(), '')
        expect(effort().value).toBe('')
        expect(writes).toEqual([
            { action: 'default', ...atModel(terra), reasoningEffort: 'xhigh' },
            { action: 'default', ...atModel(sol) }, { action: 'default', ...atModel(luna) },
            { action: 'default', ...atModel(luna), reasoningEffort: 'medium' },
            { action: 'default', ...atModel(luna), reasoningEffort: null },
        ])
    } finally { await act(async () => { root.unmount() }) }
})

test('editing a coworker from the board preserves the chat and only saves changed fields', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const agent = { id: 'reviewer', name: 'Reviewer', description: '', createdAt: '', updatedAt: '' }
    let settings = { soul: 'Check the facts.', verbosity: 'normal', soulEditable: true, suggestedReplies: true, memoryEnabled: true, autoMemory: true, selfImprovementEnabled: true }
    let reads = 0
    const writes: Record<string, string>[] = []
    mockDesktopFetch((url, init) => {
        if (url === settingsUrl) return Response.json(disconnected)
        if (url === '/api/desktop/agents/reviewer/chat-history') return Response.json({ conversations: [{ id: 'review', agentId: agent.id, engineSessionId: 'engine-review', title: 'Earlier review', createdAt: '', updatedAt: '', source: 'dashboard', needsYou: false, pendingQuestion: null }], enrichment: 'ok', questions: 'ok' })
        if (url === '/api/desktop/agents/reviewer/sessions') return Response.json({ sessions: [{ id: 'review', agentId: agent.id, title: 'Earlier review', createdAt: '', updatedAt: '' }] })
        if (url === '/api/desktop/sessions/review/messages') return Response.json({ messages: [{ id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'Existing answer.' }] }] })
        if (url === '/api/desktop/agents/reviewer/settings') {
            if (init?.method !== 'PATCH') {
                reads++
                return reads === 1 ? Response.json({ error: 'Could not load settings.' }, { status: 503 }) : Response.json(settings)
            }
            const patch = JSON.parse(String(init.body))
            writes.push(patch)
            if (writes.length === 1) return Response.json({ error: 'Try saving again.' }, { status: 503 })
            settings = { ...settings, ...patch }
            return Response.json(settings)
        }
    })
    const click = (text: string) => act(async () => {
        const button = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === text || b.textContent?.trim() === text)!
        button.click()
    })
    const enter = (input: HTMLTextAreaElement, value: string) => act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const instructions = () => document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!
    try {
        await act(async () => { root.render(<MotionConfig isStatic><DesktopApp initialData={{ ...disconnected, profile: { id: 1, displayName: 'Local' }, workspace: { id: 1, name: 'Studio' }, theme: 'system', agents: [agent] }} /></MotionConfig>) })
        await act(async () => { container.querySelector<HTMLElement>('[aria-label="Open chat with Reviewer"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
        const composer = container.querySelector<HTMLTextAreaElement>('#desktop-message')!
        await enter(composer, 'My unsent question')
        await click('Coworker card')
        await click('Edit coworker')
        expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe('Could not load settings.')
        await click('Retry')
        expect(instructions().value).toBe('Check the facts.')
        expect(document.querySelector('[aria-label="Normal"]')?.getAttribute('aria-pressed')).toBe('true')
        await enter(instructions(), 'Discard this draft')
        await click('Cancel')
        expect(writes).toEqual([])
        await click('Edit coworker')
        expect(instructions().value).toBe('Check the facts.')
        await enter(instructions(), 'End with a verdict.')
        await click('Concise')
        await click('Save changes')
        expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe('Try saving again.')
        expect(instructions().value).toBe('End with a verdict.')
        await click('Save changes')
        expect(writes[1]).toEqual({ soul: 'End with a verdict.', verbosity: 'concise' })
        expect(document.querySelector('[role="dialog"]')).toBeNull()
        expect(composer.value).toBe('My unsent question')
        await click('Coworker card')
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)) })
        await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Conversation history (1)"]')!.click() })
        expect(document.querySelector('[aria-current="true"]')?.textContent).toContain('Earlier review')
        await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Conversation history (1)"]')!.click() })
        expect(container.textContent).toContain('Existing answer.')
        settings.soulEditable = false
        await click('Coworker card')
        await click('Edit coworker')
        expect(instructions()).toBeNull()
        expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('End with a verdict.')
        expect(document.querySelector('[aria-label="Concise"]')?.getAttribute('aria-pressed')).toBe('true')
        await click('Detailed')
        await click('Save changes')
        expect(writes[2]).toEqual({ verbosity: 'detailed' })
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
    const button = (label: string) => [...document.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label || node.textContent?.trim() === label)!
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
        const board = container.querySelector('[aria-label="Team board"]')!
        await act(async () => { tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
        expect(container.querySelector('[aria-label="Team board"]')).toBe(board)
        expect(container.querySelector('[aria-label="Open chat with Researcher"]')).toBe(tile)
        expect(container.querySelector('[aria-label="Coworker chat"]')?.textContent).toContain('Saved answer')
        await send('Continue')
        await act(async () => { button('New chat').click() })
        await send('Start fresh')
        expect(sent).toEqual([{ agentId: 'researcher', sessionId: 'previous', text: 'Continue' }, { agentId: 'researcher', tabUid: expect.any(String), text: 'Start fresh' }])
        await act(async () => { button('Close panel').click() })
        expect(document.activeElement).toBe(tile)
        expect(container.querySelector('[data-side-panel]')?.closest('[inert]')).not.toBeNull()
        await act(async () => { button('Add coworker').click() })
        expect(document.querySelector('[role="dialog"] #coworker-name')).not.toBeNull()
        await act(async () => { button('Cancel').click() })
        expect(container.querySelector('[aria-label="Open chat with Researcher"]')).toBe(tile)
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
        await act(async () => { container.querySelector<HTMLButtonElement>('[title="Open model settings"]')!.click() })
        await act(async () => { button('Workspace').click() })
        await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Dark"]')!.click() })
        expect(writes).toEqual([{ action: 'appearance', theme: 'dark' }])
        expect(document.documentElement.classList.contains('dark')).toBe(true)
    } finally {
        await act(async () => { root.unmount() })
        document.documentElement.classList.remove('dark', 'light')
    }
})
