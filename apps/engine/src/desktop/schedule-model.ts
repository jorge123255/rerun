import { isUsable, resolveRunModel, type RunModel } from '../agents/availability.js'
import type { ModelOverride } from '../agents/providers.js'
import type { LoadedAgent } from '../agents/types.js'
import { HttpError } from '../lib/errors.js'
import type { Schedule } from '../schedules/loader.js'

const incomplete = () => new HttpError(409, 'This routine’s saved model selection is incomplete.')
const unavailable = () => new HttpError(409, 'This routine’s saved model is unavailable. Choose another model or Coworker default.')

export async function resolveDesktopScheduleModel(agent: LoadedAgent, schedule: Schedule): Promise<ModelOverride | undefined> {
    const fields = [schedule.connectionId, schedule.provider, schedule.model]
    if (fields.every(value => value === null)) return undefined
    if (!schedule.connectionId || !schedule.provider || !schedule.model) throw incomplete()
    const requested = { connectionId: schedule.connectionId, provider: schedule.provider, model: schedule.model }
    assertExactDesktopScheduleModel(requested, await resolveRunModel(agent, requested))
    return requested
}

export function assertExactDesktopScheduleModel(requested: ModelOverride | undefined, resolved: RunModel) {
    if (!requested || resolved.connection?.id !== requested.connectionId || resolved.provider !== requested.provider ||
        resolved.model !== requested.model || !isUsable(resolved.connection, resolved.model)) throw unavailable()
}
