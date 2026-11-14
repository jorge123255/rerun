import { HITL_TOOL_NAMES, QUICK_REPLIES_TOOL, toolLabelOf } from '@rerun/contracts'
import { redactHistoricalText } from './redact'
import { selectDesktopHistoricalCard, type DesktopHistoricalCard } from './select'
import {
    desktopHistoricalCallId,
    desktopHistoricalToolName,
    projectDesktopToolStatus,
    resolveDesktopHistoricalIdentity,
    type DesktopHistoricalContext,
    type DesktopHistoricalIdentity,
    type DesktopHistoricalToolSource,
    type DesktopToolPresentationStatus,
} from './status'

/** Tools the central renderer already presents. This package does not replace them. */
export const DESKTOP_HISTORICAL_PASSTHROUGH_TOOLS = [
    ...Object.keys(HITL_TOOL_NAMES),
    QUICK_REPLIES_TOOL,
    'call_agent',
    'delegate_tasks',
    'tool_install',
    'install_complete',
    'brain_propose',
    'skill_propose',
    'card_file',
    'card_table',
] as const

/** Hosted or live cards. They stay on the generic row and are not ported. */
export const DESKTOP_HISTORICAL_UNSUPPORTED_TOOLS = [
    'rerun_hub_service_install',
    'rerun_hub_publish_file',
    'paid_data',
] as const

const PASSTHROUGH = new Set<string>(DESKTOP_HISTORICAL_PASSTHROUGH_TOOLS)
const SENSITIVE_TOOL = /(?:^|_)(?:secret|credential|token|oauth|sign_in|password)(?:_|$)/i

export type DesktopHistoricalGenericItem = {
    key: string
    toolName: string
    label: string
    status: DesktopToolPresentationStatus
    detail: string | null
    identity: DesktopHistoricalIdentity
}

export type DesktopHistoricalPlanBlock =
    | { kind: 'passthrough'; key: string; toolName: string }
    | { kind: 'card'; key: string; card: DesktopHistoricalCard }
    | { kind: 'group'; key: string; items: DesktopHistoricalGenericItem[] }

function genericDetail(part: DesktopHistoricalToolSource, toolName: string, status: DesktopToolPresentationStatus): string | null {
    if (SENSITIVE_TOOL.test(toolName)) return status === 'failed' ? 'Credential request failed.' : null
    if (status === 'failed') {
        const error = typeof part.errorText === 'string' ? part.errorText : ''
        return redactHistoricalText(error).trim() || 'Tool failed.'
    }
    if (status === 'succeeded' && typeof part.output === 'string') {
        const shown = redactHistoricalText(part.output).trim()
        return shown || null
    }
    return null
}

export function projectDesktopGenericTool(part: DesktopHistoricalToolSource, index: number, context: DesktopHistoricalContext | undefined): DesktopHistoricalGenericItem {
    const identity = resolveDesktopHistoricalIdentity(part, context)
    const status = projectDesktopToolStatus(part, context)
    const toolName = desktopHistoricalToolName(part)
    return {
        key: desktopHistoricalCallId(part) ?? `missing-id-${index}`,
        toolName,
        label: redactHistoricalText(toolLabelOf(toolName || 'tool'), 200),
        status,
        detail: identity.ok ? genericDetail(part, toolName, status) : null,
        identity: identity.ok ? identity.identity : { ownerId: null, workspaceId: null, runId: null },
    }
}

function sameIdentity(left: DesktopHistoricalIdentity, right: DesktopHistoricalIdentity): boolean {
    return left.ownerId === right.ownerId && left.workspaceId === right.workspaceId && left.runId === right.runId
}

/**
 * Groups only leftover generic steps. Passthrough marks a tool the existing renderer owns.
 * A historical card breaks the group. Root keeps its current branches; this plan is not mounted.
 */
export function planDesktopToolPresentation(parts: readonly DesktopHistoricalToolSource[], context?: DesktopHistoricalContext): DesktopHistoricalPlanBlock[] {
    const blocks: DesktopHistoricalPlanBlock[] = []
    let group: DesktopHistoricalGenericItem[] = []
    const flush = () => {
        if (group.length === 0) return
        blocks.push({ kind: 'group', key: `group-${group[0].key}`, items: group })
        group = []
    }
    parts.forEach((part, index) => {
        const toolName = desktopHistoricalToolName(part)
        if (PASSTHROUGH.has(toolName)) {
            flush()
            blocks.push({ kind: 'passthrough', key: desktopHistoricalCallId(part) ?? `passthrough-${index}`, toolName })
            return
        }
        const card = selectDesktopHistoricalCard(part, context)
        if (card) {
            flush()
            blocks.push({ kind: 'card', key: card.toolCallId, card })
            return
        }
        const item = projectDesktopGenericTool(part, index, context)
        const identityOk = resolveDesktopHistoricalIdentity(part, context).ok
        const previous = group.at(-1)
        if (!identityOk || (previous && !sameIdentity(previous.identity, item.identity))) flush()
        if (!identityOk) {
            blocks.push({ kind: 'group', key: `group-${item.key}`, items: [item] })
            return
        }
        group.push(item)
    })
    flush()
    return blocks
}
