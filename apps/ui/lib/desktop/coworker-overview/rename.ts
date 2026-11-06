import type { DesktopOverviewIdentity } from './identity'
import { sameDesktopOverviewIdentity } from './identity'

export const DESKTOP_OVERVIEW_RENAME_UNCONFIRMED = 'Could not confirm the coworker’s new name. Try again.'
export const DESKTOP_OVERVIEW_RENAME_LIMIT = 'A coworker name of 1–60 characters is required'

export function desktopOverviewRenameBody(name: string) {
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > 60) return { ok: false as const, message: DESKTOP_OVERVIEW_RENAME_LIMIT }
    return { ok: true as const, name: trimmed }
}

export function acceptDesktopOverviewRename(input: {
    identity: DesktopOverviewIdentity
    responseIdentity: DesktopOverviewIdentity
    requestedName: string
    response: unknown
}) {
    if (!sameDesktopOverviewIdentity(input.identity, input.responseIdentity)) {
        return { ok: false as const, message: DESKTOP_OVERVIEW_RENAME_UNCONFIRMED, retry: false as const }
    }
    const agent = responseAgent(input.response)
    if (!agent || agent.id !== input.identity.agentId || agent.name !== input.requestedName) {
        return { ok: false as const, message: DESKTOP_OVERVIEW_RENAME_UNCONFIRMED, retry: false as const }
    }
    return { ok: true as const, name: agent.name, retry: false as const }
}

function responseAgent(response: unknown): { id: string; name: string } | null {
    if (!response || typeof response !== 'object' || !('agent' in response)) return null
    const agent = (response as { agent?: unknown }).agent
    if (!agent || typeof agent !== 'object') return null
    const { id, name } = agent as { id?: unknown; name?: unknown }
    if (typeof id !== 'string' || typeof name !== 'string') return null
    return { id, name }
}
