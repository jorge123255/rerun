'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopCoworkerCallTarget } from '@rerun/contracts'
import { revalidateDesktopCoworkerMentions, type DesktopCoworkerMention, type DesktopCoworkerMentionRevalidation } from '@/components/desktop/mentions/coworker-mention-model'

export * from '@/components/desktop/mentions/coworker-mention-model'

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
    const lifecycle = JSON.stringify([agentId, enabled, attempt, options.refreshKey])
    const identity = useRef({ lifecycle, generation: 0 })
    if (identity.current.lifecycle !== lifecycle) identity.current = { lifecycle, generation: identity.current.generation + 1 }
    const generation = identity.current.generation
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
                if (controller.signal.aborted || identity.current.generation !== generation || owner.current !== agentId) return
                setTargets(rows)
                setStatus(rows.length ? 'ready' : 'empty')
            })
            .catch(cause => {
                if (controller.signal.aborted || identity.current.generation !== generation || owner.current !== agentId) return
                setTargetError(cause instanceof Error ? cause.message : 'Coworker suggestions are unavailable.')
                setStatus(cause instanceof TypeError ? 'unavailable' : 'error')
            })
        return () => controller.abort()
    }, [agentId, enabled, attempt, options.refreshKey, generation])

    const currentOwner = owner.current === agentId && (!agentId || enabled)
    return {
        status: currentOwner ? status : agentId && enabled ? 'loading' : 'idle',
        targets: currentOwner ? targets : [],
        targetError: currentOwner ? targetError : null,
        retryTargets,
    }
}
