// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
import { desktopDetailsWanted, setDesktopDetailsWanted } from '@/lib/desktop/simple-details'
import { DesktopConversation } from './DesktopConversation'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('./DesktopModelSelector', () => ({ DesktopModelSelector: ({ onReady }: { onReady?: (value: boolean) => void }) => { useEffect(() => onReady?.(true), [onReady]); return null } }))
vi.mock('./coworker-overview/conversation-mount', () => ({ DesktopConversationOverview: () => <div data-testid="overview" /> }))

const agent = (id: string) => ({ id, name: id, description: '', createdAt: '', updatedAt: '' })
let root: Root, container: HTMLDivElement, wide = true

beforeEach(() => {
    wide = true
    setDesktopDetailsWanted(false)
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('1280') ? wide : false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null }))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://local')
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
const card = () => container.querySelector<HTMLElement>('section[aria-label="Coworker details"]')!
const pill = () => container.querySelector<HTMLButtonElement>('h1 button')!

test('on a wide window the card stays closed until asked for, then is kept from one coworker to the next', async () => {
    await mount('ann')
    // Before upstream #276 a window from 1280 wide opened the column by itself.
    expect(card().hidden).toBe(true)
    expect(container.querySelector('[data-testid="overview"]')).toBeNull()
    await act(async () => { pill().click() })
    expect(card().hidden).toBe(false)
    expect(card().dataset.cardBeside).toBe('true')
    expect(container.querySelector('[data-testid="overview"]')).not.toBeNull()
    expect(desktopDetailsWanted()).toBe(true)
    // Open beside one coworker, it is open beside the next.
    await mount('bo')
    expect(card().hidden).toBe(false)
    expect(card().dataset.cardBeside).toBe('true')
    // Closed from its pill, it stays closed for the next one.
    await act(async () => { pill().click() })
    expect(card().hidden).toBe(true)
    expect(desktopDetailsWanted()).toBe(false)
    await mount('cy')
    expect(card().hidden).toBe(true)
})

test('the Chief of Staff opening its panel opens the card of the coworker shown next, and a narrow window opens nothing by itself', async () => {
    await mount('ann')
    expect(card().hidden).toBe(true)
    await act(async () => { setDesktopDetailsWanted(true) })
    expect(card().hidden).toBe(false)
    wide = false
    setDesktopDetailsWanted(true)
    await mount('bo')
    expect(card().hidden).toBe(true)
    // Outside the Simple view nothing follows the column's state.
    wide = true
    await mount('cy', false)
    expect(card().hidden).toBe(true)
})
