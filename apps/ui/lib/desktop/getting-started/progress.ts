import { z } from 'zod'

/** Local board milestones. Phone, invites, billing, and trial days are hosted and are not steps. */
export const DESKTOP_GETTING_STARTED_STEP_IDS = ['first_coworker', 'model', 'schedule'] as const

export type DesktopGettingStartedStepId = (typeof DESKTOP_GETTING_STARTED_STEP_IDS)[number]

export type DesktopGettingStartedFacts = {
    coworkers: number
    modelChats: number
    /** Null when the local connection list did not finish. Saved chats still count. */
    connectedProviders: number | null
    /** Null when the local routine read did not finish. That is not zero. */
    schedules: number | null
}

export type DesktopGettingStartedStep = {
    id: DesktopGettingStartedStepId
    title: string
    description: string
    done: boolean
    unavailable: boolean
}

const COPY = {
    first_coworker: {
        title: 'Create your first coworker',
        description: 'A teammate on this workspace board.',
    },
    model: {
        title: 'Connect a model',
        description: 'This workspace has a connected model, or a coworker chat has one saved.',
    },
    schedule: {
        title: 'Schedule a recurring task',
        description: 'Put one of your coworkers on a saved routine.',
        unavailable: 'Routines could not be read. This step stays open.',
    },
} as const

function counted(value: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
    return Math.trunc(value)
}

export function desktopGettingStartedSteps(facts: DesktopGettingStartedFacts): DesktopGettingStartedStep[] {
    const scheduleKnown = typeof facts.schedules === 'number' && Number.isFinite(facts.schedules) && facts.schedules >= 0
    return [
        { id: 'first_coworker', ...COPY.first_coworker, done: counted(facts.coworkers) > 0, unavailable: false },
        { id: 'model', ...COPY.model, done: counted(facts.modelChats) > 0 || (facts.connectedProviders !== null && counted(facts.connectedProviders) > 0), unavailable: false },
        {
            id: 'schedule',
            title: COPY.schedule.title,
            description: scheduleKnown ? COPY.schedule.description : COPY.schedule.unavailable,
            done: scheduleKnown && counted(facts.schedules ?? 0) > 0,
            unavailable: !scheduleKnown,
        },
    ]
}

export function desktopGettingStartedSummary(steps: readonly DesktopGettingStartedStep[]) {
    const done = steps.filter(step => step.done).length
    return {
        done,
        total: steps.length,
        complete: steps.length > 0 && steps.every(step => step.done && !step.unavailable),
        next: steps.find(step => !step.done) ?? null,
    }
}

export const desktopGettingStartedResponseSchema = z.object({
    workspaceId: z.number().int().positive(),
    dismissed: z.boolean(),
    done: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    complete: z.boolean(),
    steps: z.array(z.object({
        id: z.enum(DESKTOP_GETTING_STARTED_STEP_IDS),
        title: z.string().min(1),
        description: z.string().min(1),
        done: z.boolean(),
        unavailable: z.boolean(),
    })).length(DESKTOP_GETTING_STARTED_STEP_IDS.length),
}).strict().superRefine((value, ctx) => {
    if (value.steps.some(step => step.unavailable && step.done)) ctx.addIssue({ code: 'custom', message: 'An unread step cannot be done' })
    if (value.complete !== value.steps.every(step => step.done && !step.unavailable)) ctx.addIssue({ code: 'custom', message: 'Complete does not match the steps' })
    if (value.done !== value.steps.filter(step => step.done).length || value.total !== value.steps.length) ctx.addIssue({ code: 'custom', message: 'Counts do not match the steps' })
    const ids = value.steps.map(step => step.id)
    if (new Set(ids).size !== ids.length || DESKTOP_GETTING_STARTED_STEP_IDS.some(id => !ids.includes(id))) ctx.addIssue({ code: 'custom', message: 'Steps must be the local board milestones' })
})

export type DesktopGettingStartedResponse = z.infer<typeof desktopGettingStartedResponseSchema>

export function desktopGettingStartedResponse(workspaceId: number, dismissed: boolean, facts: DesktopGettingStartedFacts): DesktopGettingStartedResponse {
    const steps = desktopGettingStartedSteps(facts)
    const { done, total, complete } = desktopGettingStartedSummary(steps)
    return desktopGettingStartedResponseSchema.parse({ workspaceId, dismissed, done, total, complete, steps })
}
