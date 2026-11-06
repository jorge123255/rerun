import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { DesktopRuntime } from './runtime'
import { beginDesktopWorkspaceAdmission, completeDesktopWorkspaceAdmission, desktopWorkspaceFrozen } from './workspace-admission'
const runtime = (): DesktopRuntime => ({ protocolVersion: 1, workspaceId: 7, launchNonce: randomUUID(), buildId: 'qa', dataRoot: '/synthetic/workspaces/7', app: { origin: 'http://127.0.0.1:3000', sessionToken: 'a'.repeat(64) }, engine: { origin: 'http://127.0.0.1:3001', apiKey: 'b'.repeat(64) } })
afterEach(() => { vi.unstubAllEnvs() })
it('starts the target UI frozen and an acknowledged unfreeze explicitly overrides the boot flag', () => {
    vi.stubEnv('RERUN_DESKTOP_ADMISSIONS_FROZEN', '1')
    const ctx = runtime()
    expect(desktopWorkspaceFrozen(ctx)).toBe(true)
    beginDesktopWorkspaceAdmission(ctx, 'unfreeze', 1)
    expect(desktopWorkspaceFrozen(ctx)).toBe(true)
    completeDesktopWorkspaceAdmission(ctx, 'unfreeze', 1)
    expect(desktopWorkspaceFrozen(ctx)).toBe(false)
})
it('a superseded freeze response or replay cannot undo a newer confirmed UI unfreeze', () => {
    vi.stubEnv('RERUN_DESKTOP_ADMISSIONS_FROZEN', '0')
    const ctx = runtime()
    beginDesktopWorkspaceAdmission(ctx, 'freeze', 1)
    expect(desktopWorkspaceFrozen(ctx)).toBe(true)
    beginDesktopWorkspaceAdmission(ctx, 'unfreeze', 2)
    completeDesktopWorkspaceAdmission(ctx, 'unfreeze', 2)
    expect(desktopWorkspaceFrozen(ctx)).toBe(false)
    expect(() => completeDesktopWorkspaceAdmission(ctx, 'freeze', 1)).toThrow('superseded')
    expect(() => beginDesktopWorkspaceAdmission(ctx, 'freeze', 1)).toThrow('stale')
    expect(() => beginDesktopWorkspaceAdmission(ctx, 'freeze', 2)).toThrow('stale')
    expect(desktopWorkspaceFrozen(ctx)).toBe(false)
    beginDesktopWorkspaceAdmission(ctx, 'unfreeze', 2)
    completeDesktopWorkspaceAdmission(ctx, 'unfreeze', 2)
    expect(desktopWorkspaceFrozen(ctx)).toBe(false)
})
