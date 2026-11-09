import { describe, expect, it } from 'vitest'

import { onDesktopGettingStartedReopen, requestDesktopGettingStartedReopen } from './reopen'

describe('requestDesktopGettingStartedReopen', () => {
    it('notifies the current listeners once and drops them after unsubscribe', () => {
        let calls = 0
        const stop = onDesktopGettingStartedReopen(() => { calls += 1 })
        requestDesktopGettingStartedReopen()
        stop()
        requestDesktopGettingStartedReopen()
        expect(calls).toBe(1)
    })
})
