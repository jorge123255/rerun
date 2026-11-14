// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
import { DesktopConversation } from './DesktopConversation'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
})
afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
})

test.each([
    { title: 'a fresh imported coworker', claimed: null, current: null, pending: true, skipped: false, gate: 'Install Setup QA' },
    { title: 'another chat while setup is claimed', claimed: 'setup-chat', current: null, pending: true, skipped: false, gate: 'Continue setup' },
    { title: 'the exact claimed setup chat', claimed: 'setup-chat', current: 'setup-chat', pending: true, skipped: false, gate: null },
    { title: 'an explicitly skipped fresh setup', claimed: null, current: null, pending: false, skipped: true, gate: null },
])('$title uses the setup gate only when required', async ({ claimed, current, pending, skipped, gate }) => {
    const writes: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://local')
        if (init?.method && init.method !== 'GET') writes.push(url.pathname)
        if (url.pathname.endsWith('/setup')) return Response.json({ agentId: 'setup-qa', revision: 'setup-native-regression', required: true,
            prompt: 'Introduce yourself and wait for Finish setup.', completedAt: null, sessionId: claimed, pending, skipped, defaultPrompt: '' })
        const background = desktopBackgroundRead(input, init); if (background) return background
        if (url.pathname.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.pathname.endsWith('/questions')) return Response.json({ question: null })
        if (url.pathname.endsWith('/queue')) return Response.json({ queued: null })
        if (url.pathname.endsWith('/messages')) return Response.json({ messages: [] })
        return Response.json({ running: false })
    }))
    await act(async () => {
        root.render(<DesktopConversation agent={{ id: 'setup-qa', name: 'Setup QA', description: '', createdAt: '', updatedAt: '' }}
            sessionId={current} sessions={[]} onSelectSession={() => {}} onChatSession={() => {}} />)
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    const buttons = [...container.querySelectorAll('button')].map(button => button.textContent?.trim())
    if (gate) {
        expect(buttons).toContain(gate)
        expect(buttons).not.toContain('What can you help me with?')
        expect(container.textContent).not.toContain('Start a conversation')
        expect(container.querySelector('textarea')?.closest('form')?.hidden).toBe(true)
    } else {
        expect(buttons).not.toContain('Install Setup QA')
        expect(buttons).not.toContain('Continue setup')
        expect(container.querySelector('textarea')?.closest('form')?.hidden).toBe(false)
    }
    expect(writes).toEqual([])
})
