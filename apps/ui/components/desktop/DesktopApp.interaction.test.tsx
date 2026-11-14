// @vitest-environment happy-dom

import { ThemeProvider } from '@rerun/ui/theme'
import type { ConnectionsList } from '@rerun/contracts'
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
import { act } from 'react'
import { MotionConfig } from 'motion/react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopApp } from './DesktopApp'
import { DesktopLocale } from './DesktopLocale'
import { desktopMessages, type DesktopLanguage } from '@/lib/desktop/locale'
import { loadMessages } from '@rerun/i18n/messages'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'
import { createDesktopRecentFixture } from '@/test/desktop-recent-fixture'
import { buildDesktopModelView } from '@/lib/desktop/chat-model'
import { generalTabUid } from '@/lib/desktop/general-threads'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settingsUrl = '/api/desktop/settings'
const disconnected: ConnectionsList = { connections: [], default: null }
const unexpectedRequests: string[] = []
function mockDesktopFetch(reply: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
    const drafts = createDesktopDraftFixture()
    const recent = createDesktopRecentFixture()
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        const recentResponse = recent.handle(url, init)
        if (recentResponse) return recentResponse
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
        if (url === '/api/desktop/pending-inbox') return Response.json({ items: [], unavailableAgentIds: [], checkedAt: '2026-11-04T00:00:00Z' })
        if (url === '/api/desktop/completions') return Response.json({ items: [], unavailableAgentIds: [], enabledAt: '2026-11-04T00:00:00Z', checkedAt: '2026-11-04T00:00:00Z', nextCursor: null })
        // An open conversation checks whether an engine run is still generating (for Stop).
        if (/^\/api\/desktop\/sessions\/[^/]+\/stop$/.test(url) && !init?.method) return Response.json({ running: false })
        if (/\/api\/desktop\/agents\/[^/]+\/model(?:\?|$)/.test(url)) return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null, effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } })
        if (/^\/api\/desktop\/sessions\/[^/]+\/feedback(?:\?|$)/.test(url) && !init?.method) return Response.json({ votes: [] })
        const message = `${init?.method ?? 'GET'} ${url}`
        const background = desktopBackgroundRead(url, init); if (background) return background
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

// The provider pill opens the list of connected providers; Settings is one step further.
async function openModelSettings(root: ParentNode) {
    await act(async () => { root.querySelector<HTMLButtonElement>('[title="Open model settings"]')!.click() })
    const inner = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="desktop-provider-status"] button')].find(button => button.textContent?.trim() === 'Open model settings')
    await act(async () => { inner!.click() })
}

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
        const providerReads = () => fetcher.mock.calls.filter(([url]) => url === '/api/desktop/settings').length
        const readCount = providerReads()
        providers = disconnected
        await tick()
        expect(providerReads()).toBe(readCount)
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

test('the native Settings menu and the keyboard shortcut share the desktop admission guard', async () => {
    const { cancelDraftShutdown, freezeDesktopAdmissions } = await import('@/lib/desktop/draft-writes')
    const desktopWindow = window as Window & { desktopApp?: { onOpenSettings(listener: () => void): () => void } }
    const previous = desktopWindow.desktopApp
    const listeners = new Set<() => void>()
    desktopWindow.desktopApp = { onOpenSettings(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
    } }
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    mockDesktopFetch(url => url === settingsUrl ? Response.json(disconnected) : undefined)
    const settingsNav = () => container.querySelector('nav[aria-label="Settings sections"]')
    const menu = () => { for (const listener of listeners) listener() }
    const shortcut = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, cancelable: true }))
    try {
        await act(async () => { root.render(<DesktopApp initialData={{ ...disconnected, theme: 'system', profile: { id: 1, displayName: 'Local' }, workspace: { id: 1, name: 'Studio' }, agents: [] }} />) })
        expect(listeners.size).toBe(1)
        freezeDesktopAdmissions()
        await act(async () => { menu(); expect(shortcut()).toBe(true) })
        expect(settingsNav()).toBeNull()
        cancelDraftShutdown()
        await act(async () => { menu() })
        expect(settingsNav()).not.toBeNull()
        const back = [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Team board')!
        await act(async () => { back.click() })
        expect(settingsNav()).toBeNull()
        await act(async () => { expect(shortcut()).toBe(false) })
        expect(settingsNav()).not.toBeNull()
    } finally {
        cancelDraftShutdown()
        await act(async () => { root.unmount() })
        desktopWindow.desktopApp = previous
    }
    expect(listeners.size).toBe(0)
})

