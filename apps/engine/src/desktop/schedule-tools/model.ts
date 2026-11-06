import { DESKTOP_SCHEDULE_TOOL_MESSAGES as M } from '@rerun/contracts'
import type { DesktopScheduleConnectedModel } from './types.js'

export function isIanaTimezone(value: string): boolean {
    try {
        new Intl.DateTimeFormat('en', { timeZone: value })
        return true
    } catch {
        return false
    }
}

/**
 * Desktop execution follows the coworker's connected model. A different pin would be stored and then
 * ignored by the scheduler, which is a silent substitute. Matching pins are stored as follow-coworker.
 */
export function desktopScheduleModelDecision(input: {
    provider?: string
    model?: string
    connected: DesktopScheduleConnectedModel | null
    /** Create ignores a provider named without a model. Update refuses it and writes nothing. */
    loneProvider: 'ignore' | 'refuse'
}): { ok: true } | { ok: false; refusal: string } {
    if (input.provider && !input.model) {
        if (input.loneProvider === 'refuse') return { ok: false, refusal: M.providerWithoutModel }
        return { ok: true }
    }
    if (!input.model) return { ok: true }
    if (!input.connected) return { ok: false, refusal: M.noModel }
    const providerMismatch = Boolean(input.provider) && input.provider !== input.connected.provider
    if (providerMismatch || input.model !== input.connected.model) return { ok: false, refusal: M.pinIgnored(`${input.connected.provider}/${input.connected.model}`) }
    return { ok: true }
}
