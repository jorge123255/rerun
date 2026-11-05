'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { MentionSkill } from '@/components/chat/MentionAutocomplete'
import { listCoworkerSkills } from '@/lib/desktop/coworker-skills'

/**
 * The `/` menu offers only what the authenticated per-coworker shelf exposes: the same
 * `GET /api/desktop/agents/:agentId/skills` read the Skills panel uses. The engine publishes
 * exactly this shelf (skill-publication.ts), so an inserted `/slug` always matches a skill the
 * granted coworker can actually read.
 *
 * A selection is text, never permission: inserting `/slug` writes the draft and nothing else.
 * The explicit `skills` grant and `tools.skills` are owned by the Tools panel and are untouched.
 */
export type DesktopSkillSuggestionStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error' | 'unavailable'

export type DesktopSkillSuggestionState = {
    status: DesktopSkillSuggestionStatus
    skills: MentionSkill[]
    error: string | null
    retry: () => void
}

/**
 * Reads the shelf for exactly one owner (`agentId`). The read is keyed to the owner: a response
 * that resolves after the owner changed, the hook closed, or a newer attempt started is discarded
 * (the AbortController aborts it and the owner check ignores anything that slips through), so
 * another coworker's skill list can never surface here.
 *
 * Query filtering is local over the already-read shelf, so a `/query` change starts no read and
 * has nothing to abort; only an owner, enablement or retry change re-reads. A failed refresh keeps
 * the last good shelf but reports the failure instead of pretending the list is current.
 */
export function useDesktopSkillSuggestions(agentId: string | null, options: { enabled?: boolean } = {}): DesktopSkillSuggestionState {
    const enabled = options.enabled ?? true
    const [status, setStatus] = useState<DesktopSkillSuggestionStatus>(agentId && enabled ? 'loading' : 'idle')
    const [skills, setSkills] = useState<MentionSkill[]>([])
    const [error, setError] = useState<string | null>(null)
    const [attempt, setAttempt] = useState(0)
    const retry = useCallback(() => setAttempt(current => current + 1), [])

    const ownerRef = useRef<string | null>(null)

    useEffect(() => {
        if (!agentId || !enabled) {
            ownerRef.current = null
            setSkills([])
            setError(null)
            setStatus('idle')
            return
        }
        const owner = agentId
        const controller = new AbortController()
        if (ownerRef.current !== owner) {
            ownerRef.current = owner
            setSkills([])
        }
        setError(null)
        setStatus('loading')
        void listCoworkerSkills(owner, { signal: controller.signal })
            .then(rows => {
                if (controller.signal.aborted || ownerRef.current !== owner) return
                setSkills(rows.map(row => ({ slug: row.slug, name: row.name, description: row.description || undefined })))
                setStatus(rows.length ? 'ready' : 'empty')
            })
            .catch(cause => {
                if (controller.signal.aborted || ownerRef.current !== owner) return
                const message = cause instanceof Error ? cause.message : 'Could not load skills. Try again.'
                setError(message)
                // A network refusal means the engine is unreachable; an answered error means the
                // route refused. Both keep the last good list so the menu does not blank out.
                setStatus(cause instanceof TypeError ? 'unavailable' : 'error')
            })
        return () => controller.abort()
    }, [agentId, enabled, attempt])

    return { status, skills, error, retry }
}
