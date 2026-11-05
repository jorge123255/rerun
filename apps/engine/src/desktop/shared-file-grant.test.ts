import { describe, expect, it } from 'vitest'
import { desktopSharedFilesAllowed } from './shared-file-grant.js'

const granted = { enabled: true, tools: { shared: true, desktopToolGrants: { shared: true } } }

describe('desktopSharedFilesAllowed', () => {
    it('stays off unless this coworker is enabled and the shared grant is exactly true', () => {
        expect(desktopSharedFilesAllowed(granted)).toBe(true)
        expect(desktopSharedFilesAllowed(null)).toBe(false)
        expect(desktopSharedFilesAllowed({ enabled: false, tools: { shared: true, desktopToolGrants: { shared: true } } })).toBe(false)
        expect(desktopSharedFilesAllowed({ enabled: true, tools: { shared: true } })).toBe(false)
        expect(desktopSharedFilesAllowed({ enabled: true, tools: { shared: true, desktopToolGrants: {} } })).toBe(false)
        expect(desktopSharedFilesAllowed({ enabled: true, tools: { shared: true, desktopToolGrants: { shared: false } } })).toBe(false)
    })

    it('does not treat the hosted shared switch as the Mac grant', () => {
        expect(desktopSharedFilesAllowed({ enabled: true, tools: { shared: true, desktopToolGrants: { workspaceRead: true } } })).toBe(false)
        expect(desktopSharedFilesAllowed({ enabled: true, tools: { shared: false, desktopToolGrants: { shared: true } } })).toBe(false)
    })
})
