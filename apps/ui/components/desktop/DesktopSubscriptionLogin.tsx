import { useEffect, useRef, useState } from 'react'
import {
    desktopSubscriptionLoginSnapshot,
    type DesktopSubscriptionLoginAction,
    type DesktopSubscriptionLoginSnapshot,
    type DesktopSubscriptionProvider,
} from '@rerun/contracts'
import { DesktopDeviceCode } from './DesktopDeviceCode'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const names = { 'grok-build': 'Grok Build', 'kimi-code': 'Kimi Code', devin: 'Devin' } as const
const providers = ['grok-build', 'kimi-code', 'devin'] as const
const errorText = {
    failed: 'Sign-in failed. Try again.',
    expired: 'The sign-in attempt expired. Request a new code.',
    unconfirmed: 'The sign-in process did not close cleanly. Restart Rerun before trying again.',
}

async function read(action?: DesktopSubscriptionLoginAction, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(action?.action === 'refresh-models' ? 190_000 : 15_000)
    const response = await fetch('/api/desktop/subscription-login', {
        method: action ? 'POST' : 'GET',
        headers: action ? { 'Content-Type': 'application/json' } : undefined,
        body: action ? JSON.stringify(action) : undefined,
        cache: 'no-store',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (!response.ok) throw new Error('Sign-in could not be confirmed.')
    // An answer without a provider this app knows means that provider is not offered there.
    const body = await response.json() as Record<string, unknown> | null
    return desktopSubscriptionLoginSnapshot.parse({ devin: { phase: 'unavailable' }, ...body })
}

export function DesktopSubscriptionLogin({ only, onConnectionsChanged }: { only?: DesktopSubscriptionProvider; onConnectionsChanged?: () => void } = {}) {
    const [snapshot, setSnapshot] = useState<DesktopSubscriptionLoginSnapshot | null>(null)
    const [pending, setPending] = useState(false)
    // Which provider's model list is being read: Devin asks each of about 150 models for its effort levels.
    const [loadingModels, setLoadingModels] = useState<string | null>(null)
    useEffect(() => { if (!pending) setLoadingModels(null) }, [pending])
    const [statusReadFailed, setStatusReadFailed] = useState(false)
    const [actionError, setActionError] = useState<string | null>(null)
    const error = actionError ?? (statusReadFailed ? 'Could not read subscription sign-in status.' : null)
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
                setStatusReadFailed(false)
                repeat = providers.some(provider => ['waiting', 'code', 'starting', 'cancelling'].includes(next[provider].phase))
            } catch {
                if (!controller.signal.aborted && revision.current === current) {
                    setStatusReadFailed(true)
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
        setActionError(null)
        try {
            const next = await read(action)
            setSnapshot(next)
            setStatusReadFailed(false)
            const state = next[action.provider]
            if (action.action === 'disconnect' ||
                (action.action === 'refresh-models' && state.phase === 'approved' && state.chatReady)) onConnectionsChanged?.()
        } catch {
            setActionError(action.action === 'refresh-models' ? 'Could not refresh subscription models. Try again.' : 'Could not confirm the sign-in change.')
        }
        finally { setPending(false) }
    }

    if (!snapshot) {
        if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>
        return only ? <p role="status" className="text-sm text-muted-foreground">Loading subscription sign-in status…</p> : null
    }
    if (only && snapshot[only].phase === 'unavailable') return <p role="status" className="text-sm text-muted-foreground">This subscription sign-in is unavailable.</p>
    if (!only && providers.every(provider => snapshot[provider].phase === 'unavailable')) return null
    return <div className="space-y-3">
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {(only ? [only] : providers).map(provider => {
            const state = snapshot[provider]
            if (state.phase === 'unavailable') return null
            const name = names[provider]
            const send = (action: DesktopSubscriptionLoginAction['action']) => { if (action === 'refresh-models') setLoadingModels(provider); void act({ provider, action }) }
            return <section key={provider} aria-label={name} className="space-y-3 rounded-xl border p-4">
                <h2 className="font-semibold">{name}</h2>
                {state.phase === 'waiting' ? <>
                    <p className="text-sm">Open the verification page and enter this one-time code.</p>
                    <DesktopDeviceCode key={state.userCode} code={state.userCode} label={`${name} device code`} />
                    <a className="text-sm font-medium underline" href={state.verificationUrl} target="_blank" rel="noreferrer">Open {name} verification</a>
                    <p role="status" className="text-xs text-muted-foreground">Waiting for approval</p>
                    <Button type="button" variant="outline" disabled={pending} onClick={() => send('cancel')}>Cancel sign-in</Button>
                </> : state.phase === 'code' ? <DevinCode name={name} url={state.verificationUrl} pending={pending}
                    onSubmit={code => void act({ provider, action: 'submit-code', code })} onCancel={() => send('cancel')} />
                : state.phase === 'starting' ? <>
                    <p role="status" className="text-sm">Requesting code…</p>
                    <Button type="button" variant="outline" disabled={pending} onClick={() => send('cancel')}>Cancel sign-in</Button>
                </> : state.phase === 'cancelling' ? <p role="status" className="text-sm">Cancelling sign-in…</p> : state.phase === 'approved' ? <>
                    <p role="status" className="text-sm">{state.chatReady
                        ? 'Ready for text chat. Choose a model in the coworker’s chat or as the workspace default.'
                        : state.models?.length ? 'Models loaded. Coworker chat is unavailable in this build.'
                            : 'Sign-in approval saved.'}</p>
                    {state.models?.length && <details className="text-sm">
                        <summary className="cursor-pointer font-medium">{state.models.length} available {state.models.length === 1 ? 'model' : 'models'}</summary>
                        <ul className="mt-2 space-y-2 pl-4">
                            {state.models.map(model => <li key={model.id}>
                                <span>{model.label}</span>
                                {model.reasoning && <span className="block text-xs text-muted-foreground">
                                    Reasoning {model.reasoning.supported.join(', ')} · Default {model.reasoning.default}
                                </span>}
                            </li>)}
                        </ul>
                    </details>}
                    {state.canRefreshModels && <Button type="button" variant="outline" disabled={pending} onClick={() => send('refresh-models')}>
                        {state.models?.length ? 'Refresh models' : 'Load models'}
                    </Button>}
                    {pending && loadingModels === provider && <p role="status" className="text-sm text-muted-foreground">Reading {name}’s models and their effort levels. This can take a minute or two.</p>}
                    <Button type="button" variant="outline" disabled={pending} onClick={() => send('disconnect')}>Disconnect {name} from Rerun</Button>
                </> : <>
                    {state.phase === 'error' && <p role="alert" className="text-sm text-destructive">{errorText[state.reason]}</p>}
                    <Button type="button" disabled={pending || (state.phase === 'error' && state.reason === 'unconfirmed')} onClick={() => send('start')}>Sign in with {name}</Button>
                </>}
            </section>
        })}
    </div>
}

// Devin signs in on its own page, which then shows a code. Pasted here, it finishes the sign-in
// inside the app's private Devin profile.
function DevinCode({ name, url, pending, onSubmit, onCancel }: { name: string; url: string; pending: boolean; onSubmit(code: string): void; onCancel(): void }) {
    const [code, setCode] = useState('')
    const [sent, setSent] = useState(false)
    return <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (code.trim()) { setSent(true); onSubmit(code.trim()) } }}>
        <p className="text-sm">Sign in on {name}’s page, then paste the code it shows here.</p>
        <a className="text-sm font-medium underline" href={url} target="_blank" rel="noreferrer">Open {name} sign-in</a>
        <div className="flex gap-2">
            <Input aria-label={`${name} sign-in code`} type="password" autoComplete="off" spellCheck={false} placeholder="Paste the code" value={code} disabled={sent}
                onChange={event => setCode(event.target.value)} />
            <Button type="submit" disabled={pending || sent || !code.trim()}>Finish sign-in</Button>
        </div>
        <p role="status" className="text-xs text-muted-foreground">{sent ? 'Checking the code…' : 'Waiting for the code'}</p>
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>Cancel sign-in</Button>
    </form>
}
