// @vitest-environment happy-dom
import type { UIMessage } from 'ai'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { desktopAttachmentFieldsOf } from '@rerun/contracts'
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
import { DesktopConversation } from './DesktopConversation'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agent = { id: 'reader', name: 'Reader', description: '', createdAt: '', updatedAt: '' }
const marker = 'Find this line below the fold.'
const long = '@Ada\n' + 'A paragraph in the saved brief.\n'.repeat(34) + marker
const saved: UIMessage[] = [
    { id: 'engine-long', role: 'user', metadata: { ...desktopAttachmentFieldsOf(['brief.txt']),
        coworkerMentions: [{ targetId: 'ada', token: '@Ada', start: 0, end: 4 }] },
    parts: [{ type: 'text', text: long }] },
    { id: 'engine-short', role: 'user', parts: [{ type: 'text', text: 'A short note.' }] },
    { id: 'engine-answer', role: 'assistant', parts: [{ type: 'text', text: 'The brief is saved.' }] },
]

test('folds a saved long message, keeps its attachment outside the fold and reveals the full text for Find', async () => {
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.firstElementChild?.textContent === long ? 500 : 60
    })
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://local')
        if (url.pathname.endsWith('/messages')) return Response.json({ messages: saved })
        if (url.pathname.endsWith('/questions')) return Response.json({ question: null })
        if (url.pathname.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.pathname.endsWith('/queue')) return Response.json({ queued: null })
        const background = desktopBackgroundRead(input, init)
        if (background) return background
        return Response.json({}, { status: 404 })
    }))
    const findInPage = vi.fn(async ({ action }: { action: string }) => {
        if (action === 'start') {
            const body = Array.from(container.querySelectorAll('span')).find(node => node.textContent === long)?.parentElement
            expect(body?.parentElement?.style.maxHeight).toBe('')
        }
        return { ok: true, matches: 1, activeMatchOrdinal: 1 }
    })
    vi.stubGlobal('desktopApp', { findInPage })
    const container = document.body.appendChild(document.createElement('div'))
    let root = createRoot(container)
    const render = () => act(async () => root.render(
        <DesktopConversation agent={agent} sessionId="saved-thread" sessions={[]} onSelectSession={() => {}} onChatSession={() => {}} />,
    ))
    const toggles = () => [...container.querySelectorAll<HTMLButtonElement>('button[aria-controls][aria-expanded]')]
        .filter(button => button.textContent === 'Show more' || button.textContent === 'Show less')
    const toggle = () => toggles()[0] ?? null
    const click = (button: HTMLElement) => act(async () => button.click())
    const openFind = () => act(async () => { window.dispatchEvent(new Event('rerun-desktop-conversation-find')) })
    const closeFind = () => click(container.querySelector<HTMLButtonElement>('[aria-label="Close find"]')!)
    try {
        await render()
        expect(toggle()?.textContent).toBe('Show more')
        expect(toggles()).toHaveLength(1)
        const body = document.getElementById(toggle()!.getAttribute('aria-controls')!)!
        const viewport = body.parentElement!
        expect(viewport.style.maxHeight).toBe('384px')
        expect(body.textContent).toBe(long)
        expect(body.querySelector('span span')?.textContent).toBe('@Ada')
        expect(body.closest('.is-user')?.textContent).toContain('brief.txt')
        expect(body.textContent).not.toContain('brief.txt')

        await click(toggle()!)
        expect(toggle()!.textContent).toBe('Show less')
        expect(toggle()!.getAttribute('aria-expanded')).toBe('true')
        expect(viewport.style.maxHeight).toBe('500px')
        await openFind()
        expect(viewport.style.maxHeight).toBe('')
        expect(toggle()).toBeNull()
        await closeFind()
        expect(toggle()!.textContent).toBe('Show less')
        await click(toggle()!)
        expect(viewport.style.maxHeight).toBe('384px')

        await openFind()
        const input = container.querySelector<HTMLInputElement>('[aria-label="Find in conversation"]')!
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, marker)
            input.dispatchEvent(new Event('input', { bubbles: true }))
        })
        expect(findInPage).toHaveBeenCalledWith({ action: 'start', query: marker })
        expect(container.textContent).toContain('1 of 1')
        await closeFind()
        expect(viewport.style.maxHeight).toBe('384px')
        expect(toggle()!.textContent).toBe('Show more')

        await act(async () => root.unmount())
        root = createRoot(container)
        await render()
        expect(toggle()!.textContent).toBe('Show more')
        expect(document.getElementById(toggle()!.getAttribute('aria-controls')!)?.textContent).toBe(long)
    } finally {
        await act(async () => root.unmount())
        container.remove()
        height.mockRestore()
        vi.unstubAllGlobals()
    }
})
