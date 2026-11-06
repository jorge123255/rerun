'use client'

import * as React from 'react'
import type { DesktopCoworkerShareExportInput, DesktopCoworkerShareRevokeInput } from '@rerun/contracts'
import { Stripes } from '@rerun/ui/primitives'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { Icon } from '@/components/ui/icon'
import type { DesktopCoworkerShareAttempts } from '@/lib/desktop/coworker-share/attempts'
import type { DesktopCoworkerShareClient } from '@/lib/desktop/coworker-share/client'
import { desktopCoworkerShareConfirmationPlan, type DesktopCoworkerShareSectionBindings } from '@/lib/desktop/coworker-share/sections'
import { desktopCoworkerShareCarriedData } from '@/lib/desktop/coworker-share/state'
import { Link2 } from '@/lib/icons'
import { DesktopCoworkerManifestReview } from './DesktopCoworkerManifestReview'
import { DesktopCoworkerShareOptions, DesktopCoworkerShareOptionsSkeleton } from './DesktopCoworkerShareOptions'
import { DesktopCoworkerShareSafety } from './DesktopCoworkerShareSafety'
import { DesktopCoworkerShareSuccess } from './DesktopCoworkerShareSuccess'
import { useDesktopCoworkerShareFlow, type DesktopCoworkerShareFlow } from './useDesktopCoworkerShareFlow'

export function DesktopCoworkerShareDialog({ open, onOpenChange, client, attempts, workspaceId, agentId, agentName, sourceRevision, onPreviewImport, sectionBindings = null }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    client: DesktopCoworkerShareClient
    attempts: DesktopCoworkerShareAttempts
    workspaceId: number
    agentId: string
    agentName: string
    sourceRevision: string
    onPreviewImport?: (snapshotId: string) => void
    sectionBindings?: DesktopCoworkerShareSectionBindings | null
}) {
    return <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl">
            {open && <DesktopCoworkerShareBody client={client} attempts={attempts} workspaceId={workspaceId} agentId={agentId} agentName={agentName} sourceRevision={sourceRevision} sectionBindings={sectionBindings} onClose={() => onOpenChange(false)} onPreviewImport={onPreviewImport} />}
        </DialogContent>
    </Dialog>
}

function DesktopCoworkerShareBody({ client, attempts, workspaceId, agentId, agentName, sourceRevision, sectionBindings = null, onClose, onPreviewImport }: Omit<Parameters<typeof DesktopCoworkerShareDialog>[0], 'open' | 'onOpenChange'> & { onClose: () => void }) {
    const flow = useDesktopCoworkerShareFlow({ client, attempts, workspaceId, agentId, sourceRevision, sectionBindings })
    return <>
        <div className="relative flex flex-col items-center gap-3 px-6 pt-8 pb-6 text-center">
            <Stripes />
            <Icon icon={Link2} className="relative" />
            <div className="relative flex flex-col gap-1.5">
                <DialogTitle>{flow.step === 'success' ? 'Your portable coworker file' : `Share ${agentName}`}</DialogTitle>
                <DialogDescription>{flow.step === 'success'
                    ? 'Download it and send it to whoever should have a copy. Nothing was uploaded or posted.'
                    : 'Pick what travels with the copy. Everything that makes it a coworker already does.'}</DialogDescription>
            </div>
        </div>

        <div className="max-h-[55dvh] overflow-y-auto border-t border-border px-6 py-4">
            {flow.step === 'success' && flow.exported ? <DesktopCoworkerShareSuccess
                exported={flow.exported}
                downloadUrl={client.downloadUrl(flow.exported.result.manifest.packageKey)}
                onPreviewImport={() => onPreviewImport?.(flow.exported!.result.manifest.packageKey)}
                onWithdraw={() => { void flow.withdraw() }}
                onRecoverWithdrawal={() => { const pending = flow.pendingRevocations[0]; if (pending) void flow.recoverWithdrawal(pending) }}
                pendingRevocations={flow.pendingRevocations}
                withdrawn={flow.withdrawn}
                busy={flow.busy}
                onDone={onClose}
            /> : flow.step === 'review' && flow.reviewed ? <div className="flex flex-col gap-4">
                {flow.stale && <div role="alert" className="rounded-md border border-amber-500/30 p-3 text-xs text-amber-600">
                    The coworker changed or was deleted. This review cannot be exported. Your choices are kept for a new review.
                    <Button type="button" variant="outline" size="sm" className="mt-2" disabled={flow.busy} onClick={() => void flow.reviewContent()}>Review current content</Button>
                </div>}
                <DesktopCoworkerManifestReview
                    manifest={flow.reviewed.result.manifest}
                    archiveBytes={flow.reviewed.result.archiveBytes}
                    archiveSha256={flow.reviewed.result.archiveSha256}
                    sourceRevision={flow.reviewed.input.sourceRevision}
                    sectionReview={flow.reviewed.sections}
                    approved={flow.approved}
                    onApprovedChange={flow.setApproved}
                    disabled={flow.busy || flow.stale}
                />
            </div> : <div className="flex flex-col gap-4">
                {flow.loading ? <DesktopCoworkerShareOptionsSkeleton /> : flow.plan ? <DesktopCoworkerShareOptions plan={flow.plan} include={flow.include} sections={flow.sections} onChange={flow.setInclude} disabled={flow.busy} /> : null}
                {flow.plan?.warnings.map(warning => <p key={warning} className="text-xs text-muted-foreground">{warning}</p>)}
                <DesktopCoworkerShareSafety />
                <PendingExports pending={flow.pendingExports} busy={flow.busy} onRecover={input => void flow.recoverExport(input)} />
                <PendingRevocations pending={flow.pendingRevocations} busy={flow.busy} onRecover={input => void flow.recoverWithdrawal(input)} />
                {flow.withdrawn && <p role="status" className="text-xs text-muted-foreground">Local share withdrawn. Future downloads from Rerun are blocked; offline files and existing copies are unchanged.</p>}
            </div>}
            {flow.error && <p role="alert" className="mt-4 text-xs text-destructive">{flow.error}</p>}
        </div>

        {flow.step !== 'success' && <DialogFooter className="m-0 px-6 py-4">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            {flow.step === 'configure'
                ? <Button type="button" disabled={flow.busy || flow.loading || !flow.plan} onClick={() => void flow.reviewContent()}>{flow.busy ? 'Preparing the review…' : 'Review portable file'}</Button>
                : <CreatePortableFileButton flow={flow} agentName={agentName} />}
        </DialogFooter>}
    </>
}

