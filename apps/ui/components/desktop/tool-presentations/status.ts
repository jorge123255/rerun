import { stripBridgePrefix } from '@rerun/contracts'

export const DESKTOP_HISTORICAL_OUTPUT_BOUND = 8000
export const DESKTOP_HISTORICAL_ID_LIMIT = 200

export type DesktopToolPresentationStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'

export type DesktopHistoricalIdentity = {
    ownerId: string | null
    workspaceId: string | null
    runId: string | null
}

export type DesktopHistoricalContext = {
    ownerId?: string | null
    workspaceId?: string | null
    runId?: string | null
    /** A restarted run without an explicit recorded acknowledgement stays unknown. */
    restarted?: boolean
}

export type DesktopHistoricalToolSource = {
    type?: unknown
    toolName?: unknown
    toolCallId?: unknown
    state?: unknown
    preliminary?: unknown
    input?: unknown
    output?: unknown
    errorText?: unknown
    acknowledgement?: unknown
    restarted?: unknown
    ownerId?: unknown
    agentId?: unknown
    workspaceId?: unknown
    runId?: unknown
    providerMetadata?: unknown
}

type Ack = 'absent' | 'recorded' | 'lost' | 'cancelled'
type IdRead = { ok: true; id: string | null } | { ok: false }

const CANCELLED_STATES = new Set(['cancelled', 'canceled'])
const META_KEYS = ['desktop', 'rerun'] as const

export function desktopHistoricalToolName(part: DesktopHistoricalToolSource): string {
    const raw = part.type === 'dynamic-tool'
        ? part.toolName
        : typeof part.type === 'string' && part.type.startsWith('tool-')
            ? part.type.slice(5)
            : part.toolName
    return typeof raw === 'string' ? stripBridgePrefix(raw) : ''
}

export function desktopHistoricalCallId(part: DesktopHistoricalToolSource): string | null {
    return readId(part.toolCallId)
}

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readId(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const id = value.trim()
    if (!id || id.length > DESKTOP_HISTORICAL_ID_LIMIT || /[\u0000-\u001f]/.test(id)) return null
    return id
}

function optionalId(value: unknown, seen: boolean): IdRead {
    if (!seen) return { ok: true, id: null }
    if (value == null) return { ok: true, id: null }
    const id = readId(value)
    return id ? { ok: true, id } : { ok: false }
}

function contextId(value: string | null | undefined): IdRead {
    if (value == null) return { ok: true, id: null }
    const id = readId(value)
    return id ? { ok: true, id } : { ok: false }
}

function mergeId(current: string | null, next: IdRead): IdRead {
    if (!next.ok) return next
    if (current && next.id && current !== next.id) return { ok: false }
    return { ok: true, id: current ?? next.id }
}

function metaBlocks(part: DesktopHistoricalToolSource): { ok: true; blocks: Record<string, unknown>[] } | { ok: false } {
    if (part.providerMetadata === undefined) return { ok: true, blocks: [] }
    const meta = record(part.providerMetadata)
    if (!meta) return { ok: false }
    const blocks: Record<string, unknown>[] = []
    for (const key of META_KEYS) {
        if (!(key in meta)) continue
        const block = record(meta[key])
        if (!block) return { ok: false }
        blocks.push(block)
    }
    return { ok: true, blocks }
}

function classifyAck(raw: unknown): Ack {
    if (raw === undefined) return 'absent'
    if (raw === true || raw === 'recorded' || raw === 'applied') return 'recorded'
    if (raw === 'cancelled' || raw === 'canceled') return 'cancelled'
    return 'lost'
}

export function desktopHistoricalAcknowledgement(part: DesktopHistoricalToolSource): Ack {
    const blocks = metaBlocks(part)
    if (!blocks.ok) return 'lost'
    const values: unknown[] = []
    if ('acknowledgement' in part) values.push(part.acknowledgement)
    for (const block of blocks.blocks) {
        if ('acknowledgement' in block) values.push(block.acknowledgement)
    }
    const classes = values.map(classifyAck).filter(item => item !== 'absent')
    if (classes.length === 0) return 'absent'
    if (classes.includes('lost')) return 'lost'
    if (classes.includes('cancelled')) return 'cancelled'
    return classes.every(item => item === 'recorded') ? 'recorded' : 'lost'
}

