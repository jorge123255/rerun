// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { ConnectionSummary } from '@rerun/contracts'
import { buildDesktopModelView, type DesktopModelPick } from '@/lib/desktop/chat-model'
import { loadMessages } from '@rerun/i18n/messages'
import { desktopMessages } from '@/lib/desktop/locale'
import { DesktopLocale } from './DesktopLocale'
import { DesktopConversation } from './DesktopConversation'
import { DesktopModelSelector } from './DesktopModelSelector'
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const local = { id: 'local', name: 'Local', provider: 'openrouter' as const, models: ['model-workspace', 'model-coworker', 'model-chat', 'model-bob'], extraModels: [], createdAt: '', connected: true, credentialRejected: false, planLimits: null }
let coworker: { connectionId: string | null; provider: string | null; model: string | null } | null = null
let conversations: Record<string, DesktopModelPick | null> = {}
const patches: unknown[] = []
const reported: Array<DesktopModelPick | undefined> = []
let container: HTMLDivElement
let root: Root

function view(conversation: DesktopModelPick | null) {
    return buildDesktopModelView({ connections: [local as ConnectionSummary], workspace: { connectionId: 'local', model: 'model-workspace' }, coworker, conversation })
}
const button = (label: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === label)
async function click(label: string) {
    const target = button(label)
    expect(target, label).toBeTruthy()
    await act(async () => { target!.click() })
}
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers() })

test('a click changes one chat, a star pins the coworker, and workspace default clears only that pin', async () => {
    coworker = null
    conversations = { one: null, two: { connectionId: 'local', model: 'model-bob' } }
    patches.length = 0
    reported.length = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const sessionId = new URL(url, 'http://local').searchParams.get('sessionId') ?? ''
        if (init?.method === 'PATCH') {
            const body = JSON.parse(String(init.body))
            patches.push(body)
            if (body.action === 'conversation') conversations[body.sessionId] = { connectionId: body.connectionId, model: body.model }
            if (body.action === 'conversation-follow') conversations[body.sessionId] = null
            if (body.action === 'coworker') coworker = { connectionId: body.connectionId, provider: 'openrouter', model: body.model }
            if (body.action === 'follow-workspace') {
                coworker = null
                if (body.sessionId) conversations[body.sessionId] = null
            }
        }
        return Response.json(view(conversations[sessionId] ?? null))
    }))
    function Harness() {
        const [sessionId, setSessionId] = useState('one')
        return <>
            <button type="button" onClick={() => setSessionId('two')}>Switch chat</button>
            <DesktopModelSelector agentId="alice" sessionId={sessionId} onConversationChoice={choice => { reported.push(choice) }} />
        </>
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => { root.render(<Harness />) })
    expect(button('Local · model-workspace')).toBeTruthy()
    await click('Local · model-workspace')
    await click('model-chat')
    expect(patches.at(-1)).toEqual({ action: 'conversation', sessionId: 'one', connectionId: 'local', model: 'model-chat' })
    expect(coworker).toBeNull()
    expect(button('Local · model-chat')).toBeTruthy()
    const star = [...document.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === "Make model-coworker this coworker's default")
    expect(star).toBeTruthy()
    await act(async () => { star!.click() })
    expect(patches.at(-1)).toEqual({ action: 'coworker', connectionId: 'local', model: 'model-coworker', sessionId: 'one' })
    expect(conversations.one).toEqual({ connectionId: 'local', model: 'model-chat' })
    expect(button('Local · model-chat')).toBeTruthy()
    const workspaceDefault = [...document.querySelectorAll('button')].find(item => item.textContent?.includes('Workspace default'))
    expect(workspaceDefault).toBeTruthy()
    await act(async () => { workspaceDefault!.click() })
    expect(patches.at(-1)).toEqual({ action: 'follow-workspace', sessionId: 'one' })
    expect(coworker).toBeNull()
    expect(conversations.two).toEqual({ connectionId: 'local', model: 'model-bob' })
    const beforeSwitch = reported.length
    await click('Switch chat')
    expect(button('Local · model-bob')).toBeTruthy()
    expect(patches.filter(body => JSON.stringify(body).includes('model-chat') && JSON.stringify(body).includes('"two"'))).toEqual([])
    expect(reported.slice(beforeSwitch).some(choice => choice?.model === 'model-chat')).toBe(false)
    expect(reported.at(-1)).toEqual({ connectionId: 'local', model: 'model-bob' })
})

