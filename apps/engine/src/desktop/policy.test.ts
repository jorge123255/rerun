import { afterEach, expect, test, vi } from 'vitest'
import { assertDesktopProvider, desktopRouteAllowed } from './policy.js'

afterEach(() => vi.unstubAllEnvs())

test('desktop runtime rejects CLI and cloud-fallback models, even when the agent selects them', () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    for (const provider of ['claude', 'codex', 'rerun']) expect(() => assertDesktopProvider(provider)).toThrow('unavailable')
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

test('Codex requires the bundled runner and the dedicated desktop connection', () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    vi.stubEnv('RERUN_DESKTOP_CODEX_RUNNER', '')
    expect(() => assertDesktopProvider('codex', 'mac-chatgpt')).toThrow()
    vi.stubEnv('RERUN_DESKTOP_CODEX_RUNNER', '/bundle/rerun-codex')
    expect(() => assertDesktopProvider('codex', 'mac-chatgpt')).not.toThrow()
    expect(() => assertDesktopProvider('codex', 'legacy-id')).toThrow()
    expect(() => assertDesktopProvider('claude', 'mac-chatgpt')).toThrow()
    expect(desktopRouteAllowed('GET', '/desktop/codex-login')).toBe(true)
    expect(desktopRouteAllowed('DELETE', '/desktop/codex-login')).toBe(false)
})

test('desktop memories are scoped to listing a single coworker', () => {
    const list = '/agents/memory-agent/memories'
    expect(desktopRouteAllowed('GET', list)).toBe(true)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(desktopRouteAllowed(method, list)).toBe(false)
    for (const path of [`${list}/recall`, `${list}/memory-id`, '/agents/foreman/memories', '/agents/../memories', '/agents/a%2Fb/memories']) {
        for (const method of ['GET', 'POST', 'DELETE']) expect(desktopRouteAllowed(method, path)).toBe(false)
    }
})
