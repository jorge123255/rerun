'use client'

import { useMemo, useRef, useState } from 'react'
import type { ConnectionsList } from '@rerun/contracts'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { createDesktopClaudePlanClient } from '@/lib/desktop/claude-plan-client/runtime'
import { DesktopClaudePlanSteps } from './DesktopClaudePlanSteps'

export function DesktopClaudeLogin({ connected, rejected, onProviders }: { connected: boolean; rejected?: boolean; onProviders: (providers: ConnectionsList) => void }) {
    const callback = useRef(onProviders)
    callback.current = onProviders
    const runtime = useMemo(() => createDesktopClaudePlanClient(value => callback.current(value)), [])
    const [pending, setPending] = useState(false), [error, setError] = useState('')
    const disconnect = async () => {
        setPending(true); setError('')
        try {
            const signal = AbortSignal.timeout(35_000)
            const snapshot = await runtime.reconcile(null, signal)
            const pending = snapshot.pendingAttempt?.phase ?? snapshot.phase
            if (pending === 'waiting' || pending === 'checking') throw new Error('Cancel the pending sign-in before disconnecting.')
            await runtime.disconnect!(snapshot.attemptId, signal)
        } catch { setError('Could not disconnect Claude. Check its saved state and try again.') }
        finally { setPending(false) }
    }
    return <div className="space-y-3">
        <p className="text-sm text-muted-foreground">Use your Claude subscription for coworker chat.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {connected && !rejected ? <>
            <p role="status" className="text-sm">Claude is connected.</p>
            <ConfirmDialog title="Disconnect Claude?" description="Coworkers using this connection will need another model or a new Claude sign-in. Your chats stay here." confirmLabel="Disconnect" pending={pending} onConfirm={() => void disconnect()}>
                <Button type="button" variant="outline" disabled={pending}>Disconnect Claude</Button>
            </ConfirmDialog>
        </> : <>
            {rejected && <p role="alert" className="text-sm text-destructive">Claude rejected this sign-in. Connect again to continue.</p>}
            <DesktopClaudePlanSteps reconnect={!!rejected} runtime={runtime} onOpenAuthorization={url => { window.open(url, '_blank', 'noopener,noreferrer') }} onDone={() => {}}
                lastStep={() => ({ title: 'Choose a Claude model above', remark: 'All set!' })} />
        </>}
    </div>
}
