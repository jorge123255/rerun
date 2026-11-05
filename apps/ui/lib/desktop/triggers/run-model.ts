/**
 * Typed model override/inheritance for triggers — mirrors original RunModelPick.
 * Catalog groups are injected by root from the local desktop model catalog; this lane never
 * invents credentials or bypasses provider availability.
 */

export type DesktopTriggerRunModelPick = { connectionId: string | null; model: string | null }

export type DesktopTriggerModelOption = {
    id: string
    label: string
    description?: string
    locked?: boolean
}

export type DesktopTriggerModelGroup = {
    connectionId: string
    provider: string
    label: string
    models: DesktopTriggerModelOption[]
}

export type DesktopTriggerRunModelCatalog = {
    availableGroups: DesktopTriggerModelGroup[]
    /** What the coworker's own model resolves to today (display only). */
    agentModelLabel: string | null
    /** When false, the field shows an honest unavailable state instead of a free-text box. */
    available: boolean
    unavailableReason?: string
}

export const DESKTOP_TRIGGER_AGENT_DEFAULT = 'agent-default'
const SEPARATOR = '::'

export function encodeTriggerRunModelPick(pick: DesktopTriggerRunModelPick): string {
    return pick.model ? `${pick.connectionId ?? ''}${SEPARATOR}${pick.model}` : DESKTOP_TRIGGER_AGENT_DEFAULT
}

export function decodeTriggerRunModelPick(value: string): DesktopTriggerRunModelPick {
    if (value === DESKTOP_TRIGGER_AGENT_DEFAULT) return { connectionId: null, model: null }
    const at = value.indexOf(SEPARATOR)
    if (at === -1) return { connectionId: null, model: value }
    return { connectionId: value.slice(0, at) || null, model: value.slice(at + SEPARATOR.length) }
}

export function providerForTriggerPick(
    pick: DesktopTriggerRunModelPick,
    groups: DesktopTriggerModelGroup[],
): string | null {
    if (!pick.model) return null
    return groups.find(g => g.connectionId === pick.connectionId)?.provider ?? null
}

export function unavailableTriggerRunModelCatalog(reason = 'The model list is currently unavailable.'): DesktopTriggerRunModelCatalog {
    return { availableGroups: [], agentModelLabel: null, available: false, unavailableReason: reason }
}