test.each([true, false])('a late save result is isolated when switching chats (success=%s)', async success => {
    coworker = null
    reported.length = 0
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
            await held
            return success ? Response.json(view({ connectionId: 'local', model: 'model-chat' }))
                : Response.json({ error: 'Save failed for first chat' }, { status: 409 })
        }
        const second = new URL(url, 'http://local').searchParams.get('sessionId') === 'two'
        return Response.json(view(second ? { connectionId: 'local', model: 'model-bob' } : null))
    }))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const render = (sessionId: string) => act(async () => root.render(<DesktopModelSelector agentId="alice" sessionId={sessionId}
        onConversationChoice={choice => { reported.push(choice) }} />))
    await render('one')
    await click('Local · model-workspace')
    await click('model-chat')
    await render('two')
    expect(button('Local · model-bob')).toBeTruthy()
    await act(async () => release())
    expect(reported.at(-1)).toEqual({ connectionId: 'local', model: 'model-bob' })
    expect(button('Local · model-bob')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Save failed for first chat')
})

test('opens model setup directly in the workspace language after an empty model load', async () => {
    const empty = buildDesktopModelView({ connections: [], workspace: null, coworker: null, conversation: null })
    const fetcher = vi.fn(async () => Response.json(empty))
    vi.stubGlobal('fetch', fetcher)
    const onOpenSettings = vi.fn()
    const onReady = vi.fn()
    const onBlocked = vi.fn()
    const language = { locale: 'fr' as const, preference: 'fr' as const, messages: desktopMessages('fr', await loadMessages('fr')) }
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    await act(async () => root.render(<DesktopLocale initial={language}>
        <DesktopModelSelector agentId="alice" sessionId="open" onOpenSettings={onOpenSettings} onReady={onReady} onBlocked={onBlocked} />
    </DesktopLocale>))
    await click(language.messages.modelPicker.setUp)
    expect(onOpenSettings).toHaveBeenCalledOnce()
    expect(onBlocked).toHaveBeenLastCalledWith('setup')
    expect(onReady).toHaveBeenLastCalledWith(false)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
})

test('keeps a saved chat choice through missing workspace setup and admits it when the default returns', async () => {
    const choice = { connectionId: 'local', model: 'model-chat' }
    const snapshot = (configured: boolean) => buildDesktopModelView({
        connections: [local], workspace: configured ? { connectionId: local.id, model: 'model-workspace' } : null,
        coworker: null, conversation: choice,
    })
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(snapshot(false))).mockResolvedValueOnce(Response.json(snapshot(true)))
    vi.stubGlobal('fetch', fetcher)
    const onReady = vi.fn()
    const onBlocked = vi.fn()
    const onConversationChoice = vi.fn()
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    const render = (active: boolean) => act(async () => root.render(<DesktopModelSelector agentId="alice" sessionId="open"
        active={active} onReady={onReady} onBlocked={onBlocked} onConversationChoice={onConversationChoice} />))
    await render(true)
    expect(button('Local · model-chat')).toBeTruthy()
    expect(onConversationChoice).toHaveBeenCalledExactlyOnceWith(choice)
    expect(onReady).toHaveBeenLastCalledWith(false)
    expect(onBlocked).toHaveBeenLastCalledWith('setup')
    await render(false)
    await render(true)
    expect(button('Local · model-chat')).toBeTruthy()
    expect(onReady).toHaveBeenLastCalledWith(true)
    expect(onBlocked).toHaveBeenLastCalledWith(null)
    expect(onConversationChoice).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls.every(([, options]) => !options.method)).toBe(true)
})

test('shows an unavailable saved model instead of replacing it', async () => {
    coworker = { connectionId: 'local', provider: 'openrouter', model: 'model-coworker' }
    conversations = {}
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(buildDesktopModelView({
        connections: [local as ConnectionSummary], workspace: { connectionId: 'local', model: 'model-workspace' }, coworker,
        conversation: { connectionId: 'local', model: 'model-retired' },
    }))))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => { root.render(<DesktopModelSelector agentId="alice" sessionId="open" />) })
    expect(button('Unavailable · model-retired')).toBeTruthy()
    expect(document.querySelector('[role="alert"]')).toBeNull()
})

test('shows a review message for a stale custom effort on the board picker', async () => {
    const connection = { ...local, name: 'Grok API', provider: 'custom' as const, customRevision: 2,
        models: ['grok-fixture'], customReasoning: { 'grok-fixture': { supported: ['low' as const], default: 'low' as const } } }
    const workspace = { connectionId: connection.id, model: 'grok-fixture', reasoningEffort: 'low', customReasoningRevision: 1 }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(buildDesktopModelView({
        connections: [connection], workspace, coworker: null, conversation: null,
    }))))
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    await act(async () => { root.render(<DesktopModelSelector agentId="alice" sessionId="open" />) })
    await click('Grok API · grok-fixture')
    expect(document.body.textContent).toContain('The saved reasoning effort needs review in model settings.')
    expect(document.body.textContent).not.toContain('this model’s default')
})

