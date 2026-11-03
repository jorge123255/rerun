import { useEffect, useRef, useState } from 'react'
import type { ConnectionsList, DesktopCodexStatus } from '@rerun/contracts'
import { Button } from '@/components/ui/button'

type Action = 'start' | 'cancel' | 'logout' | 'refresh'
type Snapshot = { status: DesktopCodexStatus; providers: ConnectionsList }
async function read(action?: Action, signal?: AbortSignal): Promise<Snapshot> {
    const res = await fetch('/api/desktop/codex-login', action ? {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }), signal,
    } : { signal, cache: 'no-store' })
    if (!res.ok) throw new Error('Cannot reach the local Codex runner. Try again.')
    return res.json()
}

export function DesktopCodexLogin({ connected, modelCount, onProviders }: {
    connected: boolean
    modelCount: number
    onProviders: (providers: ConnectionsList) => void
}) {
    const [status, setStatus] = useState<DesktopCodexStatus | null>(null)
    const [pendingAction, setPendingAction] = useState<Action | null>(null)
    const busy = pendingAction !== null
    const [error, setError] = useState('')
    const [notice, setNotice] = useState('')
    const revision = useRef(0)

    const shouldPoll = !status || status.phase === 'waiting'
    const refreshOnOpen = !status && connected
    useEffect(() => {
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout>
        async function poll() {
            const at = revision.current
            try {
                const snap = await read(refreshOnOpen ? 'refresh' : undefined, controller.signal)
                if (controller.signal.aborted || at !== revision.current) return
                setStatus(snap.status)
                setError('')
                if (snap.status.phase !== 'waiting') onProviders(snap.providers)
            } catch {
                if (!controller.signal.aborted && at === revision.current) {
                    if (refreshOnOpen) setStatus({ phase: 'connected', catalogError: 'Could not refresh the Codex models. You can still use the saved list.' })
                    else setError('Cannot read ChatGPT sign-in status.')
                }
            }
            if (!controller.signal.aborted && at === revision.current && shouldPoll) timer = setTimeout(poll, 1800)
        }
        if (!busy && shouldPoll) void poll()
        return () => { controller.abort(); clearTimeout(timer) }
    }, [busy, shouldPoll, refreshOnOpen, onProviders])

    async function act(action: Action) {
        revision.current++
        setPendingAction(action); setError(''); setNotice('')
        try {
            const snap = await read(action)
            setStatus(snap.status); onProviders(snap.providers)
            if (action === 'refresh' && snap.status.phase === 'connected' && !snap.status.catalogError) setNotice('Model list refreshed.')
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'ChatGPT sign-in failed.')
        } finally { setPendingAction(null) }
    }

    const refreshing = pendingAction === 'refresh' || refreshOnOpen
    return <div className="space-y-3">
        <p className="text-sm text-muted-foreground">Use your ChatGPT subscription for coworker chat. Signing in sets a Codex model as your workspace default.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {status?.phase === 'error' && <p role="alert" className="text-sm text-destructive">{status.message}</p>}
        {status?.phase === 'waiting' ? <div className="space-y-3 rounded-lg border p-3">
            <p className="text-sm">Open the OpenAI verification page and enter this one-time code.</p>
            <output aria-label="Device code" className="block select-all font-mono text-xl font-semibold tracking-widest">{status.userCode}</output>
            <a className="text-sm font-medium underline" href={status.verificationUrl} target="_blank" rel="noreferrer">Open OpenAI verification</a>
            <p role="status" className="text-xs text-muted-foreground">Waiting for approval. If prompted, enable device-code authorization in ChatGPT security settings.</p>
            <Button type="button" variant="outline" disabled={busy} onClick={() => void act('cancel')}>Cancel sign-in</Button>
        </div> : status?.phase === 'connected' || refreshOnOpen ? <>
            <p role="status" className="text-sm">ChatGPT is connected.</p>
            <p className="text-sm text-muted-foreground">{modelCount} {modelCount === 1 ? 'model available' : 'models available'} for this account.</p>
            {status?.phase === 'connected' && status.catalogError && <p role="alert" className="text-sm text-destructive">{status.catalogError}</p>}
            {notice && <p role="status" className="text-sm">{notice}</p>}
            <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={busy || refreshing} onClick={() => void act('refresh')}>
                    {refreshing ? 'Refreshing models…' : 'Refresh models'}
                </Button>
                <Button type="button" variant="outline" disabled={busy} onClick={() => void act('logout')}>Sign out of ChatGPT</Button>
            </div>
        </> : <Button type="button" disabled={busy || (!status && !error)} onClick={() => void act('start')}>{busy ? 'Requesting code…' : 'Sign in with ChatGPT'}</Button>}
    </div>
}
