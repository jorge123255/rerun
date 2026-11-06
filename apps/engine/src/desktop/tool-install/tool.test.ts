import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopToolInstallPorts, DesktopToolInstallSnapshot } from '@rerun/contracts'

const grants = vi.hoisted(() => ({ hasDesktopToolGrant: vi.fn(() => true) }))
vi.mock('../tool-grants.js', () => grants)
vi.mock('../agent-lifecycle.js', () => ({ beginDesktopAgentWork: () => () => {} }))

import { desktopToolInstallTools, desktopToolInstallOutcomeText } from './tool'

function ports(): DesktopToolInstallPorts {
    return {
        authority: vi.fn(async () => ({ engineAgentId: 'engine', launchNonce: 'launch', sessionGeneration: 'a'.repeat(32), workspaceFingerprint: 'b'.repeat(64) })),
        guest: { execute: vi.fn(), inspect: vi.fn() },
        outcomes: { begin: vi.fn(async () => 'execute'), complete: vi.fn(async () => {}), read: vi.fn(), list: vi.fn() },
    }
}

function ctx(allowToolInstall = true) {
    return {
        agent: { id: 'agent', config: { selfImprovement: { enabled: true, allowToolInstall }, tools: {} } },
        sessionId: 'session', runId: 'run', abortSignal: new AbortController().signal,
    } as Parameters<typeof desktopToolInstallTools>[0]
}

beforeEach(() => { grants.hasDesktopToolGrant.mockReturnValue(true) })

describe('desktop tool_install proposal tool', () => {
    it('creates only a pending review and never executes during proposal', async () => {
        const injected = ports()
        const tools = desktopToolInstallTools(ctx(), injected)
        const snapshot = await (tools.tool_install as { execute: (input: unknown, options: unknown) => Promise<DesktopToolInstallSnapshot> }).execute({ packages: ['left-pad@1.2.3'] }, { toolCallId: 'tool', abortSignal: new AbortController().signal })
        expect(snapshot.status).toBe('pending-approval')
        expect(injected.guest.execute).not.toHaveBeenCalled()
        expect(desktopToolInstallOutcomeText(snapshot)).toContain('Approval required to install left-pad@1.2.3')
    })

    it('refuses invalid input before authority or execution', async () => {
        const injected = ports()
        const tools = desktopToolInstallTools(ctx(), injected)
        await expect((tools.tool_install as { execute: (input: unknown, options: unknown) => Promise<DesktopToolInstallSnapshot> }).execute({ packages: ['--prefix=/etc'] }, { toolCallId: 'tool', abortSignal: new AbortController().signal })).rejects.toThrow()
        expect(injected.authority).not.toHaveBeenCalled()
        expect(injected.guest.execute).not.toHaveBeenCalled()
    })

    it('requires both Improve itself and the distinct install permission', () => {
        expect(desktopToolInstallTools(ctx(false), ports())).toEqual({})
        grants.hasDesktopToolGrant.mockReturnValue(false)
        expect(desktopToolInstallTools(ctx(), ports())).toEqual({})
    })
})
