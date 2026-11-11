import { useEffect, useRef, useState } from 'react'
import {
    desktopSubscriptionLoginSnapshot,
    type DesktopSubscriptionLoginAction,
    type DesktopSubscriptionLoginSnapshot,
} from '@rerun/contracts'
import { Button } from '@/components/ui/button'

const names = { 'grok-build': 'Grok Build', 'kimi-code': 'Kimi Code' } as const
const providers = ['grok-build', 'kimi-code'] as const
const errorText = {
    failed: 'Sign-in failed. Try again.',
    expired: 'The sign-in attempt expired. Request a new code.',
    unconfirmed: 'The sign-in process did not close cleanly. Restart Rerun before trying again.',
}

async function read(action?: DesktopSubscriptionLoginAction, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(action?.action === 'refresh-models' ? 45_000 : 15_000)
    const response = await fetch('/api/desktop/subscription-login', {
        method: action ? 'POST' : 'GET',
        headers: action ? { 'Content-Type': 'application/json' } : undefined,
        body: action ? JSON.stringify(action) : undefined,
        cache: 'no-store',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (!response.ok) throw new Error('Sign-in could not be confirmed.')
    return desktopSubscriptionLoginSnapshot.parse(await response.json())
}

export function DesktopSubscriptionLogin({ onConnectionsChanged }: { onConnectionsChanged?: () => void } = {}) {
    const [snapshot, setSnapshot] = useState<DesktopSubscriptionLoginSnapshot | null>(null)
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const revision = useRef(0)

    useEffect(() => {
        if (pending) return
        const controller = new AbortController()
        const current = revision.current
        let timer: ReturnType<typeof setTimeout>
        async function poll() {
            let repeat = false
            try {
                const next = await read(undefined, controller.signal)
                if (controller.signal.aborted || revision.current !== current) return
                setSnapshot(next)
                repeat = providers.some(provider => ['waiting', 'starting', 'cancelling'].includes(next[provider].phase))
            } catch {
                if (!controller.signal.aborted && revision.current === current) {
                    setError('Could not read subscription sign-in status.')
                    repeat = true
                }
            }
            if (repeat) timer = setTimeout(poll, 1800)
        }
        void poll()
        return () => { controller.abort(); clearTimeout(timer) }
    }, [pending])

    async function act(action: DesktopSubscriptionLoginAction) {
        revision.current++
        setPending(true)
        setError(null)
        try {
            setSnapshot(await read(action))
            if (action.action === 'refresh-models' || action.action === 'disconnect') onConnectionsChanged?.()
        } catch {
            setError(action.action === 'refresh-models' ? 'Could not refresh subscription models. Try again.' : 'Could not confirm the sign-in change.')
        }
        finally { setPending(false) }
    }

    if (!snapshot || providers.every(provider => snapshot[provider].phase === 'unavailable')) return null
    return <div className="space-y-3">
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {providers.map(provider => {
            const state = snapshot[provider]
            if (state.phase === 'unavailable') return null
            const name = names[provider]
            const send = (action: DesktopSubscriptionLoginAction['action']) => void act({ provider, action })
            return <section key={provider} aria-label={name} className="space-y-3 rounded-xl border p-4">
                <h2 className="font-semibold">{name}</h2>
                {state.phase === 'waiting' ? <>
                    <p className="text-sm">Open the verification page and enter this one-time code.</p>
                    <output aria-label={`${name} device code`} className="block select-all font-mono text-xl font-semibold tracking-widest">{state.userCode}</output>
                    <a className="text-sm font-medium underline" href={state.verificationUrl} target="_blank" rel="noreferrer">Open {name} verification</a>
                    <p role="status" className="text-xs text-muted-foreground">Waiting for approval</p>
                    <Button type="button" variant="outline" disabled={pending} onClick={() => send('cancel')}>Cancel sign-in</Button>
                </> : state.phase === 'starting' ? <>
                    <p role="status" className="text-sm">Requesting code…</p>
                    <Button type="button" variant="outline" disabled={pending} onClick={() => send('cancel')}>Cancel sign-in</Button>
                </> : state.phase === 'cancelling' ? <p role="status" className="text-sm">Cancelling sign-in…</p> : state.phase === 'approved' ? <>
                    <p role="status" className="text-sm">{state.models?.length
                        ? 'Ready for text chat. Choose a model in the coworker’s chat or as the workspace default.'
                        : state.canRefreshModels ? 'Sign-in approval saved. Load models to use this subscription in chat.'
                            : 'Sign-in approval saved. Coworker chat is pending in this build.'}</p>
                    {state.canRefreshModels && <Button type="button" variant="outline" disabled={pending} onClick={() => send('refresh-models')}>
                        {state.models?.length ? 'Refresh models' : 'Load models'}
                    </Button>}
                    <Button type="button" variant="outline" disabled={pending} onClick={() => send('disconnect')}>Disconnect {name} from Rerun</Button>
                </> : <>
                    {state.phase === 'error' && <p role="alert" className="text-sm text-destructive">{errorText[state.reason]}</p>}
                    <Button type="button" disabled={pending || (state.phase === 'error' && state.reason === 'unconfirmed')} onClick={() => send('start')}>Sign in with {name}</Button>
                </>}
            </section>
        })}
    </div>
}
