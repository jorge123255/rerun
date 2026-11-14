'use client'
import { useEffect, useState } from 'react'
import { REMOTE_MACHINE_COPY, type DesktopRemoteMachineBridge } from '@rerun/contracts'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { DialogHeaderBar } from '@/components/dialogs/DialogHeaderBar'
import { ServerIcon } from '@/lib/icons'
import { SkeletonList } from '@/components/ui/skeleton'
import { ScrollFade } from '@rerun/ui/primitives'
import { useRemoteMachines, type RemoteMachineActorSeed } from '@/lib/desktop/remote-machines/use-remote-machines'
import { RemoteMachinePairing } from './RemoteMachinePairing'
import { RemoteMachineRow } from './RemoteMachineRow'
import { LocalMachineRow } from './LocalMachineRow'

/**
 * The Servers dialog of the Mac app, faithful to the original: the machine your
 * coworkers run on, one per workspace. It reads state on open, shows the
 * server row or the add form, and every change (pair, replace, select, remove)
 * is an explicit human action carrying the exact connection revision. Nothing
 * connects as an effect of viewing the dialog; a lost acknowledgement keeps the
 * typed address and key and its request identity for retry.
 */
type RemoteMachinesDialogProps = { open: boolean; onOpenChange: (open: boolean) => void; actor: RemoteMachineActorSeed; bridge?: DesktopRemoteMachineBridge }
export function RemoteMachinesDialog(props: RemoteMachinesDialogProps) {
    if (!props.open) return null
    const { actor } = props
    return <RemoteMachinesPanel key={JSON.stringify([actor.installId, actor.workspaceId, actor.launchNonce, actor.rendererEpoch])} {...props} />
}
function RemoteMachinesPanel({ open, onOpenChange, actor, bridge }: RemoteMachinesDialogProps) {
    const machines = useRemoteMachines(actor, { active: open, bridge })
    const [pairingOpen, setPairingOpen] = useState(false)
    const [removeOpen, setRemoveOpen] = useState(false)
    const [replaceDraft, setReplaceDraft] = useState<{ address: string; apiKey: string } | null>(null)

    const snapshot = machines.snapshot

    useEffect(() => {
        setPairingOpen(false)
        setRemoveOpen(false)
        setReplaceDraft(null)
    }, [open])

    const connect = async (address: string, apiKey: string) => {
        if (snapshot?.connection) {
            setReplaceDraft({ address, apiKey })
            return
        }
        const settled = await machines.pair(address, apiKey)
        if (settled?.snapshot?.connection) setPairingOpen(false)
    }

    const confirmReplace = async () => {
        const connection = snapshot?.connection
        if (!connection || !replaceDraft) return
        const settled = await machines.replace(connection.connectionId, connection.revision, replaceDraft.address, replaceDraft.apiKey)
        setReplaceDraft(null)
        if (settled?.snapshot?.connection) setPairingOpen(false)
    }

    const confirmRemove = () => {
        const connection = snapshot?.connection
        if (!connection) return
        void machines.remove(connection.connectionId, connection.revision)
        setRemoveOpen(false)
    }

    const connection = snapshot?.connection ?? null
    const busy = machines.busy
    const error = machines.error

    let body
    if (machines.unavailable) {
        body = (
            <div className="space-y-3">
                <p role="alert" className="px-1 text-sm text-muted-foreground">{error ?? 'The machine service is unavailable right now.'}</p>
                <div className="flex flex-wrap justify-end gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => void machines.refresh()}>Refresh</Button>
                </div>
            </div>
        )
    } else if (!snapshot) {
        body = <SkeletonList rows={2} />
    } else if (pairingOpen || !connection) {
        body = (
            <RemoteMachinePairing
                hasConnection={!!connection}
                busy={busy}
                error={error}
                pendingRetry={machines.pendingRetry !== null}
                onConnect={connect}
                onRetry={() => void machines.retry()}
                onSettle={() => void machines.settle()}
                onBack={connection ? () => setPairingOpen(false) : undefined}
                onCancel={() => void machines.cancel()}
            />
        )
    } else {
        body = (
            <>
                {error && <p role="alert" className="px-1 text-xs text-destructive">{error}</p>}
                <RemoteMachineRow
                    snapshot={snapshot}
                    busy={busy}
                    onRemove={() => setRemoveOpen(true)}
                    onReplace={() => setPairingOpen(true)}
                    onSelect={() => void machines.select(connection.connectionId, connection.revision)}
                    onRecover={() => void machines.recover()}
                    onCancel={() => void machines.cancel()}
                    onHealthCheck={() => void machines.healthRefresh()}
                />
            </>
        )
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex flex-col sm:max-h-[85dvh] sm:max-w-lg sm:overflow-hidden">
                <DialogHeaderBar icon={ServerIcon} title={REMOTE_MACHINE_COPY.title} description={REMOTE_MACHINE_COPY.description} />
                <ScrollFade className="-mx-1 min-h-0 flex-1 px-1 py-1">
                    <div className="space-y-4">{snapshot?.localRuntime && !snapshot.selected && <LocalMachineRow runtime={snapshot.localRuntime} />}{body}</div>
                </ScrollFade>
                <ConfirmDialog
                    open={removeOpen}
                    onOpenChange={setRemoveOpen}
                    title={REMOTE_MACHINE_COPY.removeTitle}
                    description={REMOTE_MACHINE_COPY.removeDescription}
                    confirmLabel={REMOTE_MACHINE_COPY.removeLabel}
                    pending={busy?.kind === 'remove'}
                    onConfirm={event => {
                        event.preventDefault()
                        confirmRemove()
                    }}
                />
                <ConfirmDialog
                    open={replaceDraft !== null}
                    onOpenChange={openReplace => {
                        if (!openReplace) setReplaceDraft(null)
                    }}
                    title="Replace this server?"
                    description="This workspace already has a server. Replacing it stops the current connection and points your coworkers at the new machine. Everything they know stays on the old machine: attach it again to get them back."
                    confirmLabel="Replace"
                    confirmVariant="default"
                    pending={busy?.kind === 'replace'}
                    onConfirm={event => {
                        event.preventDefault()
                        confirmReplace()
                    }}
                />
            </DialogContent>
        </Dialog>
    )
}
