// @vitest-environment happy-dom
import { act, useEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopSecretRequestAction, DesktopSecretRequestView } from '@rerun/contracts'
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
import { DesktopConversation } from './DesktopConversation'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('./DesktopModelSelector', () => ({ DesktopModelSelector: ({ onReady }: { onReady?: (value: boolean) => void }) => { useEffect(() => onReady?.(true), [onReady]); return null } }))
vi.mock('motion/react', async original => {
    const actual = await original<typeof import('motion/react')>()
    const { createElement, forwardRef } = await import('react')
    const plain = (tag: string) => forwardRef<HTMLElement, Record<string, unknown>>(({ children, ...props }, ref) =>
        createElement(tag, { ...Object.fromEntries(Object.entries(props).filter(([name]) => !actual.isValidMotionProp(name))), ref }, children as ReactNode))
    const elements = new Map<string, ReturnType<typeof plain>>()
    const element = (tag: string) => { if (!elements.has(tag)) elements.set(tag, plain(tag)); return elements.get(tag)! }
    return { ...actual, AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>, motion: new Proxy(actual.motion, { get(target, key, receiver) {
        if (key === 'create') return (tag: unknown) => typeof tag === 'string' ? element(tag) : tag
        return typeof key === 'string' && key !== 'then' ? element(key) : Reflect.get(target, key, receiver)
    } }) }
})

const agent = { id: 'secret-agent', name: 'Credential QA', description: '', createdAt: '', updatedAt: '' }
const initial: DesktopSecretRequestView = {
    requestId: 'secret-request', revision: 'revision', source: { agentId: agent.id, sessionId: 'secret-chat', runId: 'source-run', sourceMessageId: 'source-message', toolCallId: 'source-tool', fingerprint: 'source-fingerprint' },
    fields: [{ key: 'EXAMPLE_API_KEY', label: 'Example API key', existing: false }], reason: 'Use the Example API.',
    status: 'pending', createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
}
let root: Root, container: HTMLDivElement, detail: DesktopSecretRequestView | null
let streamSignal: AbortSignal | undefined, running = false, unavailable = false
const writes: { url: string; body: DesktopSecretRequestAction | null }[] = []
const text = new TextEncoder()
const saved = [{ id: 'saved', role: 'user', parts: [{ type: 'text', text: 'Please set up the API.' }] }]

beforeEach(() => {
    detail = structuredClone(initial); running = false; unavailable = false; streamSignal = undefined; writes.length = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://local'), method = init?.method ?? 'GET'
        const body = init?.body ? JSON.parse(String(init.body)) : null
        if (url.pathname.endsWith('/secret-requests')) {
            if (method === 'GET') return unavailable ? Response.json({ error: 'Unavailable' }, { status: 503 }) : Response.json({ request: detail })
            writes.push({ url: url.pathname, body }); running = true; detail = null; streamSignal = init!.signal!
            return new Response(new ReadableStream<Uint8Array>({ start(controller) {
                for (const chunk of [{type:'start',messageId:'reply'}, {type:'text-start',id:'text'}, {type:'text-delta',id:'text',delta:'The credential is stored for this coworker.'}]) controller.enqueue(text.encode(`data: ${JSON.stringify(chunk)}\n\n`))
                streamSignal!.addEventListener('abort', () => controller.error(new DOMException('Stopped', 'AbortError')), { once: true })
            } }), { headers: { 'content-type': 'text/event-stream', 'x-secret-request-id': initial.requestId, 'x-session-id': 'secret-chat', 'x-run-id': 'continuation-run' } })
        }
        if (method !== 'GET') writes.push({ url: url.pathname, body })
        if (url.pathname.endsWith('/stop')) { if (method === 'POST') running = false; return Response.json({ running, runId: null }) }
        if (url.pathname.endsWith('/messages')) return Response.json({ messages: saved })
        if (url.pathname.endsWith('/questions')) return Response.json({ question: null })
        if (url.pathname.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.pathname.endsWith('/takeover')) return Response.json({ takeover: null })
        if (url.pathname.endsWith('/queue')) return Response.json({ queued: null })
        if (url.pathname.endsWith('/feedback')) return Response.json({ votes: [] })
        const background = desktopBackgroundRead(input, init); if (background) return background
        throw new Error(`Unexpected ${method} ${url.pathname}`)
    }))
    container = document.body.appendChild(document.createElement('div')); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const button = (name: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === name)!
const mount = () => act(async () => root.render(<DesktopConversation agent={agent} sessionId="secret-chat" sessions={[]} initialDraft={{text:'Keep my separate draft'}} onChatSession={vi.fn()} onSelectSession={vi.fn()} />))
const click = (name: string) => act(async () => { expect(button(name), name).toBeDefined(); button(name).click() })

test('secure Save transfers the accepted live reply to chat and Stop without leaking the credential or sending a second turn', async () => {
    await mount()
    expect(container.querySelector('form')!.hidden).toBe(true)
    const field = container.querySelector<HTMLInputElement>('[data-hitl="secret-EXAMPLE_API_KEY"]')!
    expect(field.type).toBe('password')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'private-test-value')
    await act(async () => field.dispatchEvent(new Event('input', { bubbles: true })))
    await click('Save')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)) })
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ url: '/api/desktop/sessions/secret-chat/secret-requests', body: { operation: 'save', values: { EXAMPLE_API_KEY: 'private-test-value' }, source: initial.source } })
    expect(container.textContent).toContain('The credential is stored for this coworker.')
    expect(container.textContent).not.toContain('private-test-value')
    expect(container.querySelector('[data-hitl="secret-EXAMPLE_API_KEY"]')).toBeNull()
    expect(container.querySelector('form')!.hidden).toBe(false)
    expect(streamSignal?.aborted).toBe(false)
    await click('Stop')
    expect(streamSignal?.aborted).toBe(true)
    expect(writes.filter(item => item.url.endsWith('/stop'))).toHaveLength(1)
    expect(writes.some(item => item.url === '/api/desktop/chat')).toBe(false)
    expect(container.querySelector('textarea')!.value).toBe('Keep my separate draft')
})

test('unavailable credential authority blocks an ordinary chat send until the source is known', async () => {
    unavailable = true; await mount()
    expect(container.textContent).toContain('Unavailable')
    expect(button('Send').disabled).toBe(true)
    expect(writes).toHaveLength(0)
})
