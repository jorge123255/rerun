import { agentConfigSchema, desktopRerunGrantsOf } from '@rerun/contracts'
import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ read: vi.fn(), deleting: false }))
vi.mock('../../agents/loader.js', () => ({ readAgentConfig: state.read }))
vi.mock('../agent-lifecycle.js', () => ({ desktopDeletionActive: () => state.deleting }))
import { authorizeScreenInput, screenGranted, screenPermissionsRevoked } from './permissions.js'
const config = (grants: Record<string, boolean>, extra = {}) => agentConfigSchema.parse({ name: 'Screen', tools: { shell: true, filesystem: true, desktopToolGrants: grants }, ...extra })
const target = { engineAgentId: 'owner', launchNonce: '11111111-1111-4111-8111-111111111111', sessionGeneration: 'a'.repeat(32) }
beforeEach(() => { state.read.mockReset(); state.deleting = false })
it('does not infer either launcher from native shell/files or computer alone', () => {
    expect(desktopRerunGrantsOf(config({ computer: true }).tools)).toMatchObject({ terminalLaunch: false, filesLaunch: false })
    expect(screenGranted(config({ computer: true }))).toBe(false)
    expect(screenGranted(config({ terminalLaunch: true }))).toBe(false)
    expect(screenGranted(config({ computer: true, terminalLaunch: true }))).toBe(true)
    expect(screenGranted(config({ computer: true, filesLaunch: true }))).toBe(true)
})
it('checks the actual foreground grant from current config for every input', async () => {
    const signal = new AbortController().signal
    state.read.mockResolvedValue(config({ computer: true, browser: true }))
    await authorizeScreenInput(target, 'browser', signal)
    await expect(authorizeScreenInput(target, 'terminal', signal)).rejects.toThrow('permission')
    state.read.mockResolvedValue(config({ computer: true, terminalLaunch: true }))
    await authorizeScreenInput(target, 'terminal', signal)
    await expect(authorizeScreenInput(target, 'browser', signal)).rejects.toThrow('permission')
    await expect(authorizeScreenInput(target, 'files', signal)).rejects.toThrow('permission')
    await expect(authorizeScreenInput(target, 'unknown', signal)).rejects.toThrow('not authorized')
})
it('denies disabled, deleted or aborted owners and revokes an existing guest when just one app is removed', async () => {
    const all = config({ computer: true, browser: true, terminalLaunch: true, filesLaunch: true })
    expect(screenPermissionsRevoked(all, config({ computer: true, browser: true, filesLaunch: true }))).toBe(true)
    expect(screenPermissionsRevoked(config({ computer: true, browser: true }), all)).toBe(false)
    state.read.mockResolvedValue({ ...all, enabled: false })
    await expect(authorizeScreenInput(target, 'browser', new AbortController().signal)).rejects.toThrow()
    state.read.mockResolvedValue(all); state.deleting = true
    await expect(authorizeScreenInput(target, 'terminal', new AbortController().signal)).rejects.toThrow()
    state.deleting = false
    await expect(authorizeScreenInput(target, 'files', AbortSignal.abort())).rejects.toThrow()
})
