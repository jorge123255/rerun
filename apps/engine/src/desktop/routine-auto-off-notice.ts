import { ROUTINE_FAILURES_BEFORE_OFF } from '@rerun/contracts'
import { getAgent } from '../agents/registry.js'
import { appendMessage } from '../db/repos/messages.js'
import { createSession } from '../db/repos/sessions.js'
import { logger } from '../lib/logger.js'
import { sendNotification } from '../runtime/notify.js'

/** What the notice says. The Mac app writes its own sentence, in the person's language, from the two names. */
export function desktopRoutineAutoOffText(routine: string, coworker: string): string {
    return `${routine} was turned off after ${ROUTINE_FAILURES_BEFORE_OFF} failed runs in a row. Turn it back on in ${coworker}’s Routines.`
}

/**
 * Tells the person, once, that a routine was switched off after ten failures in a row (Mac app).
 * Decided November 16, 2026: the notice is a notification of its own, so it reaches the person even
 * when they muted that coworker; it used to ride the failed run's notification, which a mute hides.
 *
 * Called exactly once per switch-off, by whoever counted the tenth failure. A routine that never
 * got as far as a run has no conversation to open, so one is made that holds the notice.
 */
export async function announceDesktopRoutineAutoOff(input: {
    agentId: string
    slug: string
    name: string
    disabledAt: string
    sessionId: string | null
    runId: string | null
    lastError?: string
}): Promise<void> {
    const coworker = await getAgent(input.agentId).then(agent => agent.config.name, () => 'the coworker')
    const message = desktopRoutineAutoOffText(input.name, coworker)
    let sessionId = input.sessionId
    if (!sessionId) {
        try {
            const session = await createSession(input.agentId, `schedule: ${input.slug}`, undefined, 'schedule')
            const detail = input.lastError?.replace(/\s+/g, ' ').trim().slice(0, 500)
            await appendMessage(input.agentId, session.id, { role: 'assistant', content: detail ? `${message}\n\nLast error: ${detail}` : message })
            sessionId = session.id
        } catch (error) {
            logger.error({ agent: input.agentId, schedule: input.slug, err: String(error) }, 'no conversation could be made for the routine switch-off notice')
        }
    }
    await sendNotification({
        event: 'agent.notification', kind: 'error', agentId: input.agentId, sessionId, runId: input.runId, message, title: input.name.slice(0, 200), source: 'schedule',
        metadata: { routineAutoOff: true, scheduleSlug: input.slug, sourceName: input.name, coworkerName: coworker, disabledAt: input.disabledAt },
    })
}
