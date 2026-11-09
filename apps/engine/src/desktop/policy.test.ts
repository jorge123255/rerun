import { afterEach, expect, test, vi } from 'vitest'
import { assertDesktopProvider, desktopRouteAllowed } from './policy.js'

afterEach(() => vi.unstubAllEnvs())

test('named API management and Foreman permission routes admit only exact intended methods', () => {
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
    for (const path of ['/desktop/api-connections/catalog', '/desktop/api-connections/removal']) {
        for (const method of methods) expect(desktopRouteAllowed(method, path)).toBe(method === 'GET')
    }
    for (const action of ['create', 'rename', 'models', 'credential', 'remove']) {
        for (const method of methods) expect(desktopRouteAllowed(method, `/desktop/api-connections/${action}`)).toBe(method === 'POST')
    }
    for (const path of ['/desktop/api-connections', '/desktop/api-connections/select', '/desktop/api-connections/create/more', '/desktop/api-connections/receipt']) {
        for (const method of methods) expect(desktopRouteAllowed(method, path)).toBe(false)
    }
    for (const method of methods) expect(desktopRouteAllowed(method, '/desktop/foreman/file-permissions')).toBe(method === 'GET' || method === 'PATCH')
    for (const method of methods) expect(desktopRouteAllowed(method, '/desktop/foreman/file-permissions/more')).toBe(false)
})

test('generic connection mutations cannot bypass named API receipts through raw, case or encoded aliases', () => {
    for (const id of ['cnx_fixture-target', 'CNX_FIXTURE-TARGET', '%63nx_fixture-target', 'cnx%5ffixture-target', 'cnx_fixture%2dtarget']) {
        for (const method of ['PATCH', 'DELETE']) for (const suffix of ['', '/keys']) {
            expect(desktopRouteAllowed(method, `/connections/${id}${suffix}`)).toBe(false)
        }
    }
    for (const id of ['legacy-openai', 'mac-chatgpt', 'mac-claude']) {
        expect(desktopRouteAllowed('PATCH', `/connections/${id}`)).toBe(true)
        expect(desktopRouteAllowed('PATCH', `/connections/${id}/keys`)).toBe(true)
    }
    expect(desktopRouteAllowed('PUT', '/connections/default')).toBe(true)
})

test('desktop Foreman authority can read its details without opening mutation or hosted routes', () => {
    expect(desktopRouteAllowed('GET', '/agents/foreman')).toBe(true)
    for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(desktopRouteAllowed(method, '/agents/foreman')).toBe(false)
    }
    for (const path of ['/agents/foreman/', '/agents/foreman/keys', '/agents/foreman/memories', '/agents/foreman/tools']) {
        expect(desktopRouteAllowed('GET', path)).toBe(false)
    }
    expect(desktopRouteAllowed('POST', '/agents/foreman/chat')).toBe(false)
})

test('Claude requires its dedicated connection and both isolated bundled runtime paths', () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    vi.stubEnv('RERUN_DESKTOP_CLAUDE_RUNNER', '')
    vi.stubEnv('RERUN_DESKTOP_CLAUDE_SANDBOX', '')
    expect(() => assertDesktopProvider('claude', 'mac-claude')).toThrow()
    expect(desktopRouteAllowed('GET', '/desktop/claude-login')).toBe(false)
    vi.stubEnv('RERUN_DESKTOP_CLAUDE_RUNNER', '/bundle/claude')
    expect(() => assertDesktopProvider('claude', 'mac-claude')).toThrow()
    vi.stubEnv('RERUN_DESKTOP_CLAUDE_SANDBOX', '/bundle/claude.sb')
    expect(() => assertDesktopProvider('claude', 'mac-claude')).not.toThrow()
    expect(() => assertDesktopProvider('claude', 'legacy-claude')).toThrow()
    for (const method of ['GET', 'POST']) expect(desktopRouteAllowed(method, '/desktop/claude-login')).toBe(true)
    for (const method of ['PUT', 'PATCH', 'DELETE']) expect(desktopRouteAllowed(method, '/desktop/claude-login')).toBe(false)
    expect(desktopRouteAllowed('POST', '/desktop/claude-login/complete')).toBe(false)
})

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

test('credential source reads are available only at the owned session POST boundary', () => {
    expect(desktopRouteAllowed('POST', '/agents/owner/sessions/chat/secret-request-source')).toBe(true)
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) expect(desktopRouteAllowed(method, '/agents/owner/sessions/chat/secret-request-source')).toBe(false)
    expect(desktopRouteAllowed('POST', '/agents/owner/secret-request-source')).toBe(false)
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
        ['/agents/a/schedules/describe', ['GET', 'POST', 'PATCH', 'DELETE']],
        ['/agents/a/schedules/morning/run', ['POST']],
    ] as const) for (const method of methods) expect(desktopRouteAllowed(method, path)).toBe((allowed as readonly string[]).includes(method))
    for (const path of ['/agents/foreman/schedules', '/agents/foreman/schedules/describe', '/agents/a/schedules/../other', '/agents/a/schedules/morning/run/more', '/agents/a%2Fb/schedules', '/schedules']) {
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


test('MCP sign-in source lookup is only the owned-session POST boundary', () => {
    expect(desktopRouteAllowed('POST', '/agents/owner/sessions/chat/mcp-sign-in-source')).toBe(true)
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) expect(desktopRouteAllowed(method, '/agents/owner/sessions/chat/mcp-sign-in-source')).toBe(false)
    for (const path of ['/agents/foreman/sessions/chat/mcp-sign-in-source', '/agents/owner/mcp-sign-in-source', '/agents/owner/sessions/chat/mcp-sign-in-source/more']) expect(desktopRouteAllowed('POST', path)).toBe(false)
})


test('computer panel permits only authenticated control dispatch at its exact boundary', () => {
    expect(desktopRouteAllowed('POST', '/desktop/computer-panel/control')).toBe(true)
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) expect(desktopRouteAllowed(method, '/desktop/computer-panel/control')).toBe(false)
    for (const path of ['/desktop/computer-panel', '/desktop/computer-panel/control/more', '/desktop/computer-panel/launch']) expect(desktopRouteAllowed('POST', path)).toBe(false)
})


test('admits the exact company shutdown route without exposing arbitrary workspace actions', () => {
    expect(desktopRouteAllowed('POST', '/desktop/company-brief/cancel-chat')).toBe(true)
    expect(desktopRouteAllowed('GET', '/desktop/company-brief/cancel-chat')).toBe(false)
    expect(desktopRouteAllowed('POST', '/desktop/company-brief/handoff-receipt')).toBe(true)
    expect(desktopRouteAllowed('GET', '/desktop/company-brief/handoff-receipt')).toBe(false)
    expect(desktopRouteAllowed('POST', '/desktop/company-brief/erase')).toBe(false)
    expect(desktopRouteAllowed('POST', '/desktop/workspace-admission')).toBe(true)
    expect(desktopRouteAllowed('GET', '/desktop/workspace-admission')).toBe(false)
})


test('desktop Foreman questions and logical database capture expose only their exact authenticated routes', () => {
    for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
        expect(desktopRouteAllowed(method, '/desktop/foreman/question')).toBe(method === 'GET')
        expect(desktopRouteAllowed(method, '/desktop/coworker-share-database/capture')).toBe(method === 'POST')
        expect(desktopRouteAllowed(method, '/desktop/foreman/question/arbitrary')).toBe(false)
        expect(desktopRouteAllowed(method, '/desktop/coworker-share-database/capture/arbitrary')).toBe(false)
    }
})
