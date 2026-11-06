import { afterEach, expect, test, vi } from 'vitest'
import { desktopMcpSignInAction, readDesktopMcpSignIn } from '@/lib/desktop/mcp-sign-in-client'
import type { DesktopMcpSignInDecision } from '../../../../../../packages/contracts/src/desktop-mcp-sign-in'

const decision: DesktopMcpSignInDecision = {
    operation: 'connect', requestId: 'request', attemptId: 'attempt', expectedRevision: 'revision',
    source: { agentId: 'agent', sessionId: 'chat', runId: 'run', sourceMessageId: 'message', toolCallId: 'tool', fingerprint: 'fingerprint', server: { name: 'linear', revision: 'revision-1', url: 'https://linear.example/mcp', displayName: 'Linear', host: 'linear.example', icon: null } },
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('GET reads the canonical no-store session projection', async () => {
    const fetcher = vi.fn(async () => Response.json({ request: null }))
    vi.stubGlobal('fetch', fetcher)
    await expect(readDesktopMcpSignIn('chat')).resolves.toEqual({ request: null })
    expect(fetcher).toHaveBeenCalledWith('/api/desktop/sessions/chat/mcp-sign-in', { cache: 'no-store', signal: undefined })
})

test('decision envelope and exact acknowledgement are required', async () => {
    const response = new Response('data: [DONE]\n\n', { headers: { 'x-mcp-sign-in-request-id': 'request', 'x-session-id': 'chat', 'x-run-id': 'continuation' } })
    const fetcher = vi.fn(async () => response)
    vi.stubGlobal('fetch', fetcher)
    await expect(desktopMcpSignInAction('chat', 'complete', decision)).resolves.toEqual({ kind: 'continuation', response })
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ action: 'complete', request: decision })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: [DONE]\n\n', { headers: { 'x-mcp-sign-in-request-id': 'other', 'x-session-id': 'chat', 'x-run-id': 'continuation' } })))
    await expect(desktopMcpSignInAction('chat', 'complete', decision)).rejects.toThrow('another request')
})
