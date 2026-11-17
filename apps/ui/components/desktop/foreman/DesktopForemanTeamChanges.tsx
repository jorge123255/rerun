'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DesktopForemanChatRef } from '@rerun/contracts'

import { Button } from '@/components/ui/button'
import { applyTeamChanges, teamChangesClient, type TeamChangesAnswer, type TeamChangesPorts } from '@/lib/desktop/team-changes-client'

/**
 * The card for changes the Chief of Staff proposed to the team: switching coworkers on, a
 * permission, the GitHub sign-in, setup, a model. Every line is written by the app from the real
 * coworker, permission and model it resolved, and starts ticked; the person unticks what they do
 * not want and approves the rest with one click. Nothing changes before that click, and after it
 * each line says whether it worked.
 */
export function DesktopForemanTeamChanges({ chat, refreshKey, ports: given }: {
    chat: DesktopForemanChatRef
    /** Changes when the conversation does: the card is read again. */
    refreshKey?: string
    ports?: TeamChangesPorts
}) {
    const ports = useMemo(() => given ?? teamChangesClient({ workspaceId: chat.workspaceId, chatId: chat.chatId }), [given, chat.workspaceId, chat.chatId])
    const [answer, setAnswer] = useState<TeamChangesAnswer | null>(null)
    const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set())
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [hidden, setHidden] = useState<string | null>(null)
    const run = useRef(0)
    useEffect(() => {
        const mine = ++run.current
        ports.read().then(next => { if (run.current === mine) setAnswer(next) }).catch(() => {})
    }, [ports, refreshKey])
    const card = answer?.changes ?? null
    const id = card?.id
    useEffect(() => { setSkipped(new Set()); setError(null) }, [id])

    const act = useCallback((work: () => Promise<TeamChangesAnswer>) => {
        setBusy(true); setError(null); ++run.current
        work().then(setAnswer).catch(cause => setError(cause instanceof Error && cause.message ? cause.message : 'That did not go through. Try again.')).finally(() => setBusy(false))
    }, [])

    if (!card || card.state === 'dismissed' || hidden === card.id) return null
    const chosen = new Set(card.changes.filter(change => !skipped.has(change.key)).map(change => change.key))
    const failed = card.changes.filter(change => change.result && !change.result.ok).length
    const applied = card.changes.filter(change => change.result?.ok).length
    return (
        <section data-foreman-team-changes={card.state} aria-label="Proposed team changes" className="mx-3 mt-2 rounded-lg border bg-muted/30 text-xs">
            <div className="px-3 pt-2">
                <p className="font-medium">{card.state === 'shown' ? 'Your Chief of Staff proposes these changes' : failed ? `${applied} applied, ${failed} could not be applied` : `${applied} ${applied === 1 ? 'change' : 'changes'} applied`}</p>
                <p className="mt-0.5 text-muted-foreground">{card.summary}</p>
            </div>
            <ul className="mt-1.5 max-h-[32vh] space-y-1 overflow-y-auto px-3">
                {card.changes.map(change => (
                    <li key={change.key} data-team-change={change.key} className="flex items-start gap-2 leading-relaxed">
                        {card.state === 'shown'
                            ? <input type="checkbox" className="mt-0.5 size-3 shrink-0 accent-current" aria-label={change.label} checked={!skipped.has(change.key)} disabled={busy}
                                onChange={event => setSkipped(current => { const next = new Set(current); if (event.target.checked) next.delete(change.key); else next.add(change.key); return next })} />
                            : <span aria-hidden className={`mt-0.5 w-3 shrink-0 text-center ${change.result ? change.result.ok ? 'text-emerald-500' : 'text-destructive' : 'text-muted-foreground'}`}>{change.result ? change.result.ok ? '✓' : '×' : '–'}</span>}
                        <span className="min-w-0 flex-1">
                            {change.label}
                            {change.caution && card.state === 'shown' && <span className="block text-[11px] text-muted-foreground">{change.caution}</span>}
                            {change.result && !change.result.ok && <span role="alert" className="block text-[11px] text-destructive">{change.result.message ?? 'This change was refused.'}</span>}
                            {card.state !== 'shown' && !change.result && <span className="block text-[11px] text-muted-foreground">Left out.</span>}
                        </span>
                    </li>
                ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                {card.state === 'shown' ? <>
                    <Button type="button" size="sm" data-team-changes-apply loading={busy} disabled={busy || chosen.size === 0}
                        onClick={() => act(() => applyTeamChanges(ports, card, chosen))}>
                        {chosen.size === card.changes.length ? `Apply all ${chosen.size}` : `Apply ${chosen.size} of ${card.changes.length}`}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" data-team-changes-dismiss disabled={busy} onClick={() => act(() => ports.settle(card.id, 'dismissed', []))}>Dismiss</Button>
                    <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">Nothing changes until you apply.</span>
                </> : <Button type="button" size="sm" variant="ghost" onClick={() => setHidden(card.id)}>Hide</Button>}
            </div>
            {error && <p role="alert" className="px-3 pb-2 text-destructive">{error}</p>}
        </section>
    )
}