function restarted(part: DesktopHistoricalToolSource, context?: DesktopHistoricalContext): boolean {
    if (context?.restarted === true || part.restarted === true) return true
    const blocks = metaBlocks(part)
    if (!blocks.ok) return false
    return blocks.blocks.some(block => block.restarted === true)
}

function envelopeFailed(output: unknown): boolean {
    const body = record(output)
    return body?.type === 'error-text' || body?.type === 'error-json'
}

export function resolveDesktopHistoricalIdentity(part: DesktopHistoricalToolSource, context?: DesktopHistoricalContext): { ok: true; identity: DesktopHistoricalIdentity } | { ok: false } {
    const blocks = metaBlocks(part)
    if (!blocks.ok) return { ok: false }
    if ('ownerId' in part && 'agentId' in part && part.ownerId != null && part.agentId != null && part.ownerId !== part.agentId) return { ok: false }
    let owner = optionalId('ownerId' in part ? part.ownerId : part.agentId, 'ownerId' in part || 'agentId' in part)
    let workspace = optionalId(part.workspaceId, 'workspaceId' in part)
    let run = optionalId(part.runId, 'runId' in part)
    for (const block of blocks.blocks) {
        const blockOwner = 'ownerId' in block ? block.ownerId : block.agentId
        owner = mergeId(owner.ok ? owner.id : null, owner.ok ? optionalId(blockOwner, 'ownerId' in block || 'agentId' in block) : owner)
        workspace = mergeId(workspace.ok ? workspace.id : null, workspace.ok ? optionalId(block.workspaceId, 'workspaceId' in block) : workspace)
        run = mergeId(run.ok ? run.id : null, run.ok ? optionalId(block.runId, 'runId' in block) : run)
    }
    const fromContext = {
        ownerId: contextId(context?.ownerId),
        workspaceId: contextId(context?.workspaceId),
        runId: contextId(context?.runId),
    }
    if (!owner.ok || !workspace.ok || !run.ok || !fromContext.ownerId.ok || !fromContext.workspaceId.ok || !fromContext.runId.ok) return { ok: false }
    if (owner.id && fromContext.ownerId.id && owner.id !== fromContext.ownerId.id) return { ok: false }
    if (workspace.id && fromContext.workspaceId.id && workspace.id !== fromContext.workspaceId.id) return { ok: false }
    if (run.id && fromContext.runId.id && run.id !== fromContext.runId.id) return { ok: false }
    return {
        ok: true,
        identity: {
            ownerId: owner.id ?? fromContext.ownerId.id,
            workspaceId: workspace.id ?? fromContext.workspaceId.id,
            runId: run.id ?? fromContext.runId.id,
        },
    }
}

/**
 * Historical projection. A missing acknowledgement on an ordinary transcript part uses the part
 * state. An explicit lost/unknown acknowledgement, a restart without `recorded`, or a malformed
 * owner never becomes succeeded.
 */
export function projectDesktopToolStatus(part: DesktopHistoricalToolSource, context?: DesktopHistoricalContext): DesktopToolPresentationStatus {
    if (!resolveDesktopHistoricalIdentity(part, context).ok) return 'unknown'
    const ack = desktopHistoricalAcknowledgement(part)
    const state = typeof part.state === 'string' ? part.state : ''
    if (ack === 'lost') return 'unknown'
    if (ack === 'cancelled' || CANCELLED_STATES.has(state)) return 'cancelled'
    if (restarted(part, context) && ack !== 'recorded') return 'unknown'
    const errorText = typeof part.errorText === 'string' && part.errorText.trim().length > 0
    if (errorText || state === 'output-error' || state === 'output-denied' || envelopeFailed(part.output)) return 'failed'
    switch (state) {
        case 'input-streaming':
        case 'input-available':
            return 'running'
        case 'approval-requested':
        case 'approval-responded':
            return 'pending'
        case 'output-available':
            return part.preliminary === true ? 'running' : 'succeeded'
        default:
            return 'unknown'
    }
}
