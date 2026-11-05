'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopCoworkerCallTarget } from '../../../../packages/contracts/src/desktop-coworker-calls.ts'

export type DesktopCoworkerMention = {
    targetId: string
    token: string
    start: number
    end: number
}

export type DesktopResolvedCoworkerMention = DesktopCoworkerMention & {
    target: DesktopCoworkerCallTarget
}

export type DesktopCoworkerMentionRevalidation =
    | { ok: true; mentions: DesktopResolvedCoworkerMention[] }
    | { ok: false; code: 'range' | 'target'; error: string }

function readMentions(text: string, value: unknown): DesktopCoworkerMention[] {
    if (!Array.isArray(value)) return []
    const mentions: DesktopCoworkerMention[] = []
    for (const candidate of value) {
        if (!candidate || typeof candidate !== 'object') return []
        const row = candidate as Record<string, unknown>
        if (typeof row.targetId !== 'string' || !row.targetId || typeof row.token !== 'string' || !row.token.startsWith('@') || row.token.length < 2) return []
        if (typeof row.start !== 'number' || !Number.isInteger(row.start) || typeof row.end !== 'number' || !Number.isInteger(row.end)) return []
        const start = row.start
        const end = row.end
        if (start < 0 || end <= start || end > text.length || text.slice(start, end) !== row.token) return []
        mentions.push({ targetId: row.targetId, token: row.token, start, end })
    }
    mentions.sort((a, b) => a.start - b.start || a.end - b.end || a.targetId.localeCompare(b.targetId))
    for (let index = 1; index < mentions.length; index++) {
        if (mentions[index].start < mentions[index - 1].end) return []
    }
    return mentions
}

export function reconcileDesktopCoworkerMentions(previousText: string, nextText: string, mentions: DesktopCoworkerMention[]): DesktopCoworkerMention[] {
    const current = readMentions(previousText, mentions)
    if (previousText === nextText) return current
    let prefix = 0
    while (prefix < previousText.length && prefix < nextText.length && previousText[prefix] === nextText[prefix]) prefix++
    let suffix = 0
    while (suffix < previousText.length - prefix && suffix < nextText.length - prefix && previousText[previousText.length - suffix - 1] === nextText[nextText.length - suffix - 1]) suffix++
    const oldEditEnd = previousText.length - suffix
    const delta = nextText.length - previousText.length
    const next: DesktopCoworkerMention[] = []
    for (const mention of current) {
        if (mention.end <= prefix) next.push(mention)
        else if (mention.start >= oldEditEnd) next.push({ ...mention, start: mention.start + delta, end: mention.end + delta })
    }
    return next
}

export function insertDesktopCoworkerMention(text: string, mentions: DesktopCoworkerMention[], selection: {
    start: number
    end: number
    target: DesktopCoworkerCallTarget
}): { text: string; mentions: DesktopCoworkerMention[] } {
    const token = `@${selection.target.handle || selection.target.name}`
    const nextText = `${text.slice(0, selection.start)}${token} ${text.slice(selection.end)}`
    const nextMentions = reconcileDesktopCoworkerMentions(text, nextText, mentions)
    nextMentions.push({ targetId: selection.target.agentId, token, start: selection.start, end: selection.start + token.length })
    nextMentions.sort((a, b) => a.start - b.start || a.end - b.end)
    return { text: nextText, mentions: nextMentions }
}

export function desktopCoworkerMentionFields(text: string, mentions: DesktopCoworkerMention[]): { coworkerMentions: DesktopCoworkerMention[] } {
    return { coworkerMentions: readMentions(text, mentions) }
}

export function desktopCoworkerMentionsFromMetadata(text: string, metadata: unknown): DesktopCoworkerMention[] {
    if (!metadata || typeof metadata !== 'object' || !('coworkerMentions' in metadata)) return []
    return readMentions(text, (metadata as { coworkerMentions?: unknown }).coworkerMentions)
}

export function revalidateDesktopCoworkerMentions(text: string, mentions: DesktopCoworkerMention[], targets: DesktopCoworkerCallTarget[]): DesktopCoworkerMentionRevalidation {
    const current = readMentions(text, mentions)
    if (current.length !== mentions.length) return { ok: false, code: 'range', error: 'A selected coworker mention was edited. Reinsert it before sending.' }
    const resolved: DesktopResolvedCoworkerMention[] = []
    for (const mention of current) {
        const target = targets.find(candidate => candidate.agentId === mention.targetId)
        if (!target || !target.enabled || !target.callable) {
            return { ok: false, code: 'target', error: 'A selected coworker is no longer available. Reinsert the mention before sending.' }
        }
        resolved.push({ ...mention, target })
    }
    return { ok: true, mentions: resolved }
}

export async function listDesktopCoworkerMentionTargets(agentId: string, options: { signal?: AbortSignal } = {}): Promise<DesktopCoworkerCallTarget[]> {
    const response = await fetch(`/api/desktop/coworkers/${encodeURIComponent(agentId)}/mentions`, { cache: 'no-store', signal: options.signal })
    const body = await response.json().catch(() => null)
    if (!response.ok || !body || !Array.isArray(body.targets)) throw new Error(typeof body?.error === 'string' ? body.error : 'Coworker suggestions are unavailable.')
    return body.targets as DesktopCoworkerCallTarget[]
}

export async function revalidateDesktopCoworkerMentionsAtSend(agentId: string, text: string, mentions: DesktopCoworkerMention[], options: { signal?: AbortSignal } = {}): Promise<DesktopCoworkerMentionRevalidation> {
    const targets = await listDesktopCoworkerMentionTargets(agentId, options)
    return revalidateDesktopCoworkerMentions(text, mentions, targets)
}

export type DesktopCoworkerMentionTargetStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error' | 'unavailable'

export function useDesktopCoworkerMentionTargets(agentId: string | null, options: { enabled?: boolean; refreshKey?: string } = {}) {
    const enabled = options.enabled ?? true
    const [status, setStatus] = useState<DesktopCoworkerMentionTargetStatus>(agentId && enabled ? 'loading' : 'idle')
    const [targets, setTargets] = useState<DesktopCoworkerCallTarget[]>([])
    const [targetError, setTargetError] = useState<string | null>(null)
    const [attempt, setAttempt] = useState(0)
    const owner = useRef<string | null>(null)
    const retryTargets = useCallback(() => setAttempt(current => current + 1), [])

    useEffect(() => {
        if (!agentId || !enabled) {
            owner.current = null
            setTargets([])
            setTargetError(null)
            setStatus('idle')
            return
        }
        const controller = new AbortController()
        if (owner.current !== agentId) {
            owner.current = agentId
            setTargets([])
        }
        setTargetError(null)
        setStatus('loading')
        void listDesktopCoworkerMentionTargets(agentId, { signal: controller.signal })
            .then(rows => {
                if (controller.signal.aborted || owner.current !== agentId) return
                setTargets(rows)
                setStatus(rows.length ? 'ready' : 'empty')
            })
            .catch(cause => {
                if (controller.signal.aborted || owner.current !== agentId) return
                setTargetError(cause instanceof Error ? cause.message : 'Coworker suggestions are unavailable.')
                setStatus(cause instanceof TypeError ? 'unavailable' : 'error')
            })
        return () => controller.abort()
    }, [agentId, enabled, attempt, options.refreshKey])

    return { status, targets, targetError, retryTargets }
}