function PendingExports({ pending, busy, onRecover }: { pending: DesktopCoworkerShareExportInput[]; busy: boolean; onRecover: (input: DesktopCoworkerShareExportInput) => void }) {
    if (pending.length === 0) return null
    return <section className="rounded-md border border-amber-500/30 p-3">
        <p className="text-xs text-amber-600">An earlier export acknowledgement is uncertain. Recover its exact receipt before creating another file.</p>
        <div className="mt-2 flex flex-wrap gap-2">{pending.map(input => <Button type="button" variant="outline" size="sm" key={input.requestId} disabled={busy} onClick={() => onRecover(input)}>Recover export {input.reviewId.slice(0, 8)}</Button>)}</div>
    </section>
}

function PendingRevocations({ pending, busy, onRecover }: { pending: DesktopCoworkerShareRevokeInput[]; busy: boolean; onRecover: (input: DesktopCoworkerShareRevokeInput) => void }) {
    if (pending.length === 0) return null
    return <section className="rounded-md border border-amber-500/30 p-3">
        <p className="text-xs text-amber-600">An earlier withdrawal acknowledgement is uncertain. Retry the exact request; no offline file can be recalled.</p>
        <div className="mt-2 flex flex-wrap gap-2">{pending.map(input => <Button type="button" variant="outline" size="sm" key={input.requestId} disabled={busy} onClick={() => onRecover(input)}>Recover withdrawal {input.snapshotId.slice(0, 8)}</Button>)}</div>
    </section>
}

function CreatePortableFileButton({ flow, agentName }: { flow: DesktopCoworkerShareFlow; agentName: string }) {
    const carried = flow.plan ? desktopCoworkerShareCarriedData(desktopCoworkerShareConfirmationPlan(flow.plan, flow.sections), flow.include) : []
    const button = <Button type="button" disabled={flow.busy || flow.stale || !flow.approved} onClick={carried.length ? undefined : () => void flow.exportShare()}>
        {flow.busy ? 'Packing the coworker…' : 'Create portable file'}
    </Button>
    if (!flow.plan || carried.length === 0) return button
    return <ConfirmDialog
        title={`Send ${agentName} with its data?`}
        description={`The copy will carry ${carried.join(', ')}. Anyone holding the portable file can read all of it. Withdrawing the local share cannot recall files already saved or imported.`}
        confirmVariant="default"
        confirmLabel="Create portable file"
        pending={flow.busy}
        onConfirm={() => void flow.exportShare()}
    >{button}</ConfirmDialog>
}
