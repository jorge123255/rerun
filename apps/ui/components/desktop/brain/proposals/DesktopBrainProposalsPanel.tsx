'use client'

import { PageColumn } from '@/components/brain/BrainPageParts'
import { BrainTopBar } from '@/components/brain/BrainTopBar'
import { ProposalList } from '@/components/brain/proposals/ProposalList'
import { decideDesktopBrainProposal, listDesktopBrainProposals } from '@/lib/desktop/brain-proposals'
import { InboxIcon } from '@/lib/icons'
import type { BrainProposal } from '@rerun/contracts'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

// The hosted proposal inbox, reading this Mac's proposal store. Accept records the decision and
// does not write the page. A failed load stays an error instead of the empty "All caught up" state.

function messageOf(error: unknown): string {
    return error instanceof Error && error.message ? error.message : 'Company brain proposals could not be opened.'
}

export function DesktopBrainProposalsPanel({ onOpenPage }: { onOpenPage: (slug: string) => void }) {
    const [proposals, setProposals] = useState<BrainProposal[] | null>(null)
    const [failed, setFailed] = useState<string | null>(null)
    const [busyId, setBusyId] = useState<string | null>(null)
    const [reloadKey, setReloadKey] = useState(0)

    const reload = useCallback(() => setReloadKey(key => key + 1), [])

    useEffect(() => {
        const controller = new AbortController()
        setProposals(null)
        setFailed(null)
        void listDesktopBrainProposals('proposed', controller.signal)
            .then(list => { if (!controller.signal.aborted) setProposals(list) })
            .catch(error => {
                if (controller.signal.aborted) return
                setProposals(null)
                setFailed(messageOf(error))
            })
        return () => controller.abort()
    }, [reloadKey])

    const decide = async (proposal: BrainProposal, decision: 'accept' | 'dismiss') => {
        setBusyId(proposal.id)
        try {
            await decideDesktopBrainProposal(proposal.id, decision)
            if (decision === 'accept') {
                toast.success(`${proposal.title} accepted`, {
                    description: 'The page was not written. The Brain page store still has to apply this decision.',
                    action: { label: 'Open', onClick: () => onOpenPage(proposal.slug) },
                })
            }
            setProposals(current => current?.filter(item => item.id !== proposal.id) ?? current)
        } catch (error) {
            toast.error(messageOf(error))
            reload()
        } finally { setBusyId(null) }
    }

    return (
        <>
            <BrainTopBar crumbs={[{ label: 'Proposals', icon: InboxIcon }]} />
            <div className="min-h-0 flex-1 overflow-y-auto">
                <PageColumn className="max-w-[820px]">
                    <h1 className="text-[2rem] font-semibold leading-tight tracking-tight">Proposals</h1>
                    <p className="mt-1 text-sm text-muted-foreground">What your coworkers learned about the company and want written down. Accept and dismiss record the decision. The page is not written from here.</p>
                    <div className="mt-8">
                        {failed ? <p className="text-sm text-destructive">{failed}</p> : (
                            <ProposalList
                                proposals={proposals}
                                busyId={busyId}
                                onAccept={proposal => void decide(proposal, 'accept')}
                                onDismiss={proposal => void decide(proposal, 'dismiss')}
                                onOpenPage={onOpenPage}
                            />
                        )}
                    </div>
                </PageColumn>
            </div>
        </>
    )
}
