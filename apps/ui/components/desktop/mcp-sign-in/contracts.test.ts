import { expect, test } from 'vitest'
import {
    desktopMcpSignInDecisionSchema,
    desktopMcpSignInRequestInputSchema,
    desktopMcpSignInViewSchema,
    serializeDesktopMcpSignInResult,
} from '../../../../../packages/contracts/src/desktop-mcp-sign-in'

const source = {
    agentId: 'agent', sessionId: 'chat', runId: 'run', sourceMessageId: 'message', toolCallId: 'tool', fingerprint: 'fingerprint',
    server: { name: 'linear', revision: 'revision-1', url: 'https://linear.example/mcp', displayName: 'Linear', host: 'linear.example', icon: null },
}

test('model input contains a registered name and optional reason only, never a credential destination', () => {
    expect(desktopMcpSignInRequestInputSchema.parse({ name: 'linear', reason: 'Use Linear issues.' })).toEqual({ name: 'linear', reason: 'Use Linear issues.' })
    expect(desktopMcpSignInRequestInputSchema.safeParse({ name: 'linear', url: 'https://attacker.example' }).success).toBe(false)
    expect(desktopMcpSignInRequestInputSchema.safeParse({ name: 'linear', authorizationUrl: 'https://attacker.example' }).success).toBe(false)
})

test('view binds exact server generation and contains no OAuth token or arbitrary model URL', () => {
    const view = { requestId: 'request', revision: 'revision', source, reason: 'Connect Linear.', status: 'pending', createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z' }
    expect(desktopMcpSignInViewSchema.parse(view)).toEqual(view)
    expect(desktopMcpSignInViewSchema.safeParse({ ...view, accessToken: 'dummy-token' }).success).toBe(false)
    expect(desktopMcpSignInDecisionSchema.safeParse({ operation: 'connect', requestId: 'request', attemptId: 'attempt', expectedRevision: 'revision', source, authorizationUrl: 'https://attacker.example' }).success).toBe(false)
})

test('connected and declined summaries preserve original names-only continuation text', () => {
    expect(serializeDesktopMcpSignInResult('linear', 'connected')).toBe('MCP sign-in result:\n- linear: connected\n\nIts tools are available now. Please continue.')
    expect(serializeDesktopMcpSignInResult('linear', 'declined')).toBe('[User skipped signing in to the MCP server]')
})
