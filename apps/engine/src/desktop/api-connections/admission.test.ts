import { expect, it } from 'vitest'
import { beginDesktopApiConnectionRemoval, beginDesktopApiConnectionWork, desktopApiConnectionRemovalAvailable } from './admission.js'

it('protects preparation and background work before connection identity is known', () => {
    const releasePreparation = beginDesktopApiConnectionWork()!
    const releaseBackground = beginDesktopApiConnectionWork()!
    try {
        expect(desktopApiConnectionRemovalAvailable()).toBe(false)
        expect(beginDesktopApiConnectionRemoval()).toBeNull()
        releasePreparation()
        expect(beginDesktopApiConnectionRemoval()).toBeNull()
    } finally { releasePreparation(); releaseBackground() }
    expect(desktopApiConnectionRemovalAvailable()).toBe(true)
})

it('keeps new work closed until the complete destructive effect releases its lease', async () => {
    const releaseRemoval = beginDesktopApiConnectionRemoval()!
    try {
        expect(beginDesktopApiConnectionWork()).toBeNull()
        expect(beginDesktopApiConnectionRemoval()).toBeNull()
        await Promise.resolve()
        expect(beginDesktopApiConnectionWork()).toBeNull()
    } finally { releaseRemoval() }
    const release = beginDesktopApiConnectionWork()
    expect(release).not.toBeNull()
    release?.()
    releaseRemoval() // A duplicate release cannot release someone else's later gate.
    const next = beginDesktopApiConnectionRemoval()!
    releaseRemoval()
    try { expect(beginDesktopApiConnectionWork()).toBeNull() } finally { next() }
})
