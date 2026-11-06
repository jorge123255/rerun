'use client'

import type { DesktopCoworkerShareImportInput } from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import type { DesktopCoworkerShareAttempts } from '@/lib/desktop/coworker-share/attempts'
import type { DesktopCoworkerShareClient } from '@/lib/desktop/coworker-share/client'
import { DesktopCoworkerManifestReview } from './DesktopCoworkerManifestReview'
import { DesktopCoworkerShareSafety } from './DesktopCoworkerShareSafety'
import { useDesktopCoworkerImportFlow } from './useDesktopCoworkerImportFlow'

export function DesktopCoworkerImportDialog({ open, onOpenChange, client, attempts, targetWorkspaceId, snapshotId, onOpenCoworker }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    client: DesktopCoworkerShareClient
    attempts: DesktopCoworkerShareAttempts
    targetWorkspaceId: number
    snapshotId: string
    onOpenCoworker?: (agentId: string) => void
}) {
    return <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl">
            {open && <Body client={client} attempts={attempts} targetWorkspaceId={targetWorkspaceId} snapshotId={snapshotId} onOpenCoworker={onOpenCoworker} onClose={() => onOpenChange(false)} />}
        </DialogContent>
    </Dialog>
}

function Body({ client, attempts, targetWorkspaceId, snapshotId, onOpenCoworker, onClose }: Omit<Parameters<typeof DesktopCoworkerImportDialog>[0], 'open' | 'onOpenChange'> & { onClose: () => void }) {
    const flow = useDesktopCoworkerImportFlow({ client, attempts, targetWorkspaceId, snapshotId })
    const name = flow.manifest?.coworkers[0]?.name ?? 'this coworker'
    return <>
        <div className="border-b px-6 pt-6 pb-4">
            <DialogTitle>{flow.importedAgentId ? `Added ${name}` : `Add ${name}`}</DialogTitle>
            <DialogDescription>{flow.importedAgentId
                ? 'The fresh copy is disconnected, has empty history and has every permission off.'
                : 'Review this exact portable file before adding a fresh copy to your board.'}</DialogDescription>
        </div>
        <div className="max-h-[55dvh] overflow-y-auto px-6 py-4">
            {flow.importedAgentId ? <div className="flex flex-col gap-4">
                <DesktopCoworkerShareSafety exclusions={flow.manifest?.coworkers[0]?.exclusions ?? null} />
                <p role="status" className="text-xs text-muted-foreground">Fresh coworker ID <code>{flow.importedAgentId}</code>. No source chat or unsent draft was changed.</p>
            </div> : flow.manifest ? <div className="flex flex-col gap-4">
                <DesktopCoworkerManifestReview manifest={flow.manifest} approved={flow.approved} onApprovedChange={flow.setApproved} disabled={flow.busy} />
                <PendingImports pending={flow.pendingImports} busy={flow.busy} onRecover={input => void flow.recoverImport(input)} />
            </div> : <p role="status" className="text-sm text-muted-foreground">{flow.loading ? 'Reading the portable file…' : 'The portable file is unavailable.'}</p>}
            {flow.error && <p role="alert" className="mt-4 text-xs text-destructive">{flow.error}</p>}
        </div>
        <DialogFooter className="m-0 px-6 py-4">
            {flow.importedAgentId ? <>
                <Button type="button" variant="outline" onClick={onClose}>Done</Button>
                {onOpenCoworker && <Button type="button" onClick={() => onOpenCoworker(flow.importedAgentId!)}>Open fresh copy</Button>}
            </> : <>
                <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
                <Button type="button" disabled={flow.busy || flow.loading || !flow.manifest || !flow.approved} onClick={() => void flow.importFresh()}>{flow.busy ? 'Adding the fresh copy…' : 'Add a fresh copy'}</Button>
            </>}
        </DialogFooter>
    </>
}

function PendingImports({ pending, busy, onRecover }: { pending: DesktopCoworkerShareImportInput[]; busy: boolean; onRecover: (input: DesktopCoworkerShareImportInput) => void }) {
    if (pending.length === 0) return null
    return <section className="rounded-md border border-amber-500/30 p-3">
        <p className="text-xs text-amber-600">An earlier import acknowledgement is uncertain. Recover the same fresh copy rather than creating another.</p>
        <div className="mt-2 flex flex-wrap gap-2">{pending.map(input => <Button type="button" variant="outline" size="sm" key={input.requestId} disabled={busy} onClick={() => onRecover(input)}>Recover import {input.requestId.slice(0, 8)}</Button>)}</div>
    </section>
}
