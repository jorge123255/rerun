'use client'

import { useEffect, useRef, useState } from 'react'
import { Badge } from '@rerun/ui/primitives'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { TooltipLabeled } from '@/components/ui/tooltip'
import { desktopMcpSseSnapshotSchema, type DesktopMcpSseRef, type DesktopMcpSseRequest, type DesktopMcpSseSnapshot } from '@rerun/contracts'

export type SseStatusDriver = {
    read(reference: DesktopMcpSseRef, signal: AbortSignal): Promise<DesktopMcpSseSnapshot>
    operate(request: DesktopMcpSseRequest, signal: AbortSignal): Promise<DesktopMcpSseSnapshot>
}
export function DesktopMcpSseStatusBadge({ snapshot, loading }: { snapshot?: DesktopMcpSseSnapshot; loading: boolean }) {
    if (!snapshot) return loading ? <Skeleton className="h-4 w-16 rounded-full"/> : null
    if (snapshot.state === 'connected') return <Badge size="xs" tone="green" glow={false}>Connected · {snapshot.tools.length} {snapshot.tools.length === 1 ? 'tool' : 'tools'}</Badge>
    if (snapshot.state === 'needs_auth') return <Badge size="xs" tone="orange" glow={false}>Sign-in needed</Badge>
    if (snapshot.state === 'closing') return <Badge size="xs" tone="orange" glow={false}>Close unconfirmed</Badge>
    if (snapshot.state === 'error') return <TooltipLabeled label={snapshot.message ?? 'The server did not answer.'}><Badge size="xs" tone="red" glow={false}>Unreachable</Badge></TooltipLabeled>
    return <Badge size="xs" tone="neutral" glow={false}>{snapshot.state === 'unchecked' ? 'Not checked' : snapshot.state === 'unsupported' ? 'Unsupported' : snapshot.state === 'connecting' ? 'Connecting' : 'Disconnected'}</Badge>
}
export function DesktopMcpSseConnection(props: { reference: DesktopMcpSseRef; driver: SseStatusDriver; onEdit(): void }) {
    const key = JSON.stringify(props.reference)
    return <Connection key={key} {...props}/>
}
function Connection({ reference, driver, onEdit }: { reference: DesktopMcpSseRef; driver: SseStatusDriver; onEdit(): void }) {
    const [snapshot, setSnapshot] = useState<DesktopMcpSseSnapshot>(), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('')
    const controller = useRef<AbortController | null>(null), epoch = useRef(0), working = useRef(false), retries = useRef(new Map<string, string>())
    const initialReference = useRef(reference).current
    function verified(value: DesktopMcpSseSnapshot) {
        const parsed = desktopMcpSseSnapshotSchema.parse(value)
        if (parsed.agentId !== initialReference.agentId || parsed.serverId !== initialReference.serverId || parsed.name !== initialReference.name || parsed.expectedRevision !== initialReference.expectedRevision) throw new Error('Stale MCP status')
        return parsed
    }
    useEffect(() => {
        const stop = new AbortController(); controller.current = stop; const current = ++epoch.current
        void driver.read(initialReference, stop.signal).then(value => { if (!stop.signal.aborted && current === epoch.current) setSnapshot(verified(value)) })
            .catch(() => { if (!stop.signal.aborted && current === epoch.current) setError('Could not read MCP status. Retry without reconnecting.') })
            .finally(() => { if (!stop.signal.aborted && current === epoch.current) setLoading(false) })
        return () => { epoch.current++; stop.abort(); controller.current = null }
    }, [driver, initialReference])
    async function action(operation: DesktopMcpSseRequest['operation']) {
        if (working.current || !controller.current) return
        const stop = controller.current, current = ++epoch.current
        working.current = true; setBusy(true); setError('')
        const requestId = retries.current.get(operation) ?? crypto.randomUUID(); retries.current.set(operation, requestId)
        try {
            const value = operation === 'status' ? await driver.read(initialReference, stop.signal) : await driver.operate({ ...initialReference, operation, requestId }, stop.signal)
            if (stop.signal.aborted || current !== epoch.current) return
            setSnapshot(verified(value))
            if (value.state !== 'closing') retries.current.delete(operation)
        } catch { if (!stop.signal.aborted && current === epoch.current) setError('MCP operation failed or acknowledgement is unknown. Retry the same operation; no tool call will be replayed.') }
        finally { working.current = false; if (!stop.signal.aborted && current === epoch.current) { setBusy(false); setLoading(false) } }
    }
    return <div className="min-w-0 space-y-2 border-b border-border p-3">
        <div className="flex flex-wrap items-center gap-2"><Button variant="ghost" className="max-w-full truncate" onClick={onEdit}>{reference.name}</Button><DesktopMcpSseStatusBadge snapshot={snapshot} loading={loading}/></div>
        <p className="break-all text-xs text-muted-foreground">sse · {snapshot?.endpointDisplay || 'HTTPS endpoint'}</p>
        {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
        {snapshot?.message && <p className="break-words text-xs text-muted-foreground">{snapshot.message}</p>}
        {snapshot?.observation === 'probe' && <p className="text-xs text-muted-foreground">Probe completed; its temporary connection is closed.</p>}
        <div className="flex flex-wrap gap-2"><Button size="sm" className="min-h-9" disabled={busy} onClick={() => void action('connect')}>Connect</Button>
            <Button size="sm" className="min-h-9" variant="outline" disabled={busy} onClick={() => void action('probe')}>Probe</Button>
            <Button size="sm" className="min-h-9" variant="outline" disabled={busy} onClick={() => void action('disconnect')}>{snapshot?.state === 'closing' ? 'Retry disconnect' : 'Disconnect'}</Button>
            <Button size="sm" className="min-h-9" variant="ghost" disabled={busy} onClick={() => void action('status')}>Refresh status</Button></div>
        {snapshot?.state === 'connected' && <p className="break-words text-xs">{snapshot.tools.length} tools: {snapshot.tools.map(tool => `${reference.name}_${tool.name}`).join(', ')}</p>}
    </div>
}
