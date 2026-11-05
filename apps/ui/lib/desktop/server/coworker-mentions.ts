import 'server-only'

import type { DesktopCoworkerCallTarget } from '../../../../../packages/contracts/src/desktop-coworker-calls.ts'
import { revalidateDesktopCoworkerMentions, type DesktopCoworkerMention, type DesktopCoworkerMentionRevalidation } from '@/components/desktop/mentions/coworker-mention-model'

export const DESKTOP_COWORKER_MENTION_TARGET_LIMIT = 100
export const DESKTOP_COWORKER_MENTION_TEXT_LIMIT = 256
export const DESKTOP_COWORKER_MENTION_LOOKUP_TIMEOUT_MS = 10_000

export type DesktopCoworkerMentionRosterAuthority = {
    listTargets: (ownerAgentId: string, options: { signal: AbortSignal }) => Promise<readonly DesktopCoworkerCallTarget[]>
}

class DesktopCoworkerMentionRosterError extends Error {}

const boundedText = (value: unknown, nullable: boolean): value is string | null =>
    typeof value === 'string' && value.length > 0 && value.length <= DESKTOP_COWORKER_MENTION_TEXT_LIMIT || nullable && value === null

async function currentTargets(authority: DesktopCoworkerMentionRosterAuthority, ownerAgentId: string, signal: AbortSignal): Promise<DesktopCoworkerCallTarget[]> {
    if (!boundedText(ownerAgentId, false)) throw new DesktopCoworkerMentionRosterError('Invalid coworker owner.')
    signal.throwIfAborted()
    const rows = await authority.listTargets(ownerAgentId, { signal })
    signal.throwIfAborted()
    if (!Array.isArray(rows)) throw new DesktopCoworkerMentionRosterError('Coworker roster is malformed.')
    if (rows.length > DESKTOP_COWORKER_MENTION_TARGET_LIMIT) throw new DesktopCoworkerMentionRosterError('Coworker suggestion roster exceeded its safe limit.')
    const ids = new Set<string>()
    const targets: DesktopCoworkerCallTarget[] = []
    for (const target of rows) {
        if (!target || !boundedText(target.agentId, false) || !boundedText(target.name, false)
            || !boundedText(target.handle, true) || !boundedText(target.boxName, true)
            || typeof target.enabled !== 'boolean' || typeof target.callable !== 'boolean') {
            throw new DesktopCoworkerMentionRosterError('Coworker roster is malformed.')
        }
        if (target.agentId === ownerAgentId) continue
        if (ids.has(target.agentId)) throw new DesktopCoworkerMentionRosterError('Coworker roster contains a duplicate identity.')
        ids.add(target.agentId)
        targets.push({ agentId: target.agentId, name: target.name, handle: target.handle, boxName: target.boxName, enabled: target.enabled, callable: target.callable })
    }
    return targets
}

export function createDesktopCoworkerMentionsApi(authority: DesktopCoworkerMentionRosterAuthority, options: { timeoutMs?: number } = {}) {
    const timeoutMs = options.timeoutMs ?? DESKTOP_COWORKER_MENTION_LOOKUP_TIMEOUT_MS
    return async (request: Request, ownerAgentId: string): Promise<Response> => {
        if (request.method !== 'GET') return Response.json({ error: 'Method not allowed.' }, { status: 405, headers: { 'Cache-Control': 'no-store' } })
        const deadline = AbortSignal.timeout(timeoutMs)
        const signal = AbortSignal.any([request.signal, deadline])
        try {
            if (request.signal.aborted) return Response.json({ error: 'Coworker suggestion request was cancelled.' }, { status: 408, headers: { 'Cache-Control': 'no-store' } })
            const targets = await currentTargets(authority, ownerAgentId, signal)
            return Response.json({ targets }, { headers: { 'Cache-Control': 'no-store' } })
        } catch (cause) {
            if (request.signal.aborted) return Response.json({ error: 'Coworker suggestion request was cancelled.' }, { status: 408, headers: { 'Cache-Control': 'no-store' } })
            if (deadline.aborted) return Response.json({ error: 'Coworker suggestion lookup timed out.' }, { status: 504, headers: { 'Cache-Control': 'no-store' } })
            if (cause instanceof DesktopCoworkerMentionRosterError) return Response.json({ error: cause.message }, { status: 502, headers: { 'Cache-Control': 'no-store' } })
            return Response.json({ error: 'Coworker suggestions are unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
        }
    }
}

export async function validateDesktopCoworkerMentionsAtSend(authority: DesktopCoworkerMentionRosterAuthority, input: {
    agentId: string
    text: string
    mentions: DesktopCoworkerMention[]
    signal?: AbortSignal
}): Promise<DesktopCoworkerMentionRevalidation> {
    const deadline = AbortSignal.timeout(DESKTOP_COWORKER_MENTION_LOOKUP_TIMEOUT_MS)
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline
    const targets = await currentTargets(authority, input.agentId, signal)
    signal.throwIfAborted()
    return revalidateDesktopCoworkerMentions(input.text, input.mentions, targets)
}
