// @vitest-environment happy-dom
import { act, useEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopServiceRequestMutation } from '@rerun/contracts'
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
import { DesktopConversation } from './DesktopConversation'
import { nextCardRevision, scope, serviceRequestFixture } from './service-requests/service-request-fixtures'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('./DesktopModelSelector', () => ({ DesktopModelSelector: ({ onReady }: { onReady?: (value: boolean) => void }) => { useEffect(() => onReady?.(true), [onReady]); return null } }))
vi.mock('./services/DesktopServicesDialog', () => ({ DesktopServicesDialog: ({ dialogControl, focusSlug }: { dialogControl: { open: boolean; onOpenChange: (open: boolean) => void }; focusSlug?: string }) => dialogControl.open
    ? <div role="dialog" aria-label="Apps"><span>{focusSlug}</span><button onClick={() => dialogControl.onOpenChange(false)}>Close Apps</button></div> : null }))
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

const agent = { id: scope.agentId, name: 'Service QA', description: '', createdAt: '', updatedAt: '' }
const onChatSession = vi.fn(), onSelectSession = vi.fn()
let root: Root, container: HTMLDivElement
let detail: ReturnType<typeof serviceRequestFixture> | null
let attempt: DesktopServiceRequestMutation | null
let streamSignal: AbortSignal | undefined
let running = false, unavailable = false
const writes: { url: string; body: DesktopServiceRequestMutation | null }[] = []
const text = new TextEncoder()
const saved = [{ id: 'saved', role: 'user', parts: [{ type: 'text', text: 'Please check the app.' }] }]

beforeEach(() => {
    detail = serviceRequestFixture(); attempt = null; running = false; unavailable = false; streamSignal = undefined; writes.length = 0
    onChatSession.mockReset(); onSelectSession.mockReset()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://local'), method = init?.method ?? 'GET'
        const body = init?.body ? JSON.parse(String(init.body)) : null
        if (url.pathname.endsWith('/service-requests/retry')) {
            if (method === 'PUT') attempt = body
            if (method === 'DELETE') attempt = null
            return Response.json({ attempt })
        }
        if (url.pathname.endsWith('/service-requests')) {
            if (method === 'GET') return unavailable ? Response.json({ error: 'Unavailable' }, { status: 503 }) : Response.json({ request: detail })
            writes.push({ url: url.pathname, body })
            if (body.action === 'progress') {
                detail = { ...detail!, choices: body.choices, revision: nextCardRevision }
                return Response.json({ serviceRequestId: scope.serviceRequestId, revision: nextCardRevision, currentIndex: 0, choices: body.choices })
            }
            running = true; detail = null; streamSignal = init!.signal!
            return new Response(new ReadableStream<Uint8Array>({ start(controller) {
                for (const chunk of [{type:'start',messageId:'reply'}, {type:'text-start',id:'text'}, {type:'text-delta',id:'text',delta:'I will continue without that app.'}]) controller.enqueue(text.encode(`data: ${JSON.stringify(chunk)}\n\n`))
                streamSignal!.addEventListener('abort', () => controller.error(new DOMException('Stopped', 'AbortError')), { once: true })
            } }), { headers: { 'content-type': 'text/event-stream', 'x-service-request-id': scope.serviceRequestId, 'x-session-id': scope.sessionId, 'x-run-id': body.requestId } })
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
const mount = () => act(async () => root.render(<DesktopConversation agent={agent} sessionId={scope.sessionId} sessions={[]} initialDraft={{text:'Keep my separate draft'}} onChatSession={onChatSession} onSelectSession={onSelectSession} />))
const click = (name: string) => act(async () => { expect(button(name), name).toBeDefined(); button(name).click() })

test('a confirmed Finish transfers its live reply to chat and Stop without sending another turn or losing the draft', async () => {
    await mount()
    expect(container.querySelector('form')!.hidden).toBe(true)
    await click('Not now')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)) })
    expect(writes.map(item => item.body?.action)).toEqual(['progress', 'finish'])
    expect(container.textContent).toContain('I will continue without that app.')
    expect(container.querySelector('form')!.hidden).toBe(false)
    expect(streamSignal?.aborted).toBe(false)
    expect(button('Stop')).toBeDefined()
    await click('Stop')
    expect(streamSignal?.aborted).toBe(true)
    expect(writes.filter(item => item.url.endsWith('/stop'))).toHaveLength(1)
    expect(writes.some(item => item.url === '/api/desktop/chat')).toBe(false)
    expect(container.querySelector('textarea')!.value).toBe('Keep my separate draft')
    expect(attempt).toBeNull()
})

test('Connect opens its exact app and closing Apps preserves the request and draft without an answer', async () => {
    await mount(); await click('Connect')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('fixture')
    await click('Close Apps')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(button('Connect').disabled).toBe(false)
    expect(writes).toHaveLength(0)
    expect(container.querySelector('textarea')!.value).toBe('Keep my separate draft')
    expect(container.querySelector('form')!.hidden).toBe(true)
})

test('an unavailable app request prevents an ordinary send until its state can be read', async () => {
    unavailable = true; await mount()
    expect(container.textContent).toContain('Could not load the coworker’s app request')
    expect(button('Send').disabled).toBe(true)
    expect(writes).toHaveLength(0)
})
