// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { desktopNativeReviewRead } from '@/test/desktop-background-fixture'
import { DesktopConversation } from './DesktopConversation'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

test('an unavailable request check preserves freshly read messages in the same chat while its run is active', async () => {
    const agent = { id: 'agent', name: 'Release manager', description: '', createdAt: '', updatedAt: '' }
    const sessions = [{ id: 'same', agentId: agent.id, title: 'Setup thread', createdAt: '', updatedAt: '' }]
    let version = 1
    let questionStatus = 200
    let messagesStatus = 200
    let messageReads = 0
    let sends = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/messages')) {
            messageReads++
            if (messagesStatus !== 200) return Response.json({ error: 'Conversation unavailable' }, { status: messagesStatus })
            return Response.json({
                runVersion: String(version),
                messages: [
                    { id: 'engine-message', role: 'user', parts: [{ type: 'text', text: 'Saved setup instructions.' }] },
                    { id: 'engine-answer', role: 'assistant', parts: [
                        { type: 'text', text: 'Read ' + version + ' from the same conversation.' },
                        { type: 'tool-shell_exec', toolCallId: 'command-1', state: 'output-available', input: { command: 'command input' }, output: 'internal tool detail' },
                    ] },
                ],
            })
        }
        if (url.endsWith('/stop')) return Response.json({ running: version > 1, runId: version > 1 ? 'active-run' : null, runVersion: String(version) })
        if (url.endsWith('/questions')) return questionStatus === 200
            ? Response.json({ question: null })
            : Response.json({ error: 'Question status unavailable' }, { status: questionStatus })
        if (url.endsWith('/approvals')) return Response.json({ approval: null })
        const background = desktopNativeReviewRead(url)
        if (background) return background
        if (url.includes('/queue?')) return Response.json({ queued: null })
        if (url.includes('/model')) return Response.json({ catalog: [], workspace: null, coworker: null, conversation: null, effective: { source: 'workspace', connectionId: null, provider: null, name: null, model: null, label: 'Select model', available: false } })
        if (init?.method === 'POST') sends++
        throw new Error('Unexpected request: ' + url)
    }))
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const transcript = () => host.querySelector('[role="log"]')?.textContent
    const retry = () => act(async () => { Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Retry conversation')!.click() })
    const focus = () => act(async () => { window.dispatchEvent(new Event('focus')) })
    try {
        await act(async () => { root.render(<DesktopConversation agent={agent} sessions={sessions} sessionId="same" onChatSession={vi.fn()} onSelectSession={vi.fn()} />) })
        expect(transcript()).toContain('Saved setup instructions.')
        const composer = host.querySelector('textarea')!
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer, 'My next message')
            composer.dispatchEvent(new Event('input', { bubbles: true }))
        })
        version++
        questionStatus = 503
        await focus()
        expect(messageReads).toBe(2)
        expect(host.querySelector('[role="alert"]')?.textContent).toContain('Question status unavailable')
        expect(transcript()).toContain('Saved setup instructions.')
        expect(transcript()).toContain('Read 2 from the same conversation.')
        expect(transcript()).not.toContain('Read 1 from the same conversation.')
        expect(transcript()).not.toContain('internal tool detail')
        expect(host.querySelector('[role="log"] button[aria-pressed]')).toBeNull()
        expect(composer.value).toBe('My next message')
        expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
        await act(async () => { composer.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
        expect(sends).toBe(0)

        questionStatus = 200
        await retry()
        expect(transcript()).toContain('Saved setup instructions.')
        expect(host.textContent).not.toContain('Retry conversation')

        version++
        questionStatus = 403
        await focus()
        expect(host.textContent).toContain('Question status unavailable')
        expect(transcript()).not.toContain('Saved setup instructions.')

        questionStatus = 200
        await retry()
        expect(transcript()).toContain('Saved setup instructions.')
        version++
        messagesStatus = 403
        await focus()
        expect(host.textContent).toContain('Conversation unavailable')
        expect(transcript()).not.toContain('Saved setup instructions.')
    } finally {
        await act(async () => { root.unmount() })
        host.remove()
        vi.unstubAllGlobals()
    }
})