test('Chief of Staff reconnect opens the failed connection even after opening transcription settings', async () => {
    vi.stubGlobal('EventSource', class { close() {} })
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    const chat = { workspaceId: '1', chatId: 'fmc_settings' }
    const model = { connectionId: 'plan', model: 'fixture-model' }
    const attemptId = '00000000-0000-4000-8000-000000000001'
    const failedConnection = 'failed-key'
    const connection = { id: 'plan', name: 'Workspace default', provider: 'codex' as const, models: [model.model],
        connected: true, credentialRejected: false, planLimits: null, createdAt: '', extraModels: [] }
    const providers: ConnectionsList = { default: model, connections: [connection,
        { ...connection, id: 'sibling-key', provider: 'openai', name: 'OpenAI sibling' },
        { ...connection, id: failedConnection, provider: 'openai', name: 'Failed OpenAI key', credentialRejected: true },
    ] }
    const fetcher = mockDesktopFetch((url, init) => {
        const method = init?.method ?? 'GET'
        if (url === settingsUrl && method === 'GET') return Response.json(providers)
        if (url === '/api/desktop/foreman' && method === 'GET') return Response.json({
            chat, sessionId: 'chief-fixture', model: null, runFailure: { kind: 'unauthorized', connectionId: failedConnection },
            messages: [{ id: 'saved-user', role: 'user', parts: [{ type: 'text', text: 'An existing question' }] }],
            view: { contractVersion: 1, chat, phase: 'plan', live: null, revisions: [], currentRevisionId: null, decisions: [], build: null, discovery: null, blocked: null },
            ui: { revision: 0, snapshot: null },
        })
        if (url === '/api/desktop/foreman' && method === 'POST') {
            const change = JSON.parse(String(init?.body))
            expect(change.action).toBe('ui')
            return Response.json({ revision: change.expectedRevision + 1 })
        }
        if (url.startsWith('/api/desktop/foreman/voice?')) return Response.json({ target: { chat, model }, receipt: null, setup: 'transcription',
            attempt: { attemptId, revision: attemptId, phase: 'review', transcript: null, error: null, messageId: null, updatedAt: '2026-11-11T00:00:00Z',
                recording: { attemptId, sha256: 'a'.repeat(64), byteLength: 10, mimeType: 'audio/webm', extension: 'webm', transcriptionFormat: 'webm', durationMs: 1300, levels: [0.2] } },
        })
        if (url === '/api/desktop/auxiliary' && method === 'GET') return Response.json([])
        if (url.startsWith('/api/desktop/foreman/') || url.startsWith('/api/desktop/agents/foreman/')) return new Response(null, { status: 404 })
    })
    const findButton = (text: string) => [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === text)
    const section = () => container.querySelector('nav[aria-label="Settings sections"] [aria-current="page"]')?.textContent?.trim()
    try {
        await act(async () => root.render(<DesktopApp initialData={{ ...providers, theme: 'system', profile: { id: 1, displayName: 'Local' }, workspace: { id: 1, name: 'Studio' }, agents: [] }} />))
        await act(async () => container.querySelector<HTMLButtonElement>('[data-foreman-orb] button')!.click())
        expect(findButton('Set up transcription')).toBeDefined()
        await act(async () => findButton('Set up transcription')!.click())
        expect(section()).toBe('Tool services')
        await act(async () => findButton('Team board')!.click())
        expect(section()).toBeUndefined()
        await act(async () => findButton('Reconnect')!.click())
        expect(section()).toBe('AI providers')
        expect(container.querySelector<HTMLSelectElement>('#desktop-provider')?.value).toBe(failedConnection)
        expect(container.querySelector('#desktop-default')).toBeNull()
        expect(container.textContent).toContain('Key rejected')
        expect(fetcher.mock.calls.some(([url, init]) => url === settingsUrl && init?.method === 'PATCH')).toBe(false)
    } finally {
        await act(async () => root.unmount())
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
        await openModelSettings(container)
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
        await openModelSettings(container)
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
        await openModelSettings(container)
        expect(levels()).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
        expect(effort().options[0].textContent).toBe('Model default (Medium)')
        expect(effort().value).toBe('high')
        await change(effort(), 'xhigh')
        await open('Team board')
        await openModelSettings(container)
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

test('Kimi Platform Settings shows Max and saves or resets an effort on the exact revision', async () => {
    const model = 'kimi-k3.1-pro'
    const selection = { connectionId: 'fixture-kimi', model }
    const connection: ConnectionsList['connections'][number] = {
        id: selection.connectionId, name: 'Kimi Platform API', provider: 'custom', models: [model],
        extraModels: [], connected: true, credentialRejected: false, planLimits: null, createdAt: '',
        customRevision: 7, customReasoning: { [model]: { supported: ['low', 'high', 'max'], default: 'max' } },
    }
    let providers: ConnectionsList = { connections: [connection], default: selection }
    const writes: unknown[] = []
    mockDesktopFetch((url, init) => {
        if (url !== settingsUrl) return
        if (init?.method === 'PATCH') {
            const body = JSON.parse(String(init.body))
            writes.push(body)
            providers = { ...providers, default: body.reasoningEffort ? {
                ...selection, reasoningEffort: body.reasoningEffort, customReasoningRevision: 7,
            } : selection }
        }
        return Response.json(providers)
    })
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    const effort = () => container.querySelector<HTMLSelectElement>('#desktop-reasoning-effort')!
    const change = (value: string) => act(async () => {
        effort().value = value
        effort().dispatchEvent(new Event('change', { bubbles: true }))
    })
    try {
        await act(async () => { root.render(<DesktopApp initialData={{ ...providers, theme: 'system',
            profile: { id: 1, displayName: 'Local' }, workspace: { id: 1, name: 'Studio' }, agents: [] }} />) })
        await openModelSettings(container)
        expect([...effort().options].map(option => option.textContent)).toEqual(['Model default (Max)', 'Low', 'High', 'Max'])
        await change('max')
        expect(effort().value).toBe('max')
        await change('')
        expect(effort().value).toBe('')
        expect(writes).toEqual([
            { action: 'default', ...selection, reasoningEffort: 'max', customReasoningRevision: 7 },
            { action: 'default', ...selection, reasoningEffort: null, customReasoningRevision: 7 },
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
        if (url === '/api/desktop/agents/reviewer/chat-history?view=saved') return Response.json({ conversations: [{ id: 'review', agentId: agent.id, engineSessionId: 'engine-review', title: 'Earlier review', createdAt: '', updatedAt: '', source: 'dashboard', needsYou: false, pendingQuestion: null }], enrichment: 'ok', questions: 'ok' })
        if (url === '/api/desktop/agents/reviewer/sessions' || url === '/api/desktop/agents/reviewer/sessions?view=threads')
            return Response.json({ sessions: [{ id: 'review', agentId: agent.id, title: 'Earlier review', createdAt: '', updatedAt: '' }] })
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

test.each([
    { locale: 'en', open: 'Open chat with Researcher', openingLabel: 'Opening Researcher…', retryLabel: 'Retry conversations', close: 'Close panel' },
    { locale: 'fr', open: 'Ouvrir la conversation avec Researcher', openingLabel: 'Ouverture de la conversation avec Researcher…', retryLabel: 'Recharger les conversations', close: 'Fermer le panneau' },
    { locale: 'es', open: 'Abrir el chat con Researcher', openingLabel: 'Abriendo el chat con Researcher…', retryLabel: 'Volver a cargar las conversaciones', close: 'Cerrar panel' },
    { locale: 'pt', open: 'Abrir conversa com Researcher', openingLabel: 'Abrindo a conversa com Researcher…', retryLabel: 'Recarregar conversas', close: 'Fechar painel' },
    { locale: 'de', open: 'Chat mit Researcher öffnen', openingLabel: 'Chat mit Researcher wird geöffnet…', retryLabel: 'Unterhaltungen erneut laden', close: 'Panel schließen' },
] as const)('the chat keeps a localized composer area in place during load and retry ($locale)', async ({ locale, open, openingLabel, retryLabel, close }) => {
    const language: DesktopLanguage = { locale, preference: locale, messages: desktopMessages(locale, await loadMessages(locale)) }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const agent = { id: 'researcher', name: 'Researcher', description: '', createdAt: '', updatedAt: '' }
    let resolveSessions!: (response: Response) => void
    let rejectSessions!: (reason: Error) => void
    const fetcher = mockDesktopFetch(url => {
        if (url === settingsUrl) return Response.json(disconnected)
        if (url === '/api/desktop/agents/researcher/sessions') {
            return new Promise<Response>((resolve, reject) => { resolveSessions = resolve; rejectSessions = reject })
        }
    })
    const panel = () => container.querySelector('[data-testid="desktop-coworker-chat"]')!
    const opening = () => {
        const composer = panel().querySelector('[data-slot="desktop-composer"]')
        expect(composer).not.toBeNull()
        expect(composer?.querySelector('[role="status"]')?.textContent).toBe(openingLabel)
        expect(composer?.querySelector('button, textarea, input, form')).toBeNull()
        expect(panel().querySelector('[aria-label="' + close + '"]')).not.toBeNull()
    }
    try {
        await act(async () => { root.render(<DesktopLocale initial={language}><DesktopApp initialData={{ ...disconnected, profile: { id: 1, displayName: 'Local' }, workspace: { id: 1, name: 'Studio' }, agents: [agent], theme: 'system' }} /></DesktopLocale>) })
        const tile = container.querySelector<HTMLElement>('[aria-label="' + open + '"]')!
        await act(async () => { tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
        opening()
        await act(async () => { rejectSessions(new TypeError('Failed to fetch')) })
        expect(panel().querySelector('[data-slot="desktop-composer"]')).toBeNull()
        expect(panel().querySelector('[role="alert"]')?.textContent).toContain(language.messages.threadHistory.loadFailed)
        expect(panel().textContent).not.toContain('Failed to fetch')
        const retry = panel().querySelector<HTMLButtonElement>('[role="alert"] button')!
        expect(retry.textContent).toBe(retryLabel)
        await act(async () => { retry.click() })
        expect(panel().querySelector('[role="alert"]')).toBeNull()
        opening()
        expect(fetcher.mock.calls.some(([url]) => url === '/api/desktop/chat')).toBe(false)
        await act(async () => { resolveSessions(Response.json({ sessions: [] })) })
        expect(panel().querySelector('form[data-slot="desktop-composer"] textarea')).not.toBeNull()
        expect(panel().textContent).not.toContain(openingLabel)
        await act(async () => { panel().querySelector<HTMLButtonElement>('[aria-label="' + close + '"]')!.click() })
        expect(document.activeElement).toBe(tile)
    } finally { await act(async () => { root.unmount() }) }
})

test('a board tile holds the first send for model setup, then opens a separate new session', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const agent = { id: 'researcher', name: 'Researcher', description: 'Finds answers', createdAt: '', updatedAt: '' }
    const session = { id: 'previous', agentId: agent.id, title: 'First chat', createdAt: '', updatedAt: '' }
    const sent: unknown[] = []
    let providers: ConnectionsList = { default: null, connections: [{ id: 'key', name: 'OpenAI', provider: 'openai', models: ['gpt-6-sol'], extraModels: [], connected: true, credentialRejected: false, planLimits: null, createdAt: '' }] }
    mockDesktopFetch((url, init) => {
        if (url === settingsUrl && (init?.method ?? 'GET') === 'GET') return Response.json(providers)
        if (url === settingsUrl && init?.method === 'PATCH') {
            const { action, connectionId, model } = JSON.parse(String(init.body))
            expect(action).toBe('default')
            providers = { ...providers, default: { connectionId, model } }
            return Response.json(providers)
        }
        if (/\/api\/desktop\/agents\/researcher\/model(?:\?|$)/.test(url)) return Response.json(buildDesktopModelView({
            connections: providers.connections, workspace: providers.default, coworker: null, conversation: null,
        }))
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
        expect(sent).toEqual([])
        const picker = container.querySelector<HTMLSelectElement>('#desktop-default')!
        expect(picker).not.toBeNull()
        await act(async () => {
            picker.value = '0'
            picker.dispatchEvent(new Event('change', { bubbles: true }))
        })
        expect(providers.default).toEqual({ connectionId: 'key', model: 'gpt-6-sol' })
        await act(async () => { button('Back to chat').click() })
        expect(container.querySelector('#desktop-message')).toHaveProperty('value', 'Continue')
        expect(sent).toEqual([])
        await send('Continue')
        await act(async () => { button('New thread').click() })
        await send('Start fresh')
        expect(sent).toEqual([{ agentId: 'researcher', sessionId: 'previous', text: 'Continue' }, { agentId: 'researcher', tabUid: expect.any(String), text: 'Start fresh' }])
        await act(async () => { button('Close panel').click() })
        expect(document.activeElement).toBe(tile)
        expect(container.querySelector('[data-side-panel]')?.closest('[inert]')).not.toBeNull()
        await act(async () => { button('Add coworker').click() })
        expect(document.querySelector('[role="dialog"] textarea')).not.toBeNull()
        await act(async () => { document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
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
        await openModelSettings(container)
        await act(async () => { button('Workspace').click() })
        await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Dark"]')!.click() })
        expect(writes).toEqual([{ action: 'appearance', theme: 'dark' }])
        expect(document.documentElement.classList.contains('dark')).toBe(true)
    } finally {
        await act(async () => { root.unmount() })
        document.documentElement.classList.remove('dark', 'light')
    }
})


test('freezes before the first awaited quit drain and leaves failed voice custody visible without a second cancel notification', async () => {
    const { registerDockQuitFlush } = await import('@/lib/desktop/foreman-dock/persistence')
    const { registerForemanVoiceQuit } = await import('@/lib/desktop/foreman-voice/quit')
    const { isDesktopQuitting, cancelDraftShutdown, subscribeDraftShutdown } = await import('@/lib/desktop/draft-writes')
    cancelDraftShutdown()
    let quit!: () => Promise<boolean>, cancelled!: () => void, finishDock!: (ready: boolean) => void
    const desktopWindow = window as Window & { desktopApp?: {
        onBeforeQuit(listener: () => Promise<boolean>): () => void
        onQuitCancelled(listener: () => void): () => void
    } }
    const previous = desktopWindow.desktopApp
    desktopWindow.desktopApp = { onBeforeQuit: listener => { quit = listener; return () => {} }, onQuitCancelled: listener => { cancelled = listener; return () => {} } }
    const notify = vi.fn(), voice = vi.fn(async () => false)
    const unlisten = subscribeDraftShutdown(notify)
    const undock = registerDockQuitFlush(() => new Promise(resolve => { finishDock = resolve }))
    const unvoice = registerForemanVoiceQuit(voice)
    mockDesktopFetch(url => url === settingsUrl ? Response.json(disconnected) : undefined)
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    try {
        await act(async () => { root.render(<DesktopApp initialData={{ ...disconnected, theme: 'system', profile: { id: 1, displayName: 'Local' }, workspace: { id: 1, name: 'Studio' }, agents: [] }} />) })
        let pending!: Promise<boolean>
        act(() => { pending = quit() })
        expect(isDesktopQuitting()).toBe(true)
        expect(notify).not.toHaveBeenCalled()
        let ready = true
        await act(async () => { finishDock(true); ready = await pending })
        expect(ready).toBe(false)
        expect(voice).toHaveBeenCalledTimes(1)
        expect(notify).not.toHaveBeenCalled()
        act(() => cancelled())
        expect(isDesktopQuitting()).toBe(false)
    } finally { unlisten(); undock(); unvoice(); cancelDraftShutdown(); await act(async () => root.unmount()); desktopWindow.desktopApp = previous }
})

test('open General picks up a saved sibling without rewriting the active layout', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const coworker = { id: 'researcher', name: 'Researcher', description: '', createdAt: '', updatedAt: '' }
    const base = { agentId: coworker.id, createdAt: '2026-11-11T12:00:00.000Z', updatedAt: '2026-11-11T12:00:00.000Z' }
    const general = { ...base, id: 'general', title: 'General', kind: 'general', firstMessage: null }
    const sibling = { ...base, id: 'sibling', title: 'Existing thread', kind: 'thread', firstMessage: 'Existing marker' }
    const newSibling = { ...base, id: 'new-sibling', title: 'New thread', kind: 'thread', firstMessage: 'Saved on another surface' }
    const routine = { ...sibling, source: 'schedule', automationName: 'Weekly digest', firstMessage: null }
    let runStatus = 'running'
    let outcome: 'done' | 'nothing' | undefined
    let waiting = false
    const path = '/api/desktop/agents/researcher/sessions'
    const initial = { sessions: [general, sibling], tabs: { revision: 2, activeIndex: 0, tabs: [{ uid: generalTabUid(coworker.id), id: general.id, title: 'General' }] } }
    let background: Response | undefined
    let networkDropped = false
    const threadReads = () => fetcher.mock.calls.filter(([url]) => url === path + '?view=threads').length
    const fetcher = mockDesktopFetch((url, init) => {
        if (url === settingsUrl) return Response.json(disconnected)
        if (url === path) return Response.json(initial)
        if (url === path + '?view=threads') {
            if (networkDropped) return Promise.reject(new TypeError('Failed to fetch'))
            return background?.clone() ?? Response.json({
                sessions: [general, { ...routine, runStatus, ...(outcome && { automationOutcome: outcome, title: 'No new leads' }) }, newSibling],
            })
        }
        if (url === '/api/desktop/board-activity') return Response.json({
            agents: { [coworker.id]: 'idle' },
            attention: { items: waiting ? [{ id: 'ask', agentId: coworker.id, agentName: coworker.name, agentEnabled: true,
                sessionId: sibling.id, title: sibling.title, kind: 'question', summary: 'Synthetic question', updatedAt: base.updatedAt }] : [],
            checkedAt: base.updatedAt, unavailableAgentIds: [] },
        })
        if (url === '/api/desktop/sessions/general/messages') return Response.json({ messages: [] })
        if (url.endsWith('/tabs') && init?.method === 'PUT') return Response.json({ tabs: { revision: 3 } })
    })
    const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    try {
        await act(async () => root.render(<MotionConfig reducedMotion="always"><ThemeProvider>
            <DesktopApp initialData={{ ...disconnected, theme: 'system', profile: { id: 1, displayName: 'Local' }, workspace: { id: 1, name: 'Studio' }, agents: [coworker] }} />
        </ThemeProvider></MotionConfig>))
        const tile = container.querySelector<HTMLElement>('[aria-label="Open chat with Researcher"]')!
        await act(async () => tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
        expect(container.querySelector('[data-thread-row="sibling"]')).not.toBeNull()
        background = Response.json({ error: 'Temporary read failure' }, { status: 503 })
        await tick()
        expect(container.querySelector('[data-thread-row="sibling"]')).not.toBeNull()
        expect(container.textContent).not.toContain('Temporary read failure')
        background = undefined
        networkDropped = true
        await tick()
        expect(container.querySelector('[data-thread-row="sibling"]')).not.toBeNull()
        expect(container.textContent).not.toContain('Failed to fetch')
        networkDropped = false
        const beforeFocus = threadReads()
        expect(container.querySelector('[data-thread-row="new-sibling"]')).toBeNull()
        await act(async () => { window.dispatchEvent(new Event('focus')) })
        expect(threadReads()).toBe(beforeFocus + 1)
        expect(container.querySelector('[data-thread-row="new-sibling"]')?.textContent ?? '').toContain('Saved on another surface')
        visibility.mockReturnValue('hidden')
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')) })
        expect(threadReads()).toBe(beforeFocus + 1)
        visibility.mockReturnValue('visible')
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
        expect(threadReads()).toBe(beforeFocus + 2)
        const branch = () => container.querySelector('[data-thread-row="sibling"]')!
        expect(branch().textContent).toContain('Scheduled run · Weekly digest')
        expect(branch().querySelector('[aria-label="Running"]')).not.toBeNull()
        runStatus = 'error'
        await tick()
        expect(branch().querySelector('[aria-label="Running"]')).toBeNull()
        expect(branch().textContent).toContain('Error')
        runStatus = 'done'
        waiting = true
        await tick()
        expect(branch().textContent).not.toContain('Error')
        expect(branch().textContent).toContain('Needs you')
        expect(container.querySelector('[data-thread-row="new-sibling"]')?.textContent).not.toContain('Needs you')
        waiting = false
        await tick()
        expect(branch().textContent).not.toContain('Needs you')
        outcome = 'done'
        await tick()
        expect(branch().textContent).toContain('No new leads')
        const title = () => [...branch().querySelectorAll('button span')].find(span => span.textContent === 'No new leads')!
        expect(title().classList.contains('text-muted-foreground')).toBe(false)
        outcome = 'nothing'
        await tick()
        expect(title().classList.contains('text-muted-foreground')).toBe(true)
        expect(fetcher.mock.calls.filter(([url, options]) => url.endsWith('/tabs') && options?.method === 'PUT')).toHaveLength(0)
        await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close panel"]')!.click())
        const requests = fetcher.mock.calls.filter(([url]) => url === path + '?view=threads').length
        await act(async () => { window.dispatchEvent(new Event('focus')) })
        await tick()
        expect(fetcher.mock.calls.filter(([url]) => url === path + '?view=threads')).toHaveLength(requests)
    } finally {
        await act(async () => root.unmount())
        visibility.mockRestore()
        vi.useRealTimers()
    }
})

test('the board workspace menu edits the local profile and displays the saved name and photo', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const photoId = '11111111-1111-4111-8111-111111111111'
    const profilePath = '/api/desktop/profile'
    const copy = desktopMessages('en', await loadMessages('en')).localProfile
    let failName = true
    let profile = { id: 1, displayName: 'Local User', photoId: null as string | null }
    const fetcher = mockDesktopFetch((url, init) => {
        if (url === settingsUrl && !init?.method) return Response.json(disconnected)
        if (url === profilePath && init?.method === 'PUT') {
            if (failName) return Response.json({ error: 'Could not save' }, { status: 409 })
            profile = { ...profile, displayName: JSON.parse(String(init.body)).name }
            return Response.json(profile)
        }
        if (url === profilePath + '/photo' && init?.method === 'PUT') {
            profile = { ...profile, photoId }
            return Response.json(profile)
        }
        if (url === profilePath + '/photo' && init?.method === 'DELETE') {
            profile = { ...profile, photoId: null }
            return Response.json(profile)
        }
    })
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
    const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(element =>
        element.getAttribute('aria-label') === label || element.textContent?.trim() === label)!
    const avatar = () => document.querySelector(`img[src="${profilePath}/photo?id=${photoId}"]`)
    async function openWorkspaceMenu() {
        const menu = container.querySelector<HTMLButtonElement>('[aria-label^="Workspace menu,"]')!
        menu.focus()
        await act(async () => { menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
    }
    async function openProfile() {
        await openWorkspaceMenu()
        const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent?.trim() === copy.title)!
        await act(async () => { item.click() })
        expect(dialog().querySelector('[data-slot="dialog-title"]')?.textContent).toBe(copy.title)
    }
    try {
        await act(async () => { root.render(<DesktopApp initialData={{ ...disconnected, theme: 'system', profile,
            workspace: { id: 1, name: 'Studio' }, agents: [] }} />) })
        await openProfile()
        const field = dialog().querySelector<HTMLInputElement>('input[autocomplete="name"]')!
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '  Élodie Park  ')
            field.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await act(async () => { button(copy.fields.save).click() })
        expect(fetcher).toHaveBeenCalledWith(profilePath, expect.objectContaining({ method: 'PUT', body: '{"name":"Élodie Park"}' }))
        expect(field.value).toBe('  Élodie Park  ')
        failName = false
        await act(async () => { button(copy.fields.save).click() })
        expect(field.value).toBe('Élodie Park')
        const input = dialog().querySelector<HTMLInputElement>('input[type="file"]')!
        const photo = new File(['fixture'], 'profile.png', { type: 'image/png' })
        await act(async () => {
            Object.defineProperty(input, 'files', { configurable: true, value: [photo] })
            input.dispatchEvent(new Event('change', { bubbles: true }))
        })
        expect(fetcher).toHaveBeenCalledWith(profilePath + '/photo', expect.objectContaining({ method: 'PUT', body: photo }))
        expect(avatar()).toBeTruthy()
        await act(async () => { dialog().querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click() })
        await openWorkspaceMenu()
        expect(document.querySelector('[role="menu"]')?.textContent).toContain('Élodie Park')
        expect(document.querySelector('[role="menu"]')?.contains(avatar())).toBe(true)
        const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent?.trim() === copy.title)!
        await act(async () => { item.click() })
        await act(async () => { button(copy.fields.changePhoto).click() })
        await act(async () => { button(copy.fields.removePhoto).click() })
        expect(fetcher).toHaveBeenCalledWith(profilePath + '/photo', expect.objectContaining({ method: 'DELETE' }))
        expect(avatar()).toBeNull()
    } finally {
        await act(async () => root.unmount())
    }
})
