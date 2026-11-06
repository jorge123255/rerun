import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ config: { enabled: true, ephemeral: false, tools: { desktopToolGrants: { computer: true, terminalLaunch: true } } }, current: { sessionId: 'session', runId: 'run', kind: 'computer', site: null }, status: vi.fn(), run: vi.fn(), ledger: vi.fn() }))
vi.mock('../../agents/loader.js', () => ({ readAgentConfig: async () => structuredClone(state.config) }))
vi.mock('../../db/repos/runs.js', () => ({ getRun: (...args: unknown[]) => state.run(...args) }))
vi.mock('../../db/repos/sessions.js', () => ({ getSession: async () => ({ id: 'session', agentId: 'agent' }) }))
vi.mock('../../db/client.js', () => ({ raw: () => ({ execute: (...args: unknown[]) => state.ledger(...args) }) }))
vi.mock('../agent-lifecycle.js', () => ({ desktopDeletionActive: () => false, beginDesktopAgentWork: () => () => {} }))
vi.mock('../setup/service.js', () => ({ readDesktopSetup: async () => ({ pending: false }) }))
vi.mock('../tool-grants.js', () => ({ hasDesktopToolGrant: (config: typeof state.config, id: keyof typeof state.config.tools.desktopToolGrants) => config.enabled && config.tools.desktopToolGrants[id] === true }))
vi.mock('../isolated-screen/binding.js', () => ({ isolatedScreenOwner: () => ({ engineAgentId: 'agent', launchNonce: 'launch' }), isolatedScreenSignal: (_id: string, signal: AbortSignal) => signal }))
vi.mock('../isolated-screen/run-owner.js', () => ({ currentScreenRun: () => state.current }))
vi.mock('../isolated-screen/index.js', () => ({ service: () => ({ status: (...args: unknown[]) => state.status(...args), running: async () => ({ target: { engineAgentId: 'agent', launchNonce: 'launch', sessionGeneration: 'a'.repeat(32) } }) }) }))
vi.mock('../computer-launchers/sqlite-store.js', () => ({ computerLauncherStore: () => ({}) }))
import { bindDesktopComputerPanel } from './binding.js'
const read = () => bindDesktopComputerPanel({ launchNonce: 'launch' }).routes.request('/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'read', launchNonce: 'launch', source: { agentId: 'agent', sessionId: 'session' } }) })
beforeEach(() => { state.config.enabled = true; state.config.tools.desktopToolGrants.terminalLaunch = true; state.current = { sessionId: 'session', runId: 'run', kind: 'computer', site: null }; state.status.mockReset().mockResolvedValue({ state: 'running', launchers: { terminal: true, files: true } }); state.run.mockReset().mockResolvedValue({ id: 'run', sessionId: 'session', status: 'running' }); state.ledger.mockReset().mockResolvedValue({ rows: [] }) })
it('rereads permission after a native status read before publishing controls', async () => {
    state.status.mockImplementationOnce(async () => { state.config.tools.desktopToolGrants.terminalLaunch = false; return { state: 'running' } })
    const response = await read(); expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ grants: { terminalLaunch: false } })
})
it('refuses a run replaced during the durable run lookup', async () => {
    state.run.mockImplementationOnce(async () => { state.current = { ...state.current, runId: 'replacement' }; return { id: 'run', sessionId: 'session', status: 'running' } })
    expect((await read()).status).toBe(409)
})
it('refuses a run replaced while recovering launcher receipts', async () => {
    state.ledger.mockImplementationOnce(async () => { state.current = { ...state.current, runId: 'replacement' }; return { rows: [] } })
    expect((await read()).status).toBe(409)
})
