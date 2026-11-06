'use client'
import type { ReactNode } from 'react'
import { Badge, type BadgeTone } from '@rerun/ui/primitives'
import type { DesktopRemoteConnection, DesktopRemoteHealth, DesktopRemoteSnapshot } from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { PanelRow } from '@/components/ui/panel-row'
import { Loader2Icon, ServerIcon } from '@/lib/icons'
import type { RemoteMachineBusy } from '@/lib/desktop/remote-machines/use-remote-machines'

/** Truthful health presentation: one label/tone per canonical health state. */
export const REMOTE_HEALTH_PRESENTATION: Record<DesktopRemoteHealth['state'], { label: string; tone: BadgeTone }> = {
    not_checked: { label: 'Not checked', tone: 'neutral' },
    connected: { label: 'Connected', tone: 'green' },
    unreachable: { label: 'Unreachable', tone: 'red' },
    auth_needed: { label: 'Needs a key', tone: 'orange' },
    identity_changed: { label: 'Identity changed', tone: 'red' },
    unsupported: { label: 'Unsupported version', tone: 'neutral' },
    cancelled: { label: 'Checking stopped', tone: 'neutral' },
}

export function remoteMachineDescription(connection: DesktopRemoteConnection): string {
    const { address, health } = connection
    switch (health.state) {
        case 'connected':
            return `${address} · ${health.activeAgents ?? 0} coworkers running${health.commit ? ` · ${health.commit.slice(0, 7)}` : ''}`
        case 'unreachable':
            return `${address} · the app cannot reach it right now`
        case 'auth_needed':
            return `${address} · the app reached it, but the key was refused`
        case 'identity_changed':
            return `${address} · the machine identity changed; review it before reconnecting`
        case 'unsupported':
            return `${address} · this server does not provide a verifiable workspace identity`
        case 'cancelled':
            return `${address} · checking stopped`
        default:
            return `${address} · health not checked yet`
    }
}

/** The one server of this workspace: status badge, description and connection actions. */
export function RemoteMachineRow({
    snapshot,
    busy,
    onRemove,
    onReplace,
    onSelect,
    onRecover,
    onCancel,
    onHealthCheck,
}: {
    snapshot: DesktopRemoteSnapshot
    busy: RemoteMachineBusy | null
    onRemove: () => void
    onReplace: () => void
    onSelect: () => void
    onRecover: () => void
    onCancel: () => void
    onHealthCheck: () => void
}) {
    const connection = snapshot.connection
    if (!connection) return null
    const presentation = REMOTE_HEALTH_PRESENTATION[connection.health.state]
    const verifiedConnected = snapshot.selected && snapshot.runtimeState === 'connected'
    const label = connection.health.state === 'connected' && !verifiedConnected ? snapshot.selected ? 'Not connected' : 'Not in use' : presentation.label
    const tone = connection.health.state === 'connected' && !verifiedConnected ? 'neutral' : presentation.tone
    const recovering = !!snapshot.openReceipt
    const occupied = busy !== null
    const meta = (
        <Badge size="xs" fill="soft" tone={tone} glow={false}>
            {label}
        </Badge>
    )

    let actions: ReactNode
    if (recovering) {
        actions = (
            <>
                <Button type="button" variant="outline" size="sm" disabled={occupied} onClick={onRecover}>
                    {busy?.kind === 'recover' && <Loader2Icon className="size-3.5 animate-spin" />}
                    Retry recovery
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={busy?.kind === 'cancel'} onClick={onCancel}>
                    Cancel
                </Button>
            </>
        )
    } else {
        actions = (
            <>
                {(
                    <Button type="button" variant="ghost" size="sm" disabled={occupied} onClick={onHealthCheck}>
                        {busy?.kind === 'health' && <Loader2Icon className="size-3.5 animate-spin" />}
                        Check again
                    </Button>
                )}
                {!snapshot.selected && (
                    <Button type="button" variant="outline" size="sm" disabled={occupied} onClick={onSelect}>
                        {busy?.kind === 'select' && <Loader2Icon className="size-3.5 animate-spin" />}
                        Use this connection
                    </Button>
                )}
                <Button type="button" variant="outline" size="sm" disabled={occupied} onClick={onReplace}>
                    Replace
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={occupied} onClick={onRemove}>
                    {busy?.kind === 'remove' && <Loader2Icon className="size-3.5 animate-spin" />}
                    Remove
                </Button>
            </>
        )
    }

    return (
        <PanelRow
            leading={<ServerIcon className="size-4 shrink-0 text-muted-foreground" />}
            title={snapshot.selected ? "This workspace's server" : "Saved server"}
            meta={meta}
            description={connection.health.state === 'connected' && !verifiedConnected ? `${connection.address} · last check succeeded${connection.health.checkedAt ? ` at ${new Date(connection.health.checkedAt).toLocaleString()}` : ''}` : remoteMachineDescription(connection)}
            footer={
                recovering ? (
                    <span className="flex items-center gap-1.5">
                        {busy?.kind === 'recover' ? 'Recovering the stalled change…' : 'The last change stalled after it closed the old connection. Recovery is needed before anything else runs.'}
                    </span>
                ) : busy ? (
                    <span className="flex items-center gap-1.5">
                        <Loader2Icon className="size-3 animate-spin" />
                        {busyLabel(busy.kind)}
                    </span>
                ) : undefined
            }
            actions={actions}
        />
    )
}

export function busyLabel(kind: RemoteMachineBusy['kind']): string {
    switch (kind) {
        case 'pair':
            return 'Connecting to the server…'
        case 'replace':
            return 'Replacing the server…'
        case 'remove':
            return 'Removing the connection…'
        case 'select':
            return 'Selecting this connection…'
        case 'health':
            return 'Checking the server…'
        case 'cancel':
            return 'Cancelling…'
        case 'recover':
            return 'Recovering…'
        case 'retry':
            return 'Retrying with the same request identity…'
    }
}
