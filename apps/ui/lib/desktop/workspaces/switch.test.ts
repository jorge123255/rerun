import { afterEach, describe, expect, it } from 'vitest'
import {
    abortDesktopWorkspaceSwitch,
    beginDesktopWorkspaceSwitch,
    isDesktopWorkspaceSwitchInFlight,
} from './switch'

afterEach(() => {
    abortDesktopWorkspaceSwitch()
})

describe('desktop workspace switch loader state', () => {
    it('begin marks in-flight and abort clears it', () => {
        expect(isDesktopWorkspaceSwitchInFlight()).toBe(false)
        beginDesktopWorkspaceSwitch()
        expect(isDesktopWorkspaceSwitchInFlight()).toBe(true)
        abortDesktopWorkspaceSwitch()
        expect(isDesktopWorkspaceSwitchInFlight()).toBe(false)
    })

    it('supports loader:false until enter path shows the overlay', () => {
        beginDesktopWorkspaceSwitch({ loader: false })
        expect(isDesktopWorkspaceSwitchInFlight()).toBe(true)
        abortDesktopWorkspaceSwitch()
        expect(isDesktopWorkspaceSwitchInFlight()).toBe(false)
    })
})
