// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopMcpSignInOAuthView, DesktopMcpSignInView } from '../../../../../packages/contracts/src/desktop-mcp-sign-in'
import { DesktopMcpSignInBlock } from './DesktopMcpSignInBlock'

vi.mock('@rerun/ui', () => ({ BorderBeam: () => null }))
const roots: Root[] = []
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
    vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers()
})

const request: DesktopMcpSignInView = {
    requestId: 'request', revision: 'revision',
    source: { agentId: 'agent', sessionId: 'chat', runId: 'run', sourceMessageId: 'message', toolCallId: 'tool', fingerprint: 'fingerprint', server: { name: 'linear', revision: 'revision-1', url: 'https://linear.example/mcp', displayName: 'Linear', host: 'linear.example', icon: null } },
    reason: 'Use Linear issues.', status: 'pending', createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
}
const response = (body: unknown) => Response.json(body)
const acknowledged = () => new Response('data: [DONE]\n\n', { headers: { 'x-mcp-sign-in-request-id': 'request', 'x-run-id': 'continuation', 'x-session-id': 'chat' } })

async function mount(view = request, onAccepted = vi.fn(), initialOAuth?: DesktopMcpSignInOAuthView) {
    const root = createRoot(document.body.appendChild(document.createElement('div'))); roots.push(root)
    await act(async () => root.render(<DesktopMcpSignInBlock sessionId="chat" request={view} onAccepted={onAccepted} initialOAuth={initialOAuth} />))
    return { root, onAccepted }
}
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)!
const click = async (label: string) => { await act(async () => { button(label).click() }) }

test('Connect opens only the adapter-returned HTTPS link and Cancel leaves the request unresolved', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        if (body.action === 'connect') return response({ request: { ...request, status: 'connecting' }, oauth: { state: 'waiting', authorizationUrl: 'https://auth.example/authorize?state=opaque' } })
        if (body.action === 'cancel') return response({ request, oauth: { state: 'idle' } })
        throw new Error('Unexpected action')
    })
    vi.stubGlobal('fetch', fetcher)
    const { onAccepted } = await mount()
    expect(fetcher).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Sign in to Linear')
    expect(document.body.textContent).toContain('Use Linear issues.')
    expect(document.body.textContent).toContain('Sign-in needed')
    await click('Connect')
    expect(document.querySelector('a')?.href).toBe('https://auth.example/authorize?state=opaque')
    await click('Cancel')
    expect(document.querySelector('a')).toBeNull()
    expect(document.body.textContent).toContain('Sign-in needed')
    expect(onAccepted).not.toHaveBeenCalled()
})

test('fresh connected readiness enables Continue and one acknowledged follow-up', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        if (body.action === 'connect') return response({ request: { ...request, status: 'connecting' }, oauth: { state: 'waiting', authorizationUrl: 'https://auth.example/authorize?state=opaque' } })
        if (body.action === 'status') return response({ request: { ...request, status: 'connecting' }, oauth: { state: 'connected' } })
        if (body.action === 'complete') return acknowledged()
        throw new Error('Unexpected action')
    })
    vi.stubGlobal('fetch', fetcher)
    const { onAccepted } = await mount()
    await click('Connect')
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(document.body.textContent).toContain('Connected')
    await click('Continue')
    expect(onAccepted).toHaveBeenCalledTimes(1)
})

test('Not now preserves original declined presentation and does not fabricate connection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => acknowledged()))
    const { onAccepted } = await mount()
    await click('Not now')
    expect(onAccepted).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).not.toContain('Connected · tools')
})

test('a restored sealed receipt retries its exact unacknowledged continuation', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({ action: 'recover', request: { requestId: 'request', attemptId: 'attempt' } })
        return acknowledged()
    })
    vi.stubGlobal('fetch', fetcher)
    const { onAccepted } = await mount({ ...request, status: 'connected', receipt: { attemptId: 'attempt', outcome: 'connected', summary: 'MCP sign-in result', continuationRequestId: 'continuation', accepted: false, createdAt: '2026-11-05T00:00:00.000Z' } })
    await click('Retry continuation')
    expect(onAccepted).toHaveBeenCalledTimes(1)
})

test('an invalid adapter link and provider failure remain honest and retryable', async () => {
    const fetcher = vi.fn(async () => response({ request: { ...request, status: 'error', error: 'Authorization failed. Retry.' }, oauth: { state: 'error', authorizationUrl: 'http://127.0.0.1/private' } }))
    vi.stubGlobal('fetch', fetcher)
    await mount()
    await click('Connect')
    expect(document.querySelector('a')).toBeNull()
    expect(document.body.textContent).toContain('Unreachable')
    expect(document.body.textContent).toContain('Authorization failed. Retry.')
    expect(button('Connect').disabled).toBe(false)
})

test('an interrupted browser attempt stays cancellable without showing a live wait', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({ action: 'cancel', request: { attemptId: 'interrupted-attempt' } })
        return response({ request: { ...request, revision: 'after-cancel' }, oauth: { state: 'idle' } })
    })
    vi.stubGlobal('fetch', fetcher)
    await mount({ ...request, status: 'connecting', activeAttemptId: 'interrupted-attempt' }, vi.fn(), {
        state: 'error', message: 'Browser sign-in was interrupted. Cancel this attempt to reconnect.',
    })
    expect(document.body.textContent).toContain('Browser sign-in was interrupted.')
    expect(button('Waiting for authorization…')).toBeUndefined()
    expect(button('Connect')).toBeUndefined()
    await click('Cancel')
    expect(button('Connect').disabled).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
})


test('accepted continuation transfers stream ownership across the card unmount', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => acknowledged()))
    let transferred: { signal: AbortSignal; cancelStream: () => void } | undefined
    const accepted = vi.fn((_response: Response, stream: { signal: AbortSignal; cancelStream: () => void }) => { transferred = stream })
    const { root } = await mount(request, accepted)
    await click('Not now')
    expect(accepted).toHaveBeenCalledOnce()
    await act(async () => root.render(null))
    expect(transferred?.signal.aborted).toBe(false)
    transferred?.cancelStream()
    expect(transferred?.signal.aborted).toBe(true)
})