test('Send opens the picker for a retired model and preserves the draft until a replacement is chosen', async () => {
    coworker = null
    conversations = { open: null }
    patches.length = 0
    const sent = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/desktop/chat') {
            sent()
            return Response.json({ error: 'No provider call expected' }, { status: 409 })
        }
        if (String(url).endsWith('/approvals') && (init?.method ?? 'GET') === 'GET') return Response.json({ approval: null })
        if (String(url).endsWith('/questions') && (init?.method ?? 'GET') === 'GET') return Response.json({ question: null })
        if (String(url).includes('/model')) {
            if (init?.method === 'PATCH') patches.push(JSON.parse(String(init.body)))
            return Response.json(view(patches.some(body => (body as { action?: string }).action === 'conversation') ? { connectionId: 'local', model: 'model-chat' } : { connectionId: 'local', model: 'model-retired' }))
        }
        if (String(url).endsWith('/messages')) return Response.json({ messages: [{ id: 'saved', role: 'assistant', parts: [{ type: 'text', text: 'Saved answer' }] }] })
        if (String(url).endsWith('/stop')) return Response.json({ running: false })
        if ((init?.method ?? 'GET') === 'GET') {
            if (/^\/api\/desktop\/agents\/[^/]+\/queue\?/.test(url)) return Response.json({ queued: null })
            if (/^\/api\/desktop\/sessions\/[^/]+\/feedback(?:\?|$)/.test(url)) return Response.json({ votes: [] })
        }
        const background = desktopBackgroundRead(url, init); if (background) return background
        throw new Error(`Unexpected request ${url}`)
    }))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const agent = { id: 'alice', name: 'Alice', description: '', createdAt: '', updatedAt: '' }
    await act(async () => { root.render(<DesktopConversation agent={agent} sessionId="open" sessions={[{ id: 'open', agentId: 'alice', title: 'Open', createdAt: '', updatedAt: '' }]} onSelectSession={() => {}} onChatSession={() => {}} />) })
    const composer = container.querySelector('textarea')!
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, 'Keep this draft')
        composer.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(button('Unavailable · model-retired')).toBeTruthy()
    await act(async () => composer.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(sent).not.toHaveBeenCalled()
    expect(patches).toEqual([])
    expect(document.body.textContent).toContain('This saved model is no longer offered.')
    expect(composer.value).toBe('Keep this draft')
    await click('model-chat')
    expect(patches.at(-1)).toMatchObject({ action: 'conversation', sessionId: 'open', model: 'model-chat' })
    expect(composer.value).toBe('Keep this draft')
    expect(container.textContent).toContain('Saved answer')
})

test('the usage rings follow the exact chat connection, update with the latest snapshot, and expire', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-11-11T12:00:00.000Z'))
    const capturedAt = new Date().toISOString()
    const codex: ConnectionSummary = {
        ...local, id: 'codex', provider: 'codex', name: 'ChatGPT', models: ['model-chatgpt'],
        planLimits: { capturedAt, windows: [
            { kind: 'session', label: null, usedPercent: 26, resetsAt: null },
            { kind: 'weekly', label: null, usedPercent: 81, resetsAt: null },
        ] },
    }
    let saved: DesktopModelPick | null = null
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
            const { connectionId, model } = JSON.parse(String(init.body))
            saved = { connectionId, model }
        }
        return Response.json(buildDesktopModelView({
            connections: [local, codex], workspace: { connectionId: codex.id, model: codex.models[0] }, coworker: null, conversation: saved,
        }))
    }))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const render = (connection: ConnectionSummary) => act(async () => root.render(
        <DesktopModelSelector agentId="alice" sessionId="open" connections={[local, connection]} />,
    ))
    const usageRing = () => container.querySelector('[data-slot="model-usage-ring"]')
    const usageLabel = () => button('ChatGPT · model-chatgpt')?.getAttribute('aria-label')
    await render(codex)
    expect(usageRing()?.querySelectorAll('circle')).toHaveLength(4)
    expect(usageLabel()).toContain('Session 26% used, Weekly 81% used')
    await click('ChatGPT · model-chatgpt')
    await click('model-chat')
    expect(button('Local · model-chat')?.getAttribute('aria-label')).not.toContain('used')
    expect(usageRing()).toBeNull()
    await click('model-chatgpt')
    expect(usageLabel()).toContain('Session 26% used')
    await render({ ...codex, planLimits: { capturedAt, windows: [{ kind: 'session', label: null, usedPercent: 49, resetsAt: null }] } })
    expect(usageRing()?.querySelectorAll('circle')).toHaveLength(2)
    expect(usageLabel()).toContain('Session 49% used')
    await render({ ...codex, connected: false })
    expect(usageRing()).toBeNull()
    await render(codex)
    expect(usageRing()).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(300001) })
    expect(usageRing()).toBeNull()
    expect(usageLabel()).not.toContain('used')
})
