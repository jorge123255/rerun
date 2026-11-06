import { DESKTOP_TRIGGER_TOOL_MESSAGES as M } from '@rerun/contracts'
import type { DesktopTriggerConnectedModel } from './types.js'

export type DesktopTriggerPinDecision =
    | { ok: true; pins: 'omit' | 'clear' }
    | { ok: false; refusal: string }

/**
 * Model tools never persist a pin. Desktop launch resolves the model again and can fall back,
 * so a stored name would look saved and then run as something else. A matching name is stored
 * as follow-coworker. Create ignores a provider without a model. Update refuses it.
 */
export function desktopTriggerModelDecision(input: {
    provider?: string | null
    model?: string | null
    connected: DesktopTriggerConnectedModel | null
    loneProvider: 'ignore' | 'refuse'
}): DesktopTriggerPinDecision {
    const model = input.model ? input.model : ''
    const provider = input.provider ? input.provider : ''
    if (!model && !provider) return { ok: true, pins: 'omit' }
    if (!model) {
        if (input.loneProvider === 'refuse') return { ok: false, refusal: M.providerWithoutModel }
        return { ok: true, pins: 'omit' }
    }
    if (!input.connected) return { ok: false, refusal: M.noModel(model) }
    const providerMismatch = Boolean(provider) && provider !== input.connected.provider
    if (providerMismatch || model !== input.connected.model) return { ok: false, refusal: M.pinRefused(`${input.connected.provider}/${input.connected.model}`) }
    return { ok: true, pins: 'clear' }
}
