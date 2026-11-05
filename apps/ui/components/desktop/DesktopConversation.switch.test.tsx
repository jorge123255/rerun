// @vitest-environment happy-dom
import { desktopNativeReviewRead } from '@/test/desktop-background-fixture'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { DesktopConversation } from './DesktopConversation'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

test('switching, failed loads, retry, and New chat keep drafts and never show another transcript', async () => {
    const sessions = ['first', 'second', 'slow'].map(id => ({ id, agentId: 'agent', title: id, createdAt: '', updatedAt: '' }))
    const agent = { id: 'agent', name: 'Researcher', description: '', createdAt: '', updatedAt: '' }
    function Harness() {
        const [id, select] = useState<string | null>('first')
        return <DesktopConversation agent={agent} sessionId={id} sessions={sessions} onSelectSession={select} onChatSession={select} />
    }
    const messages = (text: string) => Response.json({ messages: [{ id: text, role: 'assistant', parts: [{ type: 'text', text }] }] })
    let failSecond = true
    let resolveSlow!: (value: Response) => void
    let sends = 0
    vi.stubGlobal('fetch', vi.fn((url: string) => {
        const nativeReview = desktopNativeReviewRead(url); if (nativeReview) return nativeReview
        if (url.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.endsWith('/questions')) return Response.json({ question: null })
        if (url.includes('/queue?')) return Response.json({ queued: null })
        if (url.includes('/first/messages')) return messages('First answer.')
        if (url.includes('/second/messages')) return failSecond ? Response.json({ error: 'History unavailable' }, { status: 502 }) : messages('Second answer.')
        if (url.includes('/slow/messages')) return new Promise<Response>(resolve => { resolveSlow = resolve })
        if (url.endsWith('/chat')) sends++
        if (url.includes('/model')) return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null, effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } })
        throw new Error('Unexpected request: ' + url)
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
        await act(async () => { root.render(<Harness />) })
        const composer = container.querySelector('textarea')!
        const send = container.querySelector<HTMLButtonElement>('button[type="submit"]')!
        const select = container.querySelector('select')!
        const switchTo = (id: string) => act(async () => {
            select.value = id
            select.dispatchEvent(new Event('change', { bubbles: true }))
        })
        const click = (name: string) => act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === name)!.click() })
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, 'Draft to keep')
            composer.dispatchEvent(new Event('input', { bubbles: true }))
            composer.dispatchEvent(new Event('change', { bubbles: true }))
        })
        expect(container.textContent).toContain('First answer.')
        await switchTo('slow')
        expect(container.textContent).not.toContain('First answer.')
        expect(container.textContent).toContain('Loading conversation')
        expect(send.disabled).toBe(true)
        await switchTo('second')
        expect(container.querySelector('[role="alert"]')?.textContent).toContain('History unavailable')
        expect(container.textContent).not.toContain('First answer.')
        expect(send.disabled).toBe(true)
        await act(async () => { composer.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
        expect(sends).toBe(0)
        expect(composer.value).toBe('Draft to keep')
        failSecond = false
        await click('Retry conversation')
        expect(container.textContent).toContain('Second answer.')
        expect(send.disabled).toBe(false)
        await act(async () => { resolveSlow(messages('Stale slow answer.')) })
        expect(container.textContent).not.toContain('Stale slow answer.')
        expect(container.textContent).toContain('Second answer.')
        await click('New chat')
        expect(container.textContent).not.toContain('Second answer.')
        expect(container.textContent).toContain('Start a conversation')
        expect(container.querySelector('textarea')).toBe(composer)
        expect(composer.value).toBe('Draft to keep')
        expect(send.disabled).toBe(false)
    } finally {
        await act(async () => { root.unmount() })
        vi.unstubAllGlobals()
        container.remove()
    }
})
