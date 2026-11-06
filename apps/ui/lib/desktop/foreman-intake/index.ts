export { INTAKE_COPY } from './copy'
export {
    EMPTY_DRAFT,
    INTAKE_INDUSTRIES,
    INTAKE_STEPS,
    DEFAULT_ROLES,
    furthestReachable,
    industryHint,
    intakeSteps,
    looksLikeSite,
    rolesForIndustry,
    stepAnswered,
    toIntake,
    type IntakeDraft,
    type IntakeStep,
} from './steps'
export {
    answersFromDesktopIntake,
    canAdvanceDesktopIntake,
    chooseDesktopIntakeIndustry,
    chooseDesktopIntakeRole,
    desktopIntakeStepsOf,
    goToDesktopIntakeStep,
    hydrateDesktopIntakeMachine,
    initialDesktopIntakeMachine,
    nextDesktopIntakeStep,
    patchDesktopIntakeDraft,
    siteLooksReadable,
    skipDesktopIntakeWebsite,
    type DesktopIntakeMachineState,
} from './machine'
export { createMemoryDesktopForemanIntakeClientPorts, DesktopForemanIntakeClientConflictError, type DesktopForemanIntakeClientPorts, type DesktopIntakeSiteObservation } from './ports'
export { useDesktopForemanIntake, type DesktopForemanIntakeController } from './use-desktop-foreman-intake'
export { flushDesktopForemanIntakeWrites } from './writes'
