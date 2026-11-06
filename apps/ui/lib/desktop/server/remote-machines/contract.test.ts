import { expect, test } from 'vitest'
import { desktopRemoteCommandSchema, desktopRemoteResultSchema, DESKTOP_REMOTE_MACHINES_VERSION } from '../../../../../../packages/contracts/src/desktop-remote-machines'
const actor = { installId: '00000000-0000-4000-8000-000000000001', workspaceId: 1, launchNonce: '00000000-0000-4000-8000-000000000002', rendererEpoch: '00000000-0000-4000-8000-000000000003' }
const requestId = '00000000-0000-4000-8000-000000000004'
test('one canonical version requires exact actor, immutable IDs, remove confirmation and explicit recovery', () => {
    expect(DESKTOP_REMOTE_MACHINES_VERSION).toBe(1)
    expect(desktopRemoteCommandSchema.safeParse({ action: 'read', actor, requestId }).success).toBe(true)
    expect(desktopRemoteCommandSchema.safeParse({ action: 'read', actor, requestId, apiKey: 'not a status field' }).success).toBe(false)
    expect(desktopRemoteCommandSchema.safeParse({ action: 'remove', actor, requestId, connectionId: requestId, expectedRevision: requestId, confirmation: 'yes' }).success).toBe(false)
    expect(desktopRemoteCommandSchema.safeParse({ action: 'recover', actor, requestId }).success).toBe(false)
    expect(desktopRemoteCommandSchema.safeParse({ action: 'recover', actor, requestId, resume: true, expectedReceiptRevision: requestId }).success).toBe(true)
})
test('returned results cannot contain a server key or an unacknowledged success-shaped object', () => {
    expect(desktopRemoteResultSchema.safeParse({ ok: true, connected: true, apiKey: 'forbidden' }).success).toBe(false)
    expect(desktopRemoteResultSchema.safeParse({ ok: false, code: 'uncertain', message: 'Not confirmed', receipt: null }).success).toBe(true)
    expect(desktopRemoteResultSchema.safeParse({ ok: false, code: 'unavailable', message: 'Not confirmed', receipt: null, apiKey: 'forbidden' }).success).toBe(false)
})
