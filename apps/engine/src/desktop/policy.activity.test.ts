import { expect, it } from 'vitest'
import { desktopRouteAllowed } from './policy.js'

// The Activity view reads the trail through this route. Left off the list, the engine answers
// "This feature is not enabled in the desktop preview" and the view cannot open.
it('lets the Mac app read and clear the activity trail, and nothing else on that path', () => {
    expect(desktopRouteAllowed('GET', '/desktop/activity')).toBe(true)
    expect(desktopRouteAllowed('DELETE', '/desktop/activity')).toBe(true)
    expect(desktopRouteAllowed('POST', '/desktop/activity')).toBe(false)
    expect(desktopRouteAllowed('PUT', '/desktop/activity')).toBe(false)
    expect(desktopRouteAllowed('GET', '/desktop/activity/export')).toBe(false)
})
