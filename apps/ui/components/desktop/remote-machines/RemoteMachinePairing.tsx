'use client'
import { useState } from 'react'
import { REMOTE_MACHINE_COPY } from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2Icon } from '@/lib/icons'
import type { RemoteMachineBusy } from '@/lib/desktop/remote-machines/use-remote-machines'

function SectionTitle({ children }: { children: string }) {
    return <h3 className="px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{children}</h3>
}

/**
 * Adding a server. On the Mac the machine is one you already run: enter its
 * HTTPS address and the RERUN_API_KEY it prints. The key stays masked and never
 * leaves the form except inside the pair/replace command. The hosted pairing
 * token flow has no local port on the Mac, so "Add server" explains that
 * truthfully instead of pretending. Nothing connects as an effect of viewing or
 * restoring this form — only the explicit Connect click submits.
 */
export function RemoteMachinePairing({
    hasConnection,
    busy,
    error,
    pendingRetry,
    onConnect,
    onRetry,
    onSettle,
    onBack,
}: {
    hasConnection: boolean
    busy: RemoteMachineBusy | null
    error: string | null
    pendingRetry: boolean
    onConnect: (address: string, apiKey: string) => void
    onRetry: () => void
    onSettle: () => void
    onBack?: () => void
}) {
    const [mode, setMode] = useState<'menu' | 'manual' | 'tokenUnsupported'>('menu')
    const [address, setAddress] = useState('')
    const [apiKey, setApiKey] = useState('')
    const connecting = busy?.kind === 'pair' || busy?.kind === 'replace'
    const canConnect = address.trim().length > 0 && apiKey.length > 0 && !connecting

    if (mode === 'manual') {
        return (
            <section className="min-w-0 space-y-3">
                <SectionTitle>{REMOTE_MACHINE_COPY.manualTitle}</SectionTitle>
                {error && <p role="alert" className="px-1 text-xs text-destructive">{error}</p>}
                {pendingRetry && (
                    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-2">
                        <p className="px-1 text-xs text-muted-foreground">The app could not confirm the last change. Your address and key are kept in this form; retrying uses the same request identity, so nothing is applied twice.</p>
                        <div className="flex flex-wrap justify-end gap-2">
                            <Button size="sm" variant="outline" disabled={busy !== null} onClick={onSettle}>Check acknowledgement</Button>
                            <Button size="sm" variant="outline" disabled={busy !== null} onClick={onRetry}>{busy?.kind === 'retry' && <Loader2Icon className="animate-spin" />}Retry</Button>
                        </div>
                    </div>
                )}
                <Input label={REMOTE_MACHINE_COPY.address} placeholder="http://192.168.1.20:3000" value={address} onChange={event => setAddress(event.target.value)} />
                <Input label={REMOTE_MACHINE_COPY.key} placeholder="RERUN_API_KEY of the engine" value={apiKey} onChange={event => setApiKey(event.target.value)} type="password" />
                <div className="flex flex-wrap justify-end gap-2">
                    {onBack && (
                        <Button variant="ghost" disabled={busy !== null} onClick={onBack}>
                            Back
                        </Button>
                    )}
                    <Button onClick={() => onConnect(address.trim(), apiKey)} disabled={!canConnect}>
                        {connecting && <Loader2Icon className="animate-spin" />}
                        {REMOTE_MACHINE_COPY.connect}
                    </Button>
                </div>
            </section>
        )
    }

    if (mode === 'tokenUnsupported') {
        return (
            <section className="min-w-0 space-y-3">
                <SectionTitle>Add a server</SectionTitle>
                <p className="px-1 text-sm text-muted-foreground">Pairing tokens are part of hosted Rerun and have no local port on the Mac. To use a machine you already run, enter its address and key instead.</p>
                <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="ghost" onClick={() => setMode('menu')}>Back</Button>
                    <Button onClick={() => setMode('manual')}>{REMOTE_MACHINE_COPY.manualTitle}</Button>
                </div>
            </section>
        )
    }

    return (
        <section className="min-w-0 space-y-3">
            <SectionTitle>Add a server</SectionTitle>
            <p className="px-1 text-sm text-muted-foreground">Your coworkers run on a machine you own. On the Mac, connect to a machine you already run by entering its address and the key it prints.</p>
            {error && <p role="alert" className="px-1 text-xs text-destructive">{error}</p>}
            {pendingRetry && (
                <div className="space-y-2 rounded-md border border-border bg-muted/30 p-2">
                    <p className="px-1 text-xs text-muted-foreground">A previous change was not confirmed. Retrying uses the same request identity, so nothing is applied twice.</p>
                    <div className="flex flex-wrap justify-end gap-2">
                        <Button size="sm" variant="outline" disabled={busy !== null} onClick={onSettle}>Check acknowledgement</Button>
                        <Button size="sm" variant="outline" disabled={busy !== null} onClick={onRetry}>{busy?.kind === 'retry' && <Loader2Icon className="animate-spin" />}Retry</Button>
                    </div>
                </div>
            )}
            {hasConnection && <p className="px-1 text-xs text-amber-600">This workspace already has a server. Connecting replaces it after you confirm.</p>}
            <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" onClick={() => setMode('manual')}>
                    Enter address and key
                </Button>
                <Button onClick={() => setMode('tokenUnsupported')}>Add server</Button>
            </div>
        </section>
    )
}
