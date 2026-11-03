// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { ConnectionSummary } from '@rerun/contracts'
import { buildDesktopModelView, type DesktopModelPick } from '@/lib/desktop/chat-model'
import { DesktopConversation } from './DesktopConversation'
import { DesktopModelSelector } from './DesktopModelSelector'

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
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

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
    const star = [...document.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === 'Make model-coworker this coworker’s default')
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

test('changing the model keeps the typed draft of an already open chat', async () => {
    coworker = null
    conversations = { open: null }
    patches.length = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('/model')) {
            if (init?.method === 'PATCH') patches.push(JSON.parse(String(init.body)))
            return Response.json(view(patches.some(body => (body as { action?: string }).action === 'conversation') ? { connectionId: 'local', model: 'model-chat' } : null))
        }
        if (String(url).endsWith('/messages')) return Response.json({ messages: [{ id: 'saved', role: 'assistant', parts: [{ type: 'text', text: 'Saved answer' }] }] })
        if (String(url).endsWith('/stop')) return Response.json({ running: false })
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
    await click('Local · model-workspace')
    await click('model-chat')
    expect(patches.at(-1)).toMatchObject({ action: 'conversation', sessionId: 'open', model: 'model-chat' })
    expect(composer.value).toBe('Keep this draft')
    expect(container.textContent).toContain('Saved answer')
})
