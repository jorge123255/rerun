'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PanelList, PanelSection } from '@/components/ui/panel-list'
import { PanelRow } from '@/components/ui/panel-row'
import { desktopCoworkerVaultListing, type DesktopCoworkerVaultListing, type DesktopCoworkerVaultMutation } from '@/lib/desktop/vault'

type Entry = DesktopCoworkerVaultListing['attached'][number]

export function DesktopCoworkerVault({ agentId, query }: { agentId: string; query: string }) {
    const [listing, setListing] = useState<DesktopCoworkerVaultListing | null>(null)
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const pending = useRef<AbortController | null>(null)

    const request = useCallback(async (input?: DesktopCoworkerVaultMutation) => {
        if (pending.current) return
        const controller = new AbortController()
        pending.current = controller
        try {
            const response = await fetch(`/api/desktop/coworkers/${encodeURIComponent(agentId)}/vault`, {
                signal: controller.signal,
                cache: 'no-store',
                ...(input && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
            })
            const body = await response.json()
            if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'Could not load this coworker’s Vault entries.')
            const result = desktopCoworkerVaultListing.parse(body)
            if (result.agentId !== agentId) throw new Error('The Vault response belongs to another coworker.')
            if (!controller.signal.aborted) {
                setError('')
                setListing(result)
            }
        } catch (cause) {
            if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'The Vault request failed.')
        } finally {
            if (pending.current === controller) {
                pending.current = null
                setBusy(false)
            }
        }
    }, [agentId])

    function submit(input?: DesktopCoworkerVaultMutation) {
        if (pending.current) return
        setBusy(true)
        setError('')
        void request(input)
    }

    useEffect(() => {
        void request()
        return () => { pending.current?.abort(); pending.current = null }
    }, [request])

    const matches = (entry: Entry) => `${entry.name} ${entry.variable}`.toLowerCase().includes(query.trim().toLowerCase())
    const attached = listing?.attached.filter(matches) ?? []
    const available = listing?.available.filter(matches) ?? []
    const row = (entry: Entry, attached: boolean) => (
        <PanelRow key={entry.id} title={entry.name}
            description={entry.sharedWithAll ? `${entry.variable} · Shared with every coworker` : entry.variable}
            leading={<KeyRound className="size-4" />}
            actions={<>
                {attached && <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">Vault</span>}
                <Button size="sm" variant="outline" aria-label={`${attached ? 'Remove' : 'Add'} ${entry.name}`}
                    disabled={busy || entry.sharedWithAll}
                    onClick={() => submit({ id: entry.id, revision: entry.revision, attached: !attached })}>
                    {attached ? 'Remove' : 'Add'}
                </Button>
            </>}
        />
    )
    return <>
        {error && <div className="space-y-2">
            <p role="alert" className="text-xs text-destructive">{error}</p>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => submit()}>Refresh Vault</Button>
        </div>}
        {attached.length > 0 && <PanelSection label="Vault entries in use">
            <PanelList>{attached.map(entry => row(entry, true))}</PanelList>
        </PanelSection>}
        {available.length > 0 && <PanelSection label="From the Vault">
            <PanelList>{available.map(entry => row(entry, false))}</PanelList>
        </PanelSection>}
    </>
}
