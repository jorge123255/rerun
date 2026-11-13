'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, ChevronRight, KeyRound, Plus } from 'lucide-react'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { PanelDialogContent } from '@/components/dialogs/PanelDialogContent'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSteps } from '@/components/ui/panel-steps'
import { PanelScroller } from '@/components/ui/panel-list'
import { desktopVaultListing, type DesktopVaultEntry, type DesktopVaultListing, type DesktopVaultMutation } from '@/lib/desktop/vault'

async function requestVault(signal: AbortSignal, input?: DesktopVaultMutation) {
    const response = await fetch('/api/desktop/vault', {
        cache: 'no-store', signal,
        ...(input && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
    })
    if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(typeof body?.error === 'string' ? body.error : 'Could not open the Vault.')
    }
    return desktopVaultListing.parse(await response.json())
}

export function DesktopVaultDialog({ onClose }: { onClose: () => void }) {
    return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
        <PanelDialogContent className="sm:h-[min(48rem,90dvh)] sm:max-w-2xl"
            onCloseAutoFocus={event => {
                event.preventDefault()
                document.querySelector<HTMLElement>('[aria-label^="Workspace menu,"]')?.focus({ preventScroll: true })
            }}>
            <DialogHeader className="border-b px-4 py-4 pr-12">
                <DialogTitle>Vault</DialogTitle>
                <DialogDescription>Store secrets for this workspace and choose their coworkers.</DialogDescription>
            </DialogHeader>
            <VaultPanel />
        </PanelDialogContent>
    </Dialog>
}

function VaultPanel() {
    const [listing, setListing] = useState<DesktopVaultListing | null>(null)
    const [page, setPage] = useState('list')
    const [query, setQuery] = useState('')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(true)
    const flight = useRef<AbortController | null>(null)
    async function run(input?: DesktopVaultMutation, next?: string) {
        if (flight.current) return
        const controller = new AbortController()
        flight.current = controller
        setBusy(true)
        setError('')
        try {
            const result = await requestVault(controller.signal, input)
            if (controller.signal.aborted) return
            setListing(result)
            if (next) setPage(next)
        } catch (cause) {
            if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not save the Vault change.')
        } finally {
            if (flight.current === controller) {
                flight.current = null
                setBusy(false)
            }
        }
    }
    useEffect(() => {
        const controller = new AbortController()
        flight.current = controller
        void requestVault(controller.signal).then(result => {
            if (!controller.signal.aborted) setListing(result)
        }).catch(cause => {
            if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not open the Vault.')
        }).finally(() => {
            if (flight.current === controller) {
                flight.current = null
                setBusy(false)
            }
        })
        return () => { flight.current?.abort(); flight.current = null }
    }, [])
    const entry = listing?.entries.find(item => item.id === page)
    const navigate = (next: string) => { setError(''); setPage(next) }
    const stepKey = entry?.id ?? (page === 'add' ? page : 'list')
    const filtered = listing?.entries.filter(item => `${item.name} ${item.variable}`.toLowerCase().includes(query.trim().toLowerCase()))
    const alert = error && <p className="text-sm text-destructive" role="alert">{error}</p>
    return <PanelSteps stepKey={stepKey} depth={stepKey === 'list' ? 0 : 1}>
        <PanelScroller className="space-y-4 p-4">
            {stepKey !== 'list' && <Button variant="ghost" size="sm" disabled={busy} onClick={() => navigate('list')}><ArrowLeft />Back</Button>}
            {alert}
            {!listing ? (error ? <Button variant="outline" disabled={busy} onClick={() => void run()}>Try again</Button> : <p role="status">Loading Vault…</p>)
                : page === 'add' ? <SecretForm busy={busy} onSubmit={fields => void run({ operation: 'create', ...fields }, 'list')} />
                : entry ? <VaultDetail key={entry.revision} entry={entry} coworkers={listing.coworkers} busy={busy} onSubmit={run} />
                : <>
                    <div className="flex items-center justify-between gap-2">
                        <h3 className="font-medium">Secrets</h3>
                        <Button variant="outline" size="sm" disabled={busy} onClick={() => navigate('add')}><Plus />Add secret</Button>
                    </div>
                    {listing.entries.length >= 8 && <Input aria-label="Search Vault" placeholder="Search Vault" value={query} onChange={event => setQuery(event.target.value)} />}
                    {listing.entries.length === 0 ? <p className="text-sm text-muted-foreground">No secrets in this workspace.</p>
                        : filtered?.length === 0 ? <p className="text-sm text-muted-foreground">No matching secrets.</p>
                        : filtered?.map(item => <PanelRow key={item.id} leading={<KeyRound className="size-4" />} title={item.name}
                            description={`${item.variable} · ${item.sharedWithAll ? 'Every coworker' : item.agentIds.length ? `${item.agentIds.length} assigned` : 'Unassigned'}`}
                            actions={<ChevronRight className="size-4" />} onClick={() => navigate(item.id)} />)}
                </>}
        </PanelScroller>
    </PanelSteps>
}

