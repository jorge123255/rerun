// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
import { generalTabUid } from '@/lib/desktop/general-threads'
import { flushTabWrites } from '@/lib/desktop/tab-writes'
import type { DesktopCoworkerCallSnapshot } from '@/lib/desktop/coworker-calls-client'
import { DesktopChatTabs } from './DesktopChatTabs'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
const unexpected: string[] = []
beforeEach(() => vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible'))
afterEach(async () => {
    await act(async () => { root?.unmount(); await flushTabWrites() })
    root = undefined
    document.body.innerHTML = ''
    vi.unstubAllGlobals(); vi.restoreAllMocks()
    expect(unexpected.splice(0)).toEqual([])
})

async function mount(suffix: string) {
    const agent = { id: `caller-${suffix}`, name: 'Caller', description: '', createdAt: '', updatedAt: '' }
    const session = { id: `caller-chat-${suffix}`, agentId: agent.id, title: 'Original chat', createdAt: '', updatedAt: '' }
    const initialLayout = { revision: 0, activeIndex: 1, tabs: [
        { uid: generalTabUid(agent.id), id: null, title: 'General' },
        { uid: `call-tab-${suffix}`, id: session.id, title: session.title },
    ] }
    const drafts = createDesktopDraftFixture()
    drafts.seedTabs(agent.id, initialLayout.tabs)
    const call: DesktopCoworkerCallSnapshot = {
        callId: '00000000-0000-4000-8000-000000000001', revision: '1', parentAgentId: agent.id, parentSessionId: session.id,
        parentRunId: 'parent-run', toolCallId: 'saved-call-tool', targetAgentId: 'target-coworker', targetSessionId: 'target-chat',
        targetName: 'Researcher', wait: true, status: 'completed', createdAt: '2026-11-05T10:00:00.000Z', updatedAt: '2026-11-05T10:01:00.000Z',
        progress: { steps: 1, toolCalls: 0, failures: 0, preview: 'Saved target answer', calls: [] },
    }
    let calls = [call]
    const onOpenCoworkerChat = vi.fn(async (_target: { agentId: string; sessionId: string }) => {})
    const requests: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1'), method = init?.method ?? 'GET'
        requests.push(`${method} ${url.pathname}`)
        const draftResponse = drafts.handle(input, init)
        if (draftResponse) return draftResponse
        if (url.pathname === `/api/desktop/sessions/${session.id}/messages` && method === 'GET') return Response.json({ messages: [{
            id: 'engine-saved-answer', role: 'assistant', parts: [
                { type: 'tool-call_agent', toolCallId: call.toolCallId, state: 'output-available', input: { agentId: call.targetAgentId, message: 'Research this' }, output: 'Saved target answer' },
                { type: 'text', text: 'Here is the answer from Researcher.' },
            ],
        }] })
        if (url.pathname === `/api/desktop/sessions/${session.id}/coworker-calls` && method === 'GET') return Response.json({ calls })
        if (url.pathname.endsWith('/questions') && method === 'GET') return Response.json({ question: null })
        if (url.pathname.endsWith('/approvals') && method === 'GET') return Response.json({ approval: null })
        if (url.pathname.endsWith('/feedback') && method === 'GET') return Response.json({ votes: [] })
        if (url.pathname.endsWith('/queue') && method === 'GET') return Response.json({ queued: null })
        if (url.pathname.endsWith('/stop') && method === 'GET') return Response.json({ running: false })
        if (url.pathname.endsWith('/model') && method === 'GET') return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null,
            effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } })
        const background = desktopBackgroundRead(input, init)
        if (background) return background
        unexpected.push(`${method} ${url.pathname}`)
        throw new Error('Unexpected request')
    })
    vi.stubGlobal('fetch', fetcher)
    const container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
    await act(async () => root!.render(<DesktopChatTabs agent={agent} sessions={[session]} initialLayout={initialLayout} requested={null} selected
        refreshSessions={async () => {}} reload={() => {}} onOpenCoworkerChat={onOpenCoworkerChat} onClosePanel={() => {}} onOpenModelSettings={() => {}} />))
    return { container, call, onOpenCoworkerChat, requests, replaceCalls: (value: DesktopCoworkerCallSnapshot[]) => { calls = value } }
}

async function openChat(container: HTMLElement) {
    await act(async () => {
        const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === 'Open chat')
        expect(button).toBeTruthy()
        expect(button!.disabled).toBe(false)
        button!.click()
    })
}

test('saved coworker call Open chat reaches the board callback with freshly confirmed exact IDs', async () => {
    const f = await mount('open')
    f.replaceCalls([{ ...f.call, targetSessionId: 'recovered-target-chat' }])
    await openChat(f.container)
    expect(f.onOpenCoworkerChat).toHaveBeenCalledExactlyOnceWith({ agentId: 'target-coworker', sessionId: 'recovered-target-chat' })
    expect(f.requests.filter(request => request.endsWith('/coworker-calls'))).toHaveLength(2)
    expect(f.requests.every(request => request.startsWith('GET '))).toBe(true)
    expect(f.container.textContent).toContain('Original chat')
})

test('a saved call removed before Open chat stays in the original tab with an actionable error', async () => {
    const f = await mount('removed')
    f.replaceCalls([])
    await openChat(f.container)
    expect(f.onOpenCoworkerChat).not.toHaveBeenCalled()
    expect(f.container.textContent).toContain('This coworker chat is no longer available')
    expect(f.container.textContent).toContain('Original chat')
    expect(f.requests.every(request => request.startsWith('GET '))).toBe(true)
})
