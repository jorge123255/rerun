'use client'

import { PageColumn } from '@/components/brain/BrainPageParts'
import { BrainTopBar } from '@/components/brain/BrainTopBar'
import { ProposalList } from '@/components/brain/proposals/ProposalList'
import { Button } from '@/components/ui/button'
import { DesktopBrainRequestError } from '@/lib/desktop/brain-pages'
import { decideDesktopBrainProposal, desktopBrainProposalDecisionInputSchema, desktopBrainProposalViewSchema, listDesktopBrainProposals, type DesktopBrainProposalView } from '@/lib/desktop/brain-proposals'
import { hydrateBrainUiState, readBrainUiState, writeBrainUiState } from '@/lib/desktop/brain-ui-state'
import { holdDraftAdmission } from '@/lib/desktop/draft-writes'
import { InboxIcon } from '@/lib/icons'
import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { toast } from 'sonner'

const PENDING_KEY = 'proposal-decision'
const pendingSchema = z.object({ proposal: desktopBrainProposalViewSchema, decision: z.enum(['accept', 'dismiss']), input: desktopBrainProposalDecisionInputSchema })
type Pending = z.infer<typeof pendingSchema>
function messageOf(error: unknown): string { return error instanceof Error && error.message ? error.message : 'Company brain proposals could not be opened.' }

export function DesktopBrainProposalsPanel({ onOpenPage, onDecided }: { onOpenPage: (slug: string) => void; onDecided?: (change: { slug: string; requestId: string }) => void }) {
    const [proposals, setProposals] = useState<DesktopBrainProposalView[] | null>(null)
    const [ready, setReady] = useState(false)
    const [storageFailure, setStorageFailure] = useState<string | null>(null)
    const [failed, setFailed] = useState<string | null>(null)
    const [busyId, setBusyId] = useState<string | null>(null)
    const [pending, setPending] = useState<Pending | null>(null)
    const [reloadKey, setReloadKey] = useState(0)
    const active = useRef(false)
    const alive = useRef(false)
    const reload = useCallback(() => setReloadKey(key => key + 1), [])

    useEffect(() => {
        alive.current = true
        let cancelled = false
        void hydrateBrainUiState().then(() => {
            if (cancelled) return
            const value = readBrainUiState(PENDING_KEY)
            if (value !== null) setPending(pendingSchema.parse(value))
            setReady(true)
        }).catch(() => {
            if (!cancelled) setStorageFailure('The saved Brain decision could not be read. It has been left unchanged.')
        })
        return () => { cancelled = true; alive.current = false }
    }, [])
    useEffect(() => {
        const controller = new AbortController()
        void listDesktopBrainProposals('proposed', controller.signal)
            .then(list => { if (!controller.signal.aborted) { setProposals(list); setFailed(null) } })
            .catch(error => { if (!controller.signal.aborted) setFailed(messageOf(error)) })
        return () => controller.abort()
    }, [reloadKey])

    const send = async (attempt: Pending) => {
        if (active.current || storageFailure || !ready) return
        active.current = true
        setBusyId(attempt.proposal.id)
        const release = holdDraftAdmission()
        try {
            // Persist before dispatch. Closing/restarting after an ambiguous response keeps the
            // exact reviewed decision identity, so Retry replays its durable engine receipt.
            setPending(attempt)
            await writeBrainUiState(PENDING_KEY, attempt)
            const result = await decideDesktopBrainProposal(attempt.proposal.id, attempt.decision, attempt.input)
            await writeBrainUiState(PENDING_KEY, null)
            if (!alive.current) return
            setPending(null)
            setFailed(null)
            setProposals(current => current?.filter(item => item.id !== result.proposal.id) ?? current)
            onDecided?.({ slug: result.slug, requestId: result.requestId })
            if (result.applied) toast.success(`${attempt.proposal.title} saved`, { description: 'Saved to the company brain.', action: { label: 'Open', onClick: () => onOpenPage(result.slug) } })
            reload()
        } catch (error) {
            const definitive = error instanceof DesktopBrainRequestError && [400, 404, 409, 413, 415].includes(error.status)
            if (definitive) {
                try {
                    await writeBrainUiState(PENDING_KEY, null)
                    if (alive.current) { setPending(null); reload() }
                } catch { if (alive.current) setStorageFailure('The decision was refused, but its saved retry could not be cleared. Reopen the Brain to retry.') }
            }
            if (alive.current) { setFailed(messageOf(error)); toast.error(messageOf(error)) }
        } finally { release(); active.current = false; if (alive.current) setBusyId(null) }
    }
    const decide = (id: string, decision: 'accept' | 'dismiss') => {
        if (pending || active.current || storageFailure || !ready) return
        const proposal = proposals?.find(item => item.id === id)
        if (!proposal) return
        void send({ proposal, decision, input: { reviewedFingerprint: proposal.reviewedFingerprint, expectedPageHash: proposal.expectedPageHash, requestId: crypto.randomUUID() } })
    }
    return (
        <>
            <BrainTopBar crumbs={[{ label: 'Proposals', icon: InboxIcon }]} />
            <div className="min-h-0 flex-1 overflow-y-auto">
                <PageColumn className="max-w-[820px]">
                    <h1 className="text-[2rem] font-semibold leading-tight tracking-tight">Proposals</h1>
                    <p className="mt-1 text-sm text-muted-foreground">What your coworkers learned about the company and want written down. Accept a change to save it, or dismiss it to keep the page as it is.</p>
                    <div className="mt-8">
                        {storageFailure && <p role="alert" className="mb-3 text-sm text-destructive">{storageFailure}</p>}
                        {failed && <p role="alert" className="mb-3 text-sm text-destructive">{failed}</p>}
                        {pending && !busyId && <div className="mb-4 rounded-lg border p-3 text-sm">The decision for “{pending.proposal.title}” needs confirmation. <Button size="sm" variant="outline" onClick={() => void send(pending)}>Retry decision</Button></div>}
                        {!proposals && failed ? <Button size="sm" variant="outline" onClick={reload}>Retry loading</Button> : <div inert={Boolean(pending || busyId || storageFailure || !ready)}>
                            <ProposalList proposals={proposals} busyId={busyId} onAccept={proposal => decide(proposal.id, 'accept')} onDismiss={proposal => decide(proposal.id, 'dismiss')} onOpenPage={onOpenPage} />
                        </div>}
                    </div>
                </PageColumn>
            </div>
        </>
    )
}
