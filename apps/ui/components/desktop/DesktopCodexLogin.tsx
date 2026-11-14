import { useEffect, useRef, useState } from 'react'
import type { ConnectionsList, DesktopCodexStatus } from '@rerun/contracts'
import { DesktopDeviceCode } from './DesktopDeviceCode'
import { Button } from '@/components/ui/button'
import { DESKTOP_CODEX_LOGIN_BUDGET_MS } from '@/lib/desktop/codex-login-budget'

type Action = 'start' | 'cancel' | 'logout' | 'refresh'
type Snapshot = { status: DesktopCodexStatus; providers: ConnectionsList | null }
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
    const [watchingStart, setWatchingStart] = useState(false)
    const revision = useRef(0)
    const watchUntil = useRef(0)
    const providersCallback = useRef(onProviders)
    useEffect(() => { providersCallback.current = onProviders }, [onProviders])

    const shouldPoll = watchingStart || !status || status.phase === 'waiting'
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
                if (snap.status.phase === 'idle' && watchingStart) {
                    if (Date.now() >= watchUntil.current) {
                        setWatchingStart(false)
                        setError('Cannot reach the local Codex runner. Try again.')
                    }
                } else {
                    if (watchingStart) setWatchingStart(false)
                    setError('')
                    if (snap.status.phase !== 'waiting' && snap.providers) providersCallback.current(snap.providers)
                }
            } catch {
                if (!controller.signal.aborted && at === revision.current && !(watchingStart && Date.now() < watchUntil.current)) {
                    if (refreshOnOpen) setStatus({ phase: 'connected', catalogError: 'Could not refresh the Codex models. You can still use the saved list.' })
                    else setError(watchingStart ? 'Cannot reach the local Codex runner. Try again.' : 'Cannot read ChatGPT sign-in status.')
                    if (watchingStart) setWatchingStart(false)
                }
            }
            if (!controller.signal.aborted && at === revision.current && shouldPoll) timer = setTimeout(poll, 1800)
        }
        if (!busy && shouldPoll) void poll()
        return () => { controller.abort(); clearTimeout(timer) }
    }, [busy, shouldPoll, refreshOnOpen, watchingStart])

    async function act(action: Action) {
        revision.current++
        setPendingAction(action); setError(''); setNotice('')
        try {
            const snap = await read(action)
            setStatus(snap.status)
            setWatchingStart(false)
            if (snap.status.phase !== 'waiting' && snap.providers) providersCallback.current(snap.providers)
            if (action === 'refresh' && snap.status.phase === 'connected' && !snap.status.catalogError) setNotice('Model list refreshed.')
        } catch (cause) {
            if (action === 'start') {
                watchUntil.current = Date.now() + DESKTOP_CODEX_LOGIN_BUDGET_MS
                setWatchingStart(true)
            } else setError(cause instanceof Error ? cause.message : 'ChatGPT sign-in failed.')
        } finally { setPendingAction(null) }
    }

    const refreshing = pendingAction === 'refresh' || refreshOnOpen
    const requesting = pendingAction === 'start' || watchingStart
    return <div className="space-y-3">
        <p className="text-sm text-muted-foreground">Use your ChatGPT subscription for coworker chat. Signing in sets a Codex model as your workspace default.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {status?.phase === 'error' && <p role="alert" className="text-sm text-destructive">{status.message}</p>}
        {status?.phase === 'waiting' ? <div className="space-y-3 rounded-lg border p-3">
            <p className="text-sm">Open the OpenAI verification page and enter this one-time code.</p>
            <DesktopDeviceCode key={status.userCode} code={status.userCode} label="Device code" />
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
        </> : <Button type="button" disabled={requesting || (!status && !error)} onClick={() => void act('start')}>{requesting ? 'Requesting code…' : 'Sign in with ChatGPT'}</Button>}
    </div>
}
