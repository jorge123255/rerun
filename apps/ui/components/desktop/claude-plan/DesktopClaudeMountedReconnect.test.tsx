// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectionsList, DesktopClaudePlanCredential } from '@rerun/contracts'
import { createHmac } from 'node:crypto'
import { createDesktopClaudePlanAuth, type ClaudeAuthPorts } from '../../../../engine/src/desktop/claude-plan/auth'
import { GET, POST } from '@/app/api/desktop/claude-login/route'
import { DesktopSettings } from '../DesktopSettings'
import { DesktopModelSelector } from '../DesktopModelSelector'
import { buildDesktopModelView } from '@/lib/desktop/chat-model'

const transport = vi.hoisted(() => ({ runtime: {} as any, engine: vi.fn(), providers: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/desktop/server/runtime', () => ({ readDesktopRuntime: async () => transport.runtime }))
vi.mock('@/lib/engine/client', () => ({ request: (...args: unknown[]) => transport.engine(...args) }))
vi.mock('@/lib/desktop/server/settings', () => ({ engineOf: () => transport.runtime.engine, readDesktopProviders: () => transport.providers() }))
vi.mock('@/components/connections/plan-connect/ForemanTrack', () => ({ ForemanTrack: ({ steps }: { steps: { title: string; body?: React.ReactNode }[] }) => <ol>{steps.map((step, index) => <li key={index}>{step.title}{step.body}</li>)}</ol> }))
vi.mock('@rerun/ui/foreman', () => ({ Orb: () => null }))
const originalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage')
let root: Root | null = null
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = ''; if (originalStorage) Object.defineProperty(window, 'localStorage', originalStorage); else Reflect.deleteProperty(window, 'localStorage') })

it('drives Settings through real Claude route/auth, retains singleton/model, cancels reconnect and ignores stale completion before one synthetic reply', async () => {
    const origin = 'http://127.0.0.1:43123', sessionToken = 'synthetic-session-token-for-offline-fixture-only'
    transport.runtime = { protocolVersion: 1, workspaceId: 1, launchNonce: 'fixture-a', buildId: 'fixture', dataRoot: '/unused-offline-fixture', app: { origin, sessionToken }, engine: { origin: 'http://127.0.0.1:43124', apiKey: 'synthetic-unused' } }
    let saved: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-rejected-access', RERUN_CLAUDE_CREDENTIAL_REVISION: '1' }, rejected = true, tail = Promise.resolve()
    const selected = { connectionId: 'mac-claude', model: 'claude-opus-5-5' }
    const journal = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: (key: string) => journal.get(key) ?? null, setItem: (key: string, value: string) => journal.set(key, value), removeItem: (key: string) => journal.delete(key) } })
    let finish!: (value: DesktopClaudePlanCredential) => void, entered!: () => void
    const exchangeEntered = new Promise<void>(resolve => { entered = resolve })
    let hold = true
    const exchange = vi.fn(async (): Promise<DesktopClaudePlanCredential> => {
        if (hold) { entered(); return new Promise(resolve => { finish = resolve }) }
        return { accessToken: 'synthetic-fresh-access' }
    })
    const ports: ClaudeAuthPorts = { read: async () => ({ ...saved }), write: async value => { saved = { ...value } }, lock: work => { const pending = tail.then(work); tail = pending.then(() => {}, () => {}); return pending }, exchange, fingerprint: value => createHmac('sha256', 'synthetic-fixture').update(value).digest('hex'), available: () => true, now: () => 1000, launchNonce: 'fixture-a', beforeCredentialChange: vi.fn(async () => {}), changed: async () => { rejected = false } }
    let auth = createDesktopClaudePlanAuth(ports)
    const providers = (): ConnectionsList => ({ connections: [{ id: 'mac-claude', provider: 'claude', name: 'Claude', connected: !!saved.CLAUDE_CODE_OAUTH_TOKEN, credentialRejected: rejected, models: [selected.model], extraModels: [], createdAt: '2026-11-09T00:00:00.000Z', planLimits: null }], default: { ...selected } })
    transport.providers.mockImplementation(async () => providers())
    transport.engine.mockImplementation(async (_engine, path, init, parse) => {
        expect(path).toBe('/desktop/claude-login')
        return parse(init.method === 'POST' ? await auth.action(JSON.parse(init.body), init.signal) : await auth.status())
    })
    const calls: { path: string; method: string }[] = [], replies: string[] = []
    const statuses: number[] = []
    function localRequest(path: string, init: RequestInit = {}, authenticated = true) {
        const request = new Request(origin + path, init)
        // Happy DOM applies browser restrictions to Host and Cookie. This is the server's inbound request.
        const headers = new Headers(init.headers)
        headers.set('host', new URL(origin).host)
        headers.set('origin', origin)
        if (authenticated) headers.set('cookie', `rerun-desktop-session=${sessionToken}`)
        Object.defineProperty(request, 'headers', { value: headers })
        return request
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
        const path = new URL(url, origin).pathname
        calls.push({ path, method: init.method ?? 'GET' })
        if (path === '/api/desktop/claude-login') {
            const request = localRequest(path, init)
            const response = await (init.method === 'POST' ? POST(request) : GET(request))
            statuses.push(response.status)
            return response
        }
        if (path === '/api/desktop/agents/fixture/model') return Response.json(buildDesktopModelView({ connections: providers().connections, workspace: providers().default, coworker: null, conversation: selected }))
        if (path === '/fixture/synthetic-reply') {
            if (rejected || !saved.CLAUDE_CODE_OAUTH_TOKEN) return new Response('not eligible', { status: 409 })
            replies.push('Synthetic reply — no provider was called')
            return Response.json({ text: replies.at(-1) })
        }
        throw new Error(`Unexpected offline request: ${path}`)
    }))
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null)
    function MountedSettings() {
        const [list, setList] = useState(providers()), [ready, setReady] = useState(false), [reply, setReply] = useState('')
        return <><DesktopSettings providers={list} workspaceName="Offline fixture" onProviders={setList} onSave={async () => { throw new Error('This fixture does not change models/defaults') }} />
            <DesktopModelSelector key={`${list.connections[0]?.credentialRejected}:${saved.RERUN_CLAUDE_CREDENTIAL_REVISION}`} agentId="fixture" sessionId={null} onReady={setReady} />
            <button disabled={!ready} onClick={() => { void fetch('/fixture/synthetic-reply', { method: 'POST' }).then(response => response.json()).then(value => setReply(value.text)) }}>Send synthetic reply</button><output>{reply}</output></>
    }
    async function mount() { root = createRoot(document.body.appendChild(document.createElement('div'))); await act(async () => root!.render(<MountedSettings />)) }
    const button = (label: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === label)!
    async function click(label: string) { await act(async () => { button(label).click() }) }
    async function paste(code: string) {
        const input = document.querySelector<HTMLInputElement>('input[placeholder="Code from Claude"]')!
        const event = new Event('paste', { bubbles: true }); Object.defineProperty(event, 'clipboardData', { value: { getData: () => code } })
        await act(async () => { input.dispatchEvent(event) })
    }
    try {
        await mount()
        await vi.waitFor(() => expect(button('Open Claude again')).toBeTruthy())
        expect(button('Open Claude again').disabled).toBe(false) // Parent negative control: saved rejected credential disabled this.
        expect(button('Send synthetic reply').disabled).toBe(true)
        await click('Open Claude again')
        await vi.waitFor(() => expect(opened, `Mounted route statuses: ${statuses.join(', ')}`).toHaveBeenCalledTimes(1))
        const old = await auth.status()
        await paste('synthetic-delayed-code'); await exchangeEntered
        await click('Cancel sign-in')
        expect(saved.CLAUDE_CODE_OAUTH_TOKEN).toBe('synthetic-rejected-access')
        finish({ accessToken: 'synthetic-stale-access' })
        await act(async () => {})
        expect(saved.CLAUDE_CODE_OAUTH_TOKEN).toBe('synthetic-rejected-access')
        hold = false
        await click('Open Claude again')
        expect((await auth.status()).attemptId).not.toBe(old.attemptId)
        await paste('synthetic-fresh-code')
        await vi.waitFor(() => expect(document.body.textContent).toContain('Claude is connected.'))
        expect(providers().connections.map(item => item.id)).toEqual(['mac-claude'])
        expect(providers().default).toMatchObject(selected)
        expect([...journal.values()].join('')).not.toContain('synthetic-fresh-code')
        await vi.waitFor(() => expect(button('Send synthetic reply').disabled).toBe(false))
        await click('Send synthetic reply')
        expect(replies).toHaveLength(1)
        await act(async () => root!.unmount()); root = null
        auth.stop(); auth = createDesktopClaudePlanAuth({ ...ports, launchNonce: 'fixture-b' })
        const before = calls.length
        await fetch('/api/desktop/claude-login')
        await mount()
        await vi.waitFor(() => expect(document.body.textContent).toContain('Claude is connected.'))
        expect(calls.slice(before).filter(call => call.path === '/api/desktop/claude-login').every(call => call.method === 'GET')).toBe(true)
        expect(providers().default).toMatchObject(selected)
        expect(exchange).toHaveBeenCalledTimes(2)
        expect(replies).toHaveLength(1)
        // Real route authentication is kept in this fixture; wrong session cannot query auth.
        expect((await GET(localRequest('/api/desktop/claude-login', {}, false))).status).toBe(401)
    } finally { finish?.({ accessToken: 'synthetic-late-cleanup' }); auth.stop() }
})
