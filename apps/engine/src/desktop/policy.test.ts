import { afterEach, expect, test, vi } from 'vitest'
import { assertDesktopProvider, desktopRouteAllowed } from './policy.js'

afterEach(() => vi.unstubAllEnvs())

test('desktop database browser routes allow exact operations in each scope and never raw SQL', () => {
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
    for (const prefix of ['/agents/a/data', '/shared/data']) {
        const routes: [string, string[]][] = [
            ['/tables', ['GET']], ['/tables/notes', ['DELETE']], ['/tables/notes/rows', ['GET', 'DELETE']],
            ['/tables/notes/rows/1', ['PATCH']], ['/tables/notes/views', ['GET', 'POST']],
            ['/tables/notes/views/view-id', ['PUT', 'DELETE']], ['/tables/notes/groups', ['GET']],
            ['/tables/notes/export', ['GET']], ['/tables/notes/purge', ['POST']],
        ]
        for (const [route, allowed] of routes) for (const method of methods)
            expect(desktopRouteAllowed(method, prefix + route), `${method} ${prefix + route}`).toBe(allowed.includes(method))
        for (const path of ['/query', '/execute', '/tables/notes/more', '/tables/notes/rows/1/more'])
            for (const method of methods) expect(desktopRouteAllowed(method, prefix + path)).toBe(false)
    }
    for (const method of methods) expect(desktopRouteAllowed(method, '/agents/foreman/data/tables')).toBe(false)
})

test('desktop runtime rejects CLI and cloud-fallback models, even when the agent selects them', () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    for (const provider of ['claude', 'codex', 'rerun']) expect(() => assertDesktopProvider(provider)).toThrow('unavailable')
    for (const provider of ['openai', 'anthropic', 'google', 'openrouter']) expect(() => assertDesktopProvider(provider)).not.toThrow()
})

test('desktop HTTP scope permits chat/history but denies filesystem, updater, MCP, reset and automation paths', () => {
    expect(desktopRouteAllowed('POST', '/agents/example-agent/chat')).toBe(true)
    expect(desktopRouteAllowed('GET', '/agents/example-agent/sessions/example-session/messages')).toBe(true)
    for (const path of ['/update', '/tools', '/shared/files', '/agents/a/files', '/agents/import', '/agents/a/automations/activate', '/agents/a/mcp-servers', '/agents/a/triggers', '/desktop']) {
        for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) expect(desktopRouteAllowed(method, path)).toBe(false)
    }
    expect(desktopRouteAllowed('DELETE', '/agents/a')).toBe(true)
    for (const path of ['/agents', '/agents/foreman', '/agents/a/more', '/agents/a%2Fb', '/agents/..']) expect(desktopRouteAllowed('DELETE', path)).toBe(false)
})

test('app suggestions use the existing chat continuation without opening hosted installers or secret APIs', () => {
    expect(desktopRouteAllowed('POST', '/agents/coworker/chat')).toBe(true)
    for (const path of ['/hub/services', '/agents/coworker/services', '/agents/coworker/secrets', '/agents/coworker/env', '/agents/coworker/service-requests']) {
        for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) expect(desktopRouteAllowed(method, path)).toBe(false)
    }
})

test('desktop Routines allow only the bounded coworker schedule routes', () => {
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
    for (const [path, allowed] of [
        ['/agents/a/schedules', ['GET', 'POST']],
        ['/agents/a/schedules/morning', ['GET', 'PATCH', 'DELETE']],
        ['/agents/a/schedules/morning/run', ['POST']],
    ] as const) for (const method of methods) expect(desktopRouteAllowed(method, path)).toBe((allowed as readonly string[]).includes(method))
    for (const path of ['/agents/foreman/schedules', '/agents/a/schedules/../other', '/agents/a/schedules/morning/run/more', '/agents/a%2Fb/schedules', '/schedules']) {
        for (const method of methods) expect(desktopRouteAllowed(method, path)).toBe(false)
    }
})

test('desktop Skills permits proposal reads and exact review decisions, but never hosted skill writes', () => {
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
    for (const [path, allowed] of [
        ['/agents/owner/skill-proposals', ['GET']],
        ['/agents/owner/skill-proposals/proposal-id/accept', ['POST']],
        ['/agents/owner/skill-proposals/proposal-id/dismiss', ['POST']],
    ] as const) for (const method of methods) expect(desktopRouteAllowed(method, path), `${method} ${path}`).toBe((allowed as readonly string[]).includes(method))
    for (const path of [
        '/agents/foreman/skill-proposals', '/agents/a%2Fb/skill-proposals', '/skill-proposals',
        '/agents/owner/skill-proposals/proposal-id', '/agents/owner/skill-proposals/proposal-id/accept/more',
        '/agents/owner/skill-proposals/../accept', '/agents/owner/skills', '/agents/owner/skills/qa-review',
    ]) for (const method of methods) expect(desktopRouteAllowed(method, path)).toBe(false)
})

test('run details permit only the existing authenticated step and tool reads', () => {
    for (const path of ['/agents/a/runs/r', '/agents/a/runs/r/steps', '/agents/a/runs/r/tools']) {
        expect(desktopRouteAllowed('GET', path)).toBe(true)
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(desktopRouteAllowed(method, path)).toBe(false)
    }
    for (const path of ['/agents/a/runs/r/output', '/agents/a/runs/r/tools/more', '/agents/a/runs/r/steps/1', '/agents/foreman/runs/r/tools', '/agents/a/runs/..%2fr/tools'])
        expect(desktopRouteAllowed('GET', path)).toBe(false)
    expect(desktopRouteAllowed('GET', '/agents/a/stats')).toBe(true)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(desktopRouteAllowed(method, '/agents/a/stats')).toBe(false)
    for (const path of ['/agents/foreman/stats', '/agents/a/stats/more']) expect(desktopRouteAllowed('GET', path)).toBe(false)
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

test('desktop memories are scoped to recall, listing, creating, deleting one note and clearing all notes', () => {
    const list = '/agents/memory-agent/memories'
    expect(desktopRouteAllowed('GET', list)).toBe(true)
    expect(desktopRouteAllowed('POST', list)).toBe(true)
    expect(desktopRouteAllowed('DELETE', `${list}/memory-id`)).toBe(true)
    expect(desktopRouteAllowed('DELETE', list)).toBe(true)
    for (const method of ['PUT', 'PATCH']) expect(desktopRouteAllowed(method, list)).toBe(false)
    expect(desktopRouteAllowed('POST', `${list}/recall`)).toBe(true)
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) expect(desktopRouteAllowed(method, `${list}/recall`)).toBe(false)
    for (const path of ['/agents/foreman/memories/recall', '/agents/foreman/memories', '/agents/../memories', '/agents/a%2Fb/memories', `${list}/..%2fother`]) {
        for (const method of ['GET', 'POST', 'DELETE']) expect(desktopRouteAllowed(method, path)).toBe(false)
    }
})

test('desktop duplication only allows POST on the selected coworker', () => {
    expect(desktopRouteAllowed('POST', '/agents/a/duplicate')).toBe(true)
    for (const method of ['GET', 'PATCH', 'PUT', 'DELETE']) expect(desktopRouteAllowed(method, '/agents/a/duplicate')).toBe(false)
    for (const path of ['/agents/foreman/duplicate', '/agents/a/duplicate/more']) expect(desktopRouteAllowed('POST', path)).toBe(false)
})
