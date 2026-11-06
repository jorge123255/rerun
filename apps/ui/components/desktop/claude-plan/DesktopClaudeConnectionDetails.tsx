'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ModelBuckets } from '@/components/connections/ModelBuckets'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { PanelScroller } from '@/components/ui/panel-list'
import { ProviderIcon } from '@/lib/engine/provider-icons'
import type { BoxConnection } from '@/lib/engine/types'
import { AlertTriangle, Trash2Icon } from '@/lib/icons'
import type { DesktopClaudePlanRuntime } from '@/lib/desktop/claude-plan-client/use-desktop-claude-plan'
import { DesktopClaudePlanSteps } from './DesktopClaudePlanSteps'

export function DesktopClaudeConnectionDetails({ connection, account, defaultModel, runtime, onOpenAuthorization, onModelsChange, onDisconnect, onBack }: {
    connection: BoxConnection
    account?: { label: string; unavailable?: boolean }
    defaultModel: string | null
    runtime: DesktopClaudePlanRuntime
    onOpenAuthorization: (url: string) => void
    onModelsChange: (models: string[]) => void
    onDisconnect: (connectionId: string) => Promise<{ success: boolean; error?: string } | void> | { success: boolean; error?: string } | void
    onBack: () => void
}) {
    const owner = useMemo(() => ({ live: true }), [connection.id, runtime])
    const active = useRef(owner); active.current = owner
    const [state, setState] = useState({ owner, pending: false, error: null as string | null })
    const { pending, error } = state.owner === owner ? state : { pending: false, error: null }
    useEffect(() => { owner.live = true; return () => { owner.live = false } }, [owner])
    const rejected = connection.credentialRejected
    const connected = connection.connected && !rejected && !account?.unavailable
    const remove = async () => {
        setState({ owner, pending: true, error: null })
        try {
            const result = await onDisconnect(connection.id)
            if (!owner.live || active.current !== owner) return
            if (result && !result.success) { setState({ owner, pending: false, error: result.error ?? 'Failed to remove the connection.' }); return }
            onBack()
        } catch (cause) {
            if (owner.live && active.current === owner) setState({ owner, pending: false, error: cause instanceof Error ? cause.message : 'Failed to remove the connection.' })
        }
    }
    return <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b px-4 py-3">
            <ProviderIcon provider="claude" className="size-5" />
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{connection.name}</p>
                <p className="truncate text-xs text-muted-foreground">{connected ? 'Connected' : account?.unavailable ? 'Connection unavailable' : rejected ? 'Sign-in rejected' : 'Sign-in expired'}</p>
            </div>
            {account && <span className="truncate text-xs text-muted-foreground">{account.label}</span>}
        </div>
        <PanelScroller className="space-y-5 p-4">
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            {!connected && <div className="space-y-5">
                <div className="flex items-start gap-3 rounded-md border border-orange-500/30 bg-orange-500/5 px-3 py-2.5">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-orange-500" />
                    <p className="text-xs">{rejected ? 'This sign-in was rejected. Coworkers using it are stopped until you sign in again.' : account?.unavailable ? 'This connection is unavailable. Check the desktop credential store and try again.' : 'This sign-in expired. Coworkers using it are stopped until you sign in again.'}</p>
                </div>
                <DesktopClaudePlanSteps runtime={runtime} onOpenAuthorization={onOpenAuthorization} onDone={() => {}} lastStep={() => ({ title: 'Your coworkers start again' })} />
            </div>}
            <ModelBuckets connection={connection} defaultModel={defaultModel} onModelsChange={onModelsChange} />
        </PanelScroller>
        <div className="space-y-2 border-t p-3">
            <ConfirmDialog title={`Remove ${connection.name}?`} confirmLabel="Remove" description="The Claude credential is removed from this Mac. This cannot be undone." pending={pending} onConfirm={() => void remove()}>
                <Button type="button" size="sm" variant="destructive"><Trash2Icon />Remove {connection.name}</Button>
            </ConfirmDialog>
        </div>
    </div>
}
