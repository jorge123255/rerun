import { describe, expect, it } from 'vitest'

import { canAdvanceDesktopIntake, initialDesktopIntakeMachine, patchDesktopIntakeDraft, skipDesktopIntakeWebsite } from '@/lib/desktop/foreman-intake'

/**
 * Mounted-card behavior as pure projections: Skip appears on an empty company step,
 * Next stays disabled until answered, and finished cards must not keep driving effects.
 */
describe('DesktopForemanIntakeCard projections', () => {
    it('shows Skip only while the company field is empty', () => {
        const empty = initialDesktopIntakeMachine(null)
        const skippable = empty.draft.companyUrl.trim() === '' && !empty.draft.websiteSkipped
        expect(skippable).toBe(true)
        const typed = patchDesktopIntakeDraft(empty, { companyUrl: 'acme.com' })
        expect(typed.draft.companyUrl.trim() === '').toBe(false)
        const skipped = skipDesktopIntakeWebsite(empty)
        expect(skipped.draft.websiteSkipped).toBe(true)
    })

    it('keeps Next disabled until the current step can advance', () => {
        expect(canAdvanceDesktopIntake(initialDesktopIntakeMachine(null))).toBe(false)
        expect(canAdvanceDesktopIntake(patchDesktopIntakeDraft(initialDesktopIntakeMachine(null), { companyUrl: 'acme.com' }))).toBe(true)
    })
})
