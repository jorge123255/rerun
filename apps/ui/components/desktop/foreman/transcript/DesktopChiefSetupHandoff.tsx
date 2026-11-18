'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { DesktopQuestionCard } from '../../DesktopQuestionCard'
import { useDesktopInboxPeek } from '../../useDesktopInboxPeek'
import type { ForemanHistoryPart } from './parts'

type SetupPart = Extract<ForemanHistoryPart, { kind: 'owner-setup' }>
export type OpenOwnerSetup = (target: { agentId: string; sessionId: string }) => Promise<void>
const changed = 'This setup has changed. Open the coworker from the board to see its current step.'

// Opening or answering goes through the owner's current setup claim. History can never reopen a
// chat by itself, and the Chief's own session and provider receive none of the owner's answer.
async function checkSetup(target: SetupPart, signal: AbortSignal) {
    const response = await fetch(`/api/desktop/coworkers/${encodeURIComponent(target.agentId)}/setup?observe=1`, {
        cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    })
    if (!response.ok) throw new Error('Could not check this coworker’s setup. Try again.')
    const view = await response.json()
    signal.throwIfAborted()
    if (view?.required !== true || view.pending !== true || view.skipped !== false || view.completedAt !== null || view.sessionId !== target.sessionId)
        throw new Error(changed)
}

export function DesktopChiefSetupHandoff({ target, open }: { target: SetupPart; open: OpenOwnerSetup }) {
    const lifetime = useRef<AbortController | null>(null)
    const [busy, setBusy] = useState(false)
    const [reviewing, setReviewing] = useState(false)
    const [sent, setSent] = useState<'answer' | 'cancel' | null>(null)
    const [error, setError] = useState('')
    const { peek, answer } = useDesktopInboxPeek(target.sessionId, reviewing)
    useEffect(() => {
        const owner = new AbortController()
        lifetime.current = owner
        return () => owner.abort()
    }, [target.sessionId, target.questionId])

    const review = async (showQuestion: boolean) => {
        const signal = lifetime.current?.signal
        if (busy || !signal || signal.aborted) return
        setBusy(true)
        setError('')
        try {
            await checkSetup(target, signal)
            if (showQuestion) setReviewing(true)
            else await open({ agentId: target.agentId, sessionId: target.sessionId })
        } catch (cause) {
            if (!signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not open this setup.')
        } finally { if (!signal.aborted) setBusy(false) }
    }
    const question = peek.state === 'ready' && peek.question?.id === target.questionId && !peek.approval ? peek.question : null
    return <div className="space-y-2">
        {target.questionId && !reviewing && !sent && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void review(true)}>Review question from {target.coworker}</Button>}
        {sent ? <p role="status" className="text-xs">{sent === 'cancel' ? 'Question dismissed' : 'Answer sent'} for {target.coworker}.</p>
            : reviewing && (question ? <DesktopQuestionCard key={question.id} question={question} onAnswer={async payload => {
                const signal = lifetime.current?.signal
                if (!signal || signal.aborted) throw new Error(changed)
                await checkSetup(target, signal)
                const outcome = await answer({ kind: 'question', payload })
                if (outcome !== 'sent') throw new Error(outcome === 'stale' ? changed : 'Could not confirm the answer. Check the original setup chat.')
                if (!signal.aborted) setSent(payload.action)
            }} /> : <p role="status" className="text-xs">{peek.state === 'loading' ? 'Loading question…' : 'The original question is no longer available here.'}</p>)}
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void review(false)}>Open setup for {target.coworker}</Button>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
}
