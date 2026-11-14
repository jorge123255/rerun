import {
    EMPTY_DRAFT,
    furthestReachable,
    industryHint,
    intakeSteps,
    looksLikeSite,
    platformHost,
    stepAnswered,
    toIntake,
    type DesktopForemanIntakeDraft,
    type IntakeDraft,
    type IntakeStep,
    type TemplateCategory,
} from '@rerun/contracts'

/** Pure step machine: original progression, with durable revision fields carried beside it. */
export type DesktopIntakeMachineState = {
    index: number
    draft: IntakeDraft
    decided: TemplateCategory | null
    knownFirstName: string | null
    revision: number
    submitting: boolean
    error: string | null
}

export function initialDesktopIntakeMachine(knownFirstName: string | null = null): DesktopIntakeMachineState {
    return {
        index: 0,
        draft: { ...EMPTY_DRAFT },
        decided: null,
        knownFirstName,
        revision: 0,
        submitting: false,
        error: null,
    }
}

export function desktopIntakeStepsOf(state: Pick<DesktopIntakeMachineState, 'knownFirstName' | 'draft'>): IntakeStep[] {
    return intakeSteps(state.knownFirstName, state.draft.websiteSkipped)
}

export function patchDesktopIntakeDraft(state: DesktopIntakeMachineState, patch: Partial<IntakeDraft>): DesktopIntakeMachineState {
    if (state.submitting) return state
    const bySite = patch.companyUrl?.trim() ? { websiteSkipped: false, industry: null as TemplateCategory | null, industryLabel: '' } : null
    return {
        ...state,
        error: null,
        decided: patch.companyUrl !== undefined && patch.companyUrl.trim() !== state.draft.companyUrl.trim() ? null : state.decided,
        draft: { ...state.draft, ...patch, ...bySite },
    }
}

export function skipDesktopIntakeWebsite(state: DesktopIntakeMachineState): DesktopIntakeMachineState {
    if (state.submitting) return state
    return {
        ...state,
        error: null,
        decided: null,
        draft: { ...state.draft, companyUrl: '', websiteSkipped: true },
        index: state.index + 1,
    }
}

export function chooseDesktopIntakeIndustry(state: DesktopIntakeMachineState, industry: TemplateCategory): DesktopIntakeMachineState {
    if (state.submitting) return state
    return {
        ...state,
        error: null,
        draft: { ...state.draft, industry, industryLabel: '' },
        index: state.index + 1,
    }
}

export function chooseDesktopIntakeRole(state: DesktopIntakeMachineState, position: string): { state: DesktopIntakeMachineState; shouldSubmit: boolean } {
    if (state.submitting) return { state, shouldSubmit: false }
    const steps = desktopIntakeStepsOf(state)
    const chosen = { ...state.draft, position }
    const next = { ...state, error: null, draft: chosen }
    if (state.index < steps.length - 1) return { state: { ...next, index: state.index + 1 }, shouldSubmit: false }
    return { state: next, shouldSubmit: true }
}

export function goToDesktopIntakeStep(state: DesktopIntakeMachineState, target: number): DesktopIntakeMachineState {
    if (state.submitting) return state
    const steps = desktopIntakeStepsOf(state)
    const reachable = furthestReachable(steps, state.draft)
    return { ...state, index: Math.min(Math.max(target, 0), reachable) }
}

export function canAdvanceDesktopIntake(state: DesktopIntakeMachineState): boolean {
    const steps = desktopIntakeStepsOf(state)
    const reachable = furthestReachable(steps, state.draft)
    return reachable > state.index || steps.every(step => stepAnswered(step, state.draft))
}

export function nextDesktopIntakeStep(state: DesktopIntakeMachineState): {
    state: DesktopIntakeMachineState
    shouldSubmit: boolean
    hint: string | null
} {
    if (state.submitting || !canAdvanceDesktopIntake(state)) return { state, shouldSubmit: false, hint: null }
    const steps = desktopIntakeStepsOf(state)
    const hint =
        (steps[state.index] === 'company' || steps[state.index] === 'industry') && !state.draft.industry ? industryHint(state.draft) : null
    if (state.index < steps.length - 1) {
        return { state: { ...state, index: state.index + 1 }, shouldSubmit: false, hint }
    }
    return { state, shouldSubmit: true, hint }
}

export function answersFromDesktopIntake(state: DesktopIntakeMachineState) {
    return toIntake(state.draft, state.knownFirstName, state.decided)
}

export function hydrateDesktopIntakeMachine(input: {
    draft: DesktopForemanIntakeDraft
    stepIndex: number
    decidedIndustry: TemplateCategory | null
    knownFirstName: string | null
    revision: number
}): DesktopIntakeMachineState {
    const draft: IntakeDraft = { ...EMPTY_DRAFT, ...input.draft }
    const steps = intakeSteps(input.knownFirstName, draft.websiteSkipped)
    const reachable = furthestReachable(steps, draft)
    return {
        index: Math.min(Math.max(input.stepIndex, 0), reachable),
        draft,
        decided: platformHost(draft.companyUrl) ? null : input.decidedIndustry,
        knownFirstName: input.knownFirstName,
        revision: input.revision,
        submitting: false,
        error: null,
    }
}

export function siteLooksReadable(companyUrl: string): string | null {
    const site = companyUrl.trim()
    return looksLikeSite(site) ? site : null
}
