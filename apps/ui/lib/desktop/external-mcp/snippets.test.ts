import { describe, expect, it } from 'vitest'
import type { ExternalMcpListenerView } from '@rerun/contracts'
import { externalMcpClientSnippets, externalMcpEndpoint } from './snippets'

const listener = (enabled: boolean, origin = 'http://127.0.0.1:43123'): ExternalMcpListenerView => ({ version: 1, enabled, origin: enabled ? origin : null, path: '/mcp', workspaceId: 1, installId: '123e4567-e89b-42d3-a456-426614174000', launchNonce: '123e4567-e89b-42d3-a456-426614174001' })

describe('loopback external-client snippets', () => {
    it('uses only the configured listener origin plus /mcp', () => {
        expect(externalMcpEndpoint(listener(true))).toBe('http://127.0.0.1:43123/mcp')
        expect(externalMcpEndpoint(listener(false))).toBeNull()
        expect(externalMcpEndpoint(listener(true, 'https://rerun.build'))).toBeNull()
        expect(externalMcpEndpoint(listener(true, 'http://127.0.0.1:43123/engine'))).toBeNull()
    })

    it('preserves the original client commands and Bearer placeholder', () => {
        expect(externalMcpClientSnippets('claude-code', 'http://127.0.0.1:43123/mcp', 'rk_your_key')).toEqual([{ label: 'Terminal', value: 'claude mcp add --transport http rerun http://127.0.0.1:43123/mcp --header "Authorization: Bearer rk_your_key"' }])
        expect(externalMcpClientSnippets('chatgpt', 'http://127.0.0.1:43123/mcp', 'rk_secret')[0]).toEqual({ label: 'Shell profile', value: 'export RERUN_MCP_KEY="rk_secret"' })
        expect(externalMcpClientSnippets('other', 'http://127.0.0.1:43123/mcp', 'rk_secret').map(snippet => snippet.label)).toEqual(['Server URL', 'Header', 'Clients that only speak stdio'])
    })

    it('never substitutes an engine or public URL', () => {
        for (const client of ['claude-code', 'chatgpt', 'cursor', 'rerun', 'other'] as const) {
            const text = externalMcpClientSnippets(client, 'http://127.0.0.1:43123/mcp', 'rk_secret').map(snippet => snippet.value).join('\n')
            expect(text).not.toContain('/api/mcp/account')
            expect(text).not.toContain('https://')
            expect(text).toContain('rk_secret')
        }
    })
})
