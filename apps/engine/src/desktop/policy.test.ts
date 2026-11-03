import { afterEach, expect, test, vi } from 'vitest'
import { assertDesktopProvider, desktopRouteAllowed } from './policy.js'

afterEach(() => vi.unstubAllEnvs())

test('desktop runtime rejects CLI and cloud-fallback models, even when the agent selects them', () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    for (const provider of ['claude', 'codex', 'rerun']) expect(() => assertDesktopProvider(provider)).toThrow('API providers only')
    for (const provider of ['openai', 'anthropic', 'google', 'openrouter']) expect(() => assertDesktopProvider(provider)).not.toThrow()
})

test('desktop HTTP scope permits chat/history but denies filesystem, updater, MCP, reset and automation paths', () => {
    expect(desktopRouteAllowed('POST', '/agents/example-agent/chat')).toBe(true)
    expect(desktopRouteAllowed('GET', '/agents/example-agent/sessions/example-session/messages')).toBe(true)
    for (const path of ['/update', '/tools', '/shared/files', '/agents/a/files', '/agents/import', '/agents/a/automations/activate', '/agents/a/mcp-servers', '/agents/a/schedules', '/agents/a/triggers', '/desktop']) {
        for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) expect(desktopRouteAllowed(method, path)).toBe(false)
    }
    expect(desktopRouteAllowed('DELETE', '/agents/a')).toBe(false)
})
