import type { DesktopRemoteActor, DesktopRemoteConnection, DesktopRemoteReceipt, DesktopRemoteSnapshot } from '@rerun/contracts'

export const remoteActor: DesktopRemoteActor = {
    installId: '11111111-1111-4111-8111-111111111111', workspaceId: 1,
    launchNonce: '22222222-2222-4222-8222-222222222222', rendererEpoch: '77777777-7777-4777-8777-777777777777',
}
export const remoteConnection: DesktopRemoteConnection = {
    connectionId: '33333333-3333-4333-8333-333333333333', revision: '44444444-4444-4444-8444-444444444444',
    workspaceId: 1, address: 'https://machine.example',
    identity: { protocolVersion: 1, machineId: '55555555-5555-4555-8555-555555555555', workspaceId: 1 },
    credentialConfigured: true, removable: true,
    health: { state: 'connected', checkedAt: '2026-11-06T00:00:00.000Z', commit: 'abc1234', activeAgents: 3, reason: null },
}
export const remoteReceipt: DesktopRemoteReceipt = {
    version: 1, receiptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    installId: remoteActor.installId, workspaceId: 1, kind: 'select', connectionId: remoteConnection.connectionId,
    configurationRevision: remoteConnection.revision, expectedRevision: remoteConnection.revision,
    revision: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', phase: 'published', effectGeneration: 0,
    closeAttempted: true, requiresRecovery: false, reason: null, createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z',
}
export const emptyRemoteSnapshot = (actor: DesktopRemoteActor): DesktopRemoteSnapshot => ({ version: 1, actor, revision: 'unconfigured', connection: null, selected: false, runtimeState: 'not_connected', activeReceipt: null, openReceipt: null })
export function connectedRemoteSnapshot(actor: DesktopRemoteActor, overrides: Partial<DesktopRemoteSnapshot> = {}): DesktopRemoteSnapshot {
    const value = { version: 1 as const, actor, revision: remoteConnection.revision, connection: remoteConnection, selected: true, runtimeState: 'connected' as const, activeReceipt: remoteReceipt, openReceipt: null, ...overrides }
    if (!value.selected) value.activeReceipt = null
    return value
}