function SecretForm({ busy, onSubmit }: { busy: boolean; onSubmit: (input: { name: string; variable: string; value: string }) => void }) {
    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        const form = event.currentTarget
        const data = new FormData(form)
        onSubmit({ name: String(data.get('name')), variable: String(data.get('variable')), value: String(data.get('value')) })
        const field = form.elements.namedItem('value')
        if (field instanceof HTMLInputElement) field.value = ''
    }
    return <form onSubmit={submit} className="space-y-4">
        <h3 className="font-medium">Add secret</h3>
        <label className="block space-y-1 text-sm">Name<Input name="name" required maxLength={120} disabled={busy} /></label>
        <label className="block space-y-1 text-sm">Variable name<Input name="variable" placeholder="EXAMPLE_API_KEY" required maxLength={128} pattern="[A-Za-z_][A-Za-z0-9_]*" disabled={busy} /></label>
        <label className="block space-y-1 text-sm">Secret value<Input name="value" type="password" autoComplete="new-password" required maxLength={16384} disabled={busy} /></label>
        <Button type="submit" disabled={busy}>Save secret</Button>
    </form>
}

function VaultDetail({ entry, coworkers, busy, onSubmit }: {
    entry: DesktopVaultEntry
    coworkers: DesktopVaultListing['coworkers']
    busy: boolean
    onSubmit: (input: DesktopVaultMutation, next?: string) => void
}) {
    const [agentIds, setAgentIds] = useState(entry.agentIds)
    const [sharedWithAll, setSharedWithAll] = useState(entry.sharedWithAll)
    const [replace, setReplace] = useState(false)
    const target = { id: entry.id, revision: entry.revision }
    const changed = sharedWithAll !== entry.sharedWithAll || agentIds.length !== entry.agentIds.length || agentIds.some(id => !entry.agentIds.includes(id))
    const users = entry.sharedWithAll ? 'every coworker' : coworkers.filter(coworker => entry.agentIds.includes(coworker.id)).map(coworker => coworker.name).join(', ')
    return <div className="space-y-5">
        <header>
            <h3 className="font-medium">{entry.name}</h3>
            <p className="font-mono text-sm text-muted-foreground">{entry.variable}</p>
        </header>
        <fieldset disabled={busy} className="space-y-3 border-t pt-4">
            <legend className="text-sm font-medium">Coworkers</legend>
            <p className="text-sm text-muted-foreground">Assigned coworkers can use these variables in approved MCP credential references.</p>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sharedWithAll} onChange={event => setSharedWithAll(event.target.checked)} />Every coworker</label>
            {coworkers.map(coworker => <label key={coworker.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" disabled={sharedWithAll} checked={sharedWithAll || agentIds.includes(coworker.id)}
                    onChange={event => setAgentIds(ids => event.target.checked ? [...ids, coworker.id] : ids.filter(id => id !== coworker.id))} />
                {coworker.name}
            </label>)}
            <Button size="sm" disabled={busy || !changed} onClick={() => onSubmit({ operation: 'share', ...target, agentIds, sharedWithAll })}>Save assignments</Button>
        </fieldset>
        <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setReplace(!replace)}>Replace value</Button>
            <ConfirmDialog title={`Delete “${entry.name}”?`} description={users ? `This removes the secret and its assignment for ${users}.` : 'This removes the secret from this workspace.'}
                confirmLabel="Delete secret" pending={busy} onConfirm={() => onSubmit({ operation: 'delete', ...target }, 'list')}>
                <Button variant="outline" size="sm" disabled={busy}>Delete secret</Button>
            </ConfirmDialog>
        </div>
        {replace && <form className="space-y-3" onSubmit={event => {
            event.preventDefault()
            const field = event.currentTarget.elements.namedItem('value')
            if (field instanceof HTMLInputElement) {
                onSubmit({ operation: 'replace', ...target, value: field.value })
                field.value = ''
            }
        }}>
            <label className="block space-y-1 text-sm">New secret value<Input name="value" type="password" autoComplete="new-password" required maxLength={16384} disabled={busy} /></label>
            <Button type="submit" size="sm" disabled={busy}>Save new value</Button>
        </form>}
    </div>
}
