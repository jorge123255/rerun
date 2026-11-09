// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { desktopNotificationsBridge } from './notification-bridge'
afterEach(() => { delete (window as any).desktopApp })
it('preserves only bounded diagnostics, supports older statuses and strips raw fields', async () => {
    let result: unknown = { status: 'failed', diagnostic: 'native-failed', error: 'secret', title: 'private' }
    ;(window as any).desktopApp = { notifications: { notify: async () => result } }
    const notify = () => desktopNotificationsBridge().notify({ key: 'key', kind: 'done', agentId: 'owner', sessionId: 'chat', title: 'Title' })
    expect(await notify()).toEqual({ status: 'failed', diagnostic: 'native-failed' })
    result = { status: 'unknown', diagnostic: 'permission denied: private' }
    expect(await notify()).toEqual({ status: 'unknown' })
    result = { status: 'failed' }
    expect(await notify()).toEqual({ status: 'failed' })
    result = { status: 'shown', diagnostic: 'native-failed' }
    expect(await notify()).toEqual({ status: 'accepted' })
})
