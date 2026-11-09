import { describe, expect, it } from 'vitest'
import { desktopGettingStartedAvailable, publishDesktopGettingStartedAvailability, subscribeDesktopGettingStartedAvailability } from './availability'

describe('desktop getting started availability', () => {
    it('follows one workspace until the checklist read is cleared', () => {
        publishDesktopGettingStartedAvailability(null)
        expect(desktopGettingStartedAvailable(4)).toBe(false)
        let calls = 0
        const stop = subscribeDesktopGettingStartedAvailability(() => { calls += 1 })
        publishDesktopGettingStartedAvailability(4)
        expect(desktopGettingStartedAvailable(4)).toBe(true)
        expect(desktopGettingStartedAvailable(9)).toBe(false)
        publishDesktopGettingStartedAvailability(4)
        expect(calls).toBe(1)
        stop()
        publishDesktopGettingStartedAvailability(null)
        expect(calls).toBe(1)
        expect(desktopGettingStartedAvailable(4)).toBe(false)
    })
})
