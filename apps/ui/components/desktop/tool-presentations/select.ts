import { BRAIN_CHANGE_NOTES, brainChangeHeadline, brainChangeOf, brainSlugSchema, type BrainChangeStatus, mcpRegisterCardOf, unwrapToolOutputEnvelope } from '@rerun/contracts'
import { redactHistoricalText } from './redact'
import {
    DESKTOP_HISTORICAL_OUTPUT_BOUND,
    DESKTOP_NOTIFICATION_DELIVERED,
    desktopHistoricalCallId,
    desktopHistoricalToolName,
    projectDesktopToolStatus,
    resolveDesktopHistoricalIdentity,
    type DesktopHistoricalContext,
    type DesktopHistoricalIdentity,
    type DesktopHistoricalToolSource,
} from './status'

export { DESKTOP_NOTIFICATION_DELIVERED, DESKTOP_NOTIFICATION_UNDELIVERED } from './status'
const NOTIFICATION_MESSAGE_LIMIT = 16_000

export type DesktopHistoricalCard =
    | {
        kind: 'notification'
        toolCallId: string
        message: string
        identity: DesktopHistoricalIdentity
        status: 'succeeded'
    }
    | {
        kind: 'mcp'
        toolCallId: string
        name: string
        host: string | null
        outcome: 'saved' | 'failed'
        failure?: string
        identity: DesktopHistoricalIdentity
        status: 'succeeded'
    }
    | {
        kind: 'brain-change'
        toolCallId: string
        headline: string
        note: string
        brainStatus: BrainChangeStatus
        showOpen: boolean
        identity: DesktopHistoricalIdentity
        status: 'succeeded'
    }

function boundedString(value: unknown): string | null {
    const unwrapped = unwrapToolOutputEnvelope(value)
    if (typeof unwrapped !== 'string' || unwrapped.length > DESKTOP_HISTORICAL_OUTPUT_BOUND) return null
    return unwrapped
}

function inputRecord(input: unknown): Record<string, unknown> | null {
    return input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null
}

function mcpHost(url: string | undefined): string | null {
    if (!url || url.length > 2048 || url.includes('${')) return null
    try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
        return parsed.hostname || null
    } catch {
        return null
    }
}

function humanize(segment: string): string {
    return segment.replace(/[_-]+/g, ' ').trim().replace(/\b\w/g, letter => letter.toUpperCase())
}

function notificationCard(part: DesktopHistoricalToolSource, identity: DesktopHistoricalIdentity, toolCallId: string): DesktopHistoricalCard | null {
    const input = inputRecord(part.input)
    const message = input && typeof input.message === 'string' ? input.message : ''
    if (!message.trim() || message.length > NOTIFICATION_MESSAGE_LIMIT) return null
    const shown = redactHistoricalText(message).trim()
    if (!shown) return null
    return { kind: 'notification', toolCallId, message: shown, identity, status: 'succeeded' }
}

function mcpCard(part: DesktopHistoricalToolSource, toolName: string, identity: DesktopHistoricalIdentity, toolCallId: string): DesktopHistoricalCard | null {
    const output = boundedString(part.output)
    if (output == null || !output.trim()) return null
    const parsed = mcpRegisterCardOf(toolName, part.input, output)
    if (!parsed || parsed.name.length > 200) return null
    const name = redactHistoricalText(humanize(parsed.name), 200).trim()
    if (!name) return null
    const failure = parsed.failure ? redactHistoricalText(parsed.failure).trim() : ''
    return {
        kind: 'mcp',
        toolCallId,
        name,
        host: mcpHost(parsed.url),
        outcome: parsed.outcome,
        ...(failure ? { failure } : {}),
        identity,
        status: 'succeeded',
    }
}

function brainCard(part: DesktopHistoricalToolSource, toolName: string, identity: DesktopHistoricalIdentity, toolCallId: string): DesktopHistoricalCard | null {
    const output = part.output
    if (typeof output === 'string') {
        if (output.length > DESKTOP_HISTORICAL_OUTPUT_BOUND) return null
    } else if (output && typeof output === 'object') {
        try {
            if (JSON.stringify(output).length > DESKTOP_HISTORICAL_OUTPUT_BOUND) return null
        } catch {
            return null
        }
    } else {
        return null
    }
    const change = brainChangeOf(toolName, output)
    if (!change || typeof change.slug !== 'string' || typeof change.title !== 'string') return null
    if (change.title.length > NOTIFICATION_MESSAGE_LIMIT || change.slug.length > 200) return null
    const title = redactHistoricalText(change.title).trim()
    const agentName = typeof change.agentName === 'string' ? redactHistoricalText(change.agentName, 200).trim() : undefined
    if (!title) return null
    const mode = change.mode === 'create' || change.mode === 'edit' ? change.mode : undefined
    const headline = brainChangeHeadline({ status: change.status, title, slug: change.slug, mode, agentName: agentName || undefined })
    return {
        kind: 'brain-change',
        toolCallId,
        headline: redactHistoricalText(headline),
        note: BRAIN_CHANGE_NOTES[change.status],
        brainStatus: change.status,
        showOpen: change.status !== 'deleted',
        identity,
        status: 'succeeded',
    }
}

/** A recorded historical card, or null when the generic row (or an existing presenter) stays. */
export function selectDesktopHistoricalCard(part: DesktopHistoricalToolSource, context?: DesktopHistoricalContext): DesktopHistoricalCard | null {
    if (projectDesktopToolStatus(part, context) !== 'succeeded') return null
    const identity = resolveDesktopHistoricalIdentity(part, context)
    const toolCallId = desktopHistoricalCallId(part)
    if (!identity.ok || !toolCallId) return null
    const toolName = desktopHistoricalToolName(part)
    if (toolName === 'notify_user') return notificationCard(part, identity.identity, toolCallId)
    if (toolName === 'mcp_register' || toolName === 'mcp_login') return mcpCard(part, toolName, identity.identity, toolCallId)
    if (toolName === 'brain_write' || toolName === 'brain_delete' || toolName === 'brain_decide') return brainCard(part, toolName, identity.identity, toolCallId)
    return null
}

/**
 * The history boundary retains only fields needed to reconstruct an already-recorded card.
 * It never forwards original transport envelopes, credentials, Brain contents or undo tokens.
 * Using the same selector first keeps refusal/unknown acknowledgements out of success cards.
 */
export function projectDesktopHistoricalCard(part: DesktopHistoricalToolSource): { input: Record<string, unknown>; output: string } | null {
    const card = selectDesktopHistoricalCard(part)
    if (!card) return null
    switch (card.kind) {
        case 'notification':
            return { input: { message: card.message }, output: DESKTOP_NOTIFICATION_DELIVERED }
        case 'mcp':
            return {
                input: { name: card.name, ...(card.host && { url: `https://${card.host}` }) },
                output: card.outcome === 'saved' ? `Saved ${card.name}.` : `Nothing was saved via remote: ${card.failure || 'The server was not added.'}`,
            }
        case 'brain-change': {
            const change = brainChangeOf(desktopHistoricalToolName(part), part.output)
            const slug = brainSlugSchema.safeParse(change?.slug)
            if (!change || !slug.success) return null
            return { input: {}, output: JSON.stringify({
                status: change.status,
                slug: slug.data,
                title: redactHistoricalText(change.title),
                ...((change.mode === 'create' || change.mode === 'edit') && { mode: change.mode }),
                ...(typeof change.agentName === 'string' && { agentName: redactHistoricalText(change.agentName, 200) }),
            }) }
        }
    }
}
