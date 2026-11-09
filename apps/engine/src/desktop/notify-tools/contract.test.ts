import { expect, test } from 'vitest'
import { desktopNotifyUserEventKey, desktopNotifyUserReceiptFromNative, desktopNotifyUserNativeBody } from './contract'

const identity = { notificationId: 'notify:a:s:r:c', eventKey: 'notify-user:a:s:r:c', attemptId: '11111111-1111-4111-8111-111111111111', agentId: 'a', sessionId: 's', runId: 'r', message: 'Review this', metadata: null, createdAt: '2026-11-06T00:00:00.000Z' }

test('event identity is stable per exact agent/session/run/tool call', () => {
    expect(desktopNotifyUserEventKey({ agentId: 'a', sessionId: 's', runId: 'r', toolCallId: 'c' })).toBe('notify-user:a:s:r:c')
    expect(desktopNotifyUserEventKey({ agentId: 'a', sessionId: 's', runId: null, toolCallId: 'c' })).toBe('notify-user:a:s:no-run:c')
    expect(desktopNotifyUserEventKey({ agentId: 'a', sessionId: 's', runId: 'other', toolCallId: 'c' })).not.toBe('notify-user:a:s:r:c')
})

test('native outcomes map to shown, failed and unknown without upgrading uncertainty', () => {
    expect(desktopNotifyUserReceiptFromNative(identity, { status: 'shown' })).toMatchObject({ status: 'accepted', nativeStatus: 'accepted' })
    expect(desktopNotifyUserReceiptFromNative(identity, { status: 'failed' })).toMatchObject({ status: 'failed', nativeStatus: 'failed' })
    expect(desktopNotifyUserReceiptFromNative(identity, { status: 'unavailable' })).toMatchObject({ status: 'failed', nativeStatus: 'unavailable' })
    expect(desktopNotifyUserReceiptFromNative(identity, { status: 'unknown' })).toMatchObject({ status: 'unknown', nativeStatus: 'unknown' })
})

test('native body is bounded and control-safe without changing the stored full message', () => {
    expect(desktopNotifyUserNativeBody(`a\u0000b${'x'.repeat(3000)}`)).toHaveLength(2048)
    expect(desktopNotifyUserNativeBody('a\u0000b')).toBe('ab')
})
