'use client'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconBadge } from '@/components/ui/icon-badge'
import { CheckIcon } from '@/lib/icons'
import type { ServiceTransportClient } from '@/lib/desktop/service-transports-client'
import { SERVICE_TRANSPORT_COPY, type ServiceTransportRef, type ServiceTransportControl, type ServiceTransportSnapshot } from '@rerun/contracts'
export type ServiceTransportConnectionProps = { account: ServiceTransportRef; name: string; client: ServiceTransportClient }
export function ServiceTransportConnection(props: ServiceTransportConnectionProps) { return <Connection key={JSON.stringify(props.account)} {...props} /> }
function Connection({ account, name, client }: ServiceTransportConnectionProps) {
    const [snapshot, setSnapshot] = useState<ServiceTransportSnapshot | null>(null), [pending, setPending] = useState<ServiceTransportControl | null>(null)
    const [error, setError] = useState(''), [busy, setBusy] = useState(false), active = useRef(new AbortController()), epoch = useRef(0), running = useRef(false)
    useEffect(() => {
        const controller = new AbortController(), current = ++epoch.current; active.current = controller
        // Both reads are passive. Reopening the Apps panel never reconnects or probes.
        void Promise.all([client.status(account, controller.signal), client.pending(account)]).then(([view, attempt]) => {
            if (!controller.signal.aborted && epoch.current === current) { setSnapshot(view); setPending(attempt) }
        }).catch(() => { if (!controller.signal.aborted && epoch.current === current) setError('Connection status unavailable. Retry Refresh.') })
        return () => { controller.abort(); ++epoch.current }
    }, [client, account.agentId, account.key, account.installationId, account.revision])
    async function perform(action: 'refresh' | 'reconcile' | 'retry' | Exclude<ServiceTransportControl['action'], 'status'>) {
        if (running.current) return
        running.current = true; setBusy(true); setError(''); const current = ++epoch.current, signal = active.current.signal
        try {
            const value = action === 'stop' ? await client.stop(account, signal) : action === 'retry' ? await client.retryConnection(account, signal) : action === 'refresh' ? await client.status(account, signal) : action === 'reconcile' && pending ? await client.reconcile(pending, signal)
                : await client.perform(account, action as Exclude<ServiceTransportControl['action'], 'status'>, signal)
            const attempt = await client.pending(account)
            if (!signal.aborted && epoch.current === current) { setSnapshot(value); setPending(attempt) }
        } catch {
            if (!signal.aborted && epoch.current === current) {
                setError('Acknowledgement unavailable. Reconcile this attempt before starting another operation.')
                try { const attempt = await client.pending(account); if (!signal.aborted && epoch.current === current) setPending(attempt) } catch { /* Keep the current attempt. */ }
            }
        } finally { if (epoch.current === current) { running.current = false; if (!signal.aborted) setBusy(false) } }
    }
    function stop() { active.current.abort(); active.current = new AbortController(); ++epoch.current; running.current = false; void perform('stop') }
    return <div className="min-w-0 space-y-3 break-words">
        <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{name}</span><span className="text-xs text-muted-foreground">{snapshot?.state ?? 'unchecked'}</span>
        </div>
        {snapshot?.failure && <p className="text-xs text-muted-foreground">{SERVICE_TRANSPORT_COPY[snapshot.failure]}</p>}
        {snapshot?.observation === 'probe' && <p className="text-xs text-muted-foreground">Connection checked. The temporary connection is closed.</p>}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void perform('refresh')}>Refresh</Button>
            {pending ? <>
                <Button size="sm" disabled={busy} onClick={() => void perform('reconcile')}>Reconcile</Button>
                {pending.action !== 'stop' && pending.action !== 'disconnect' && <Button size="sm" variant="outline" disabled={busy} onClick={() => void perform('retry')}>Retry connection</Button>}
                {(pending.action === 'stop' || pending.action === 'disconnect') && <Button size="sm" variant="outline" disabled={busy} onClick={() => void perform(pending.action === 'disconnect' ? 'disconnect' : 'stop')}>Retry Stop</Button>}
            </> : <>
                <Button size="sm" disabled={busy} onClick={() => void perform('probe')}>Check connection</Button>
                <Button size="sm" disabled={busy} onClick={() => void perform('reconnect')}>Reconnect</Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void perform('disconnect')}>Disconnect</Button>
            </>}
            <Button size="sm" variant="outline" onClick={stop}>Stop</Button>
        </div>
        <p className="text-xs text-muted-foreground">Saved setup is not current health. Stop closes this account’s local connection; a remote action may already have run.</p>
    </div>
}
export function ServiceTransportInstalledReceipt({ name, toolNames }: { name: string; toolNames?: string[] }) {
    return <div className="min-w-0 space-y-1 break-words"><div className="flex items-center gap-2 text-sm"><IconBadge tone="green" icon={CheckIcon} glow={false} /><span className="font-medium">{name} installed</span></div>
        {!!toolNames?.length && <p className="text-xs text-muted-foreground">Available on the next turn: {toolNames.join(', ')}</p>}
    </div>
}
