import { describe, expect, it } from 'vitest'

import {
    canAdvanceDesktopIntake,
    chooseDesktopIntakeIndustry,
    chooseDesktopIntakeRole,
    desktopIntakeStepsOf,
    goToDesktopIntakeStep,
    hydrateDesktopIntakeMachine,
    initialDesktopIntakeMachine,
    nextDesktopIntakeStep,
    patchDesktopIntakeDraft,
    skipDesktopIntakeWebsite,
} from './machine'

describe('desktop intake machine (original progression)', () => {
    it('asks name only when nothing holds one, and industry only after skip', () => {
        expect(desktopIntakeStepsOf(initialDesktopIntakeMachine(null))).toEqual(['company', 'role', 'name'])
        expect(desktopIntakeStepsOf(initialDesktopIntakeMachine('Ada'))).toEqual(['company', 'role'])
        const skipped = skipDesktopIntakeWebsite(initialDesktopIntakeMachine('Ada'))
        expect(desktopIntakeStepsOf(skipped)).toEqual(['company', 'industry', 'role'])
    })

    it('Skip opens industry and clears a typed site decision', () => {
        const typed = patchDesktopIntakeDraft(initialDesktopIntakeMachine(null), { companyUrl: 'rerun.build' })
        const skipped = skipDesktopIntakeWebsite({ ...typed, decided: 'saas' })
        expect(skipped.draft.companyUrl).toBe('')
        expect(skipped.draft.websiteSkipped).toBe(true)
        expect(skipped.decided).toBeNull()
        expect(skipped.index).toBe(1)
        expect(desktopIntakeStepsOf(skipped)[1]).toBe('industry')
    })

    it('Back cannot jump past an unanswered step', () => {
        const withSite = patchDesktopIntakeDraft(initialDesktopIntakeMachine(null), { companyUrl: 'acme.com' })
        const atRole = { ...withSite, index: 1 }
        expect(goToDesktopIntakeStep(atRole, 0).index).toBe(0)
        expect(goToDesktopIntakeStep(atRole, 2).index).toBe(1)
    })

    it('choosing industry or role advances; last role requests submit', () => {
        const skipped = skipDesktopIntakeWebsite(initialDesktopIntakeMachine('Ada'))
        const afterIndustry = chooseDesktopIntakeIndustry(skipped, 'saas')
        expect(afterIndustry.draft.industry).toBe('saas')
        expect(afterIndustry.index).toBe(2)
        const { state, shouldSubmit } = chooseDesktopIntakeRole(afterIndustry, 'Founder / CEO')
        expect(state.draft.position).toBe('Founder / CEO')
        expect(shouldSubmit).toBe(true)
    })

    it('Next is blocked until the step is answered', () => {
        const empty = initialDesktopIntakeMachine(null)
        expect(canAdvanceDesktopIntake(empty)).toBe(false)
        expect(nextDesktopIntakeStep(empty).shouldSubmit).toBe(false)
        const answered = patchDesktopIntakeDraft(empty, { companyUrl: 'acme.com' })
        expect(canAdvanceDesktopIntake(answered)).toBe(true)
    })

    it('hydrate restores unanswered inputs and clamps step to reachable', () => {
        const hydrated = hydrateDesktopIntakeMachine({
            draft: { companyUrl: 'acme.com', websiteSkipped: false, industry: null, industryLabel: '', position: '', firstName: '' },
            stepIndex: 9,
            decidedIndustry: 'saas',
            knownFirstName: null,
            revision: 3,
        })
        expect(hydrated.index).toBe(1)
        expect(hydrated.revision).toBe(3)
        expect(hydrated.draft.companyUrl).toBe('acme.com')
        expect(hydrated.decided).toBe('saas')
    })
})
