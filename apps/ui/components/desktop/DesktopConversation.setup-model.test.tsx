// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
import { setDesktopDetailsWanted } from '@/lib/desktop/simple-details'
import { DesktopConversation } from './DesktopConversation'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('./DesktopModelSelector', () => ({ DesktopModelSelector: ({ onReady }: { onReady?: (value: boolean) => void }) => { useEffect(() => onReady?.(true), [onReady]); return <button type="button" data-testid="model-picker">Model</button> } }))
vi.mock('./coworker-overview/conversation-mount', () => ({ DesktopConversationOverview: () => <div data-testid="overview" /> }))

const agent = (id: string) => ({ id, name: id, description: '', createdAt: '', updatedAt: '' })
let root: Root, container: HTMLDivElement, wide = true
let setupView: Record<string, unknown>
const view = (extra: Record<string, unknown> = {}) => ({ agentId: 'ada', revision: 'r1', required: true, prompt: 'Install your tools.', completedAt: null, sessionId: null, pending: true, skipped: false, defaultPrompt: '', ...extra })

beforeEach(() => {
    wide = true
    setupView = view()
    setDesktopDetailsWanted(false)
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('1280') ? wide : false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null }))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://local')
        if (url.pathname.endsWith('/setup')) return Response.json(setupView)
        if (url.pathname.endsWith('/stop')) return Response.json({ running: false, runId: null })
        if (url.pathname.endsWith('/messages')) return Response.json({ messages: [] })
        if (url.pathname.endsWith('/questions')) return Response.json({ question: null })
        if (url.pathname.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.pathname.endsWith('/takeover')) return Response.json({ takeover: null })
        if (url.pathname.endsWith('/queue')) return Response.json({ queued: null })
        if (url.pathname.endsWith('/feedback')) return Response.json({ votes: [] })
        return desktopBackgroundRead(input, init) ?? Response.json({})
    }))
    container = document.body.appendChild(document.createElement('div')); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); setDesktopDetailsWanted(false) })

const mount = (id: string, cardBeside = true) => act(async () => root.render(<DesktopConversation key={id} cardBeside={cardBeside} overview={{} as never} agent={agent(id)} sessionId={`${id}-chat`} sessions={[]} onChatSession={vi.fn()} onSelectSession={vi.fn()} />))

const pickers = () => [...container.querySelectorAll<HTMLElement>('[data-testid="model-picker"]')]
const composer = () => container.querySelector<HTMLFormElement>('form[data-slot="desktop-composer"]')!

test('while setup holds the message box back, the model picker is on the install screen, so the model can be chosen before setup runs', async () => {
    await mount('ada', false)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(composer().hidden).toBe(true)
    expect(pickers()).toHaveLength(1)
    expect(composer().contains(pickers()[0])).toBe(false)
})

test('with no setup waiting, the one picker is in the message box', async () => {
    setupView = view({ required: false, prompt: '', pending: false })
    await mount('ada', false)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(composer().hidden).toBe(false)
    expect(pickers()).toHaveLength(1)
    expect(composer().contains(pickers()[0])).toBe(true)
})
