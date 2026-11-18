'use client'

import { useEffect, useRef, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import { PanelDialogContent } from '@/components/dialogs/PanelDialogContent'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { DialogHeaderBar } from '@/components/dialogs/DialogHeaderBar'
import { LockKeyholeIcon } from '@/lib/icons'
import { Input } from '@/components/ui/input'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSteps } from '@/components/ui/panel-steps'
import { PanelScroller } from '@/components/ui/panel-list'
import { Skeleton } from '@/components/ui/skeleton'
import { desktopVaultListing, type DesktopVaultEntry, type DesktopVaultListing } from '@/lib/desktop/vault'
import { invalidateDesktopConnectorApps } from '@/lib/desktop/use-connector-apps'
import { DesktopManagedApps } from './DesktopManagedApps'
import { DesktopVaultAdd, type VaultAddKind } from './DesktopVaultAdd'
import { DesktopVaultDetail, type VaultDestination, type VaultRequest } from './DesktopVaultDetail'
import { DesktopVaultEmpty, popularVaultApps } from './DesktopVaultEmpty'
import { VaultAppTile, VaultCoworkerFaces, VaultEntryIcon, VaultStatusBadge } from './DesktopVaultTile'
import { entryGroup, entryName, entrySubtitle, entryTitle, VAULT_GROUP_LABEL, type VaultEntryGroup } from './vault-account-health'

export { popularVaultApps } from './DesktopVaultEmpty'
export { VaultAppTile } from './DesktopVaultTile'

async function requestVault(signal: AbortSignal, input?: VaultRequest) {
    const health = input?.operation === 'check-health'
    const body = health ? { id: input.id, revision: input.revision } : input
    const response = await fetch(health ? '/api/desktop/vault/health' : '/api/desktop/vault', {
        cache: 'no-store', signal,
        ...(input && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(typeof body?.error === 'string' ? body.error : 'Could not open the Vault.')
    }
    return desktopVaultListing.parse(await response.json())
}

type SuggestedApp = { slug: string; onUse: (account: { key: string; revision: string }) => void }

// Past this many entries the list gets a search field: a handful is read at a glance.
const SEARCH_FROM = 8

type VaultDialogProps = { onClose: () => void; suggestedApp?: SuggestedApp; coworkerApp?: string; managedApp?: string }

export function DesktopVaultDialog({ onClose, suggestedApp, coworkerApp, managedApp }: VaultDialogProps) {
    const opener = useRef<HTMLElement | null>(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null)
    return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
        <PanelDialogContent className="sm:h-[min(48rem,90dvh)] sm:max-w-2xl"
            onCloseAutoFocus={event => {
                event.preventDefault()
                const target = (suggestedApp || coworkerApp || managedApp) && opener.current?.isConnected ? opener.current
                    : document.querySelector<HTMLElement>('[aria-label^="Workspace menu,"]')
                target?.focus({ preventScroll: true })
            }}>
            <VaultPanel suggestedApp={suggestedApp} coworkerApp={coworkerApp} managedApp={managedApp} onClose={onClose} />
        </PanelDialogContent>
    </Dialog>
}

/**
 * The Vault, laid out as upstream VaultPanel.tsx: one header with one Add button, the apps as
 * tiles, the MCP servers, local programs and secrets as rows under them, and the Mac's managed
 * (Composio) apps as their own section at the bottom.
 */
function VaultPanel({ suggestedApp, coworkerApp, managedApp, onClose }: VaultDialogProps) {
    const [listing, setListing] = useState<DesktopVaultListing | null>(null)
    const [page, setPage] = useState(suggestedApp ? 'add' : managedApp ? 'managed' : 'list')
    const [query, setQuery] = useState('')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(true)
    const flight = useRef<AbortController | null>(null)
    async function run(input?: VaultRequest, next?: VaultDestination, showError = true) {
        if (flight.current) return new Error('Another Vault request is in progress.')
        const controller = new AbortController()
        flight.current = controller
        setBusy(true)
        setError('')
        try {
            const result = await requestVault(controller.signal, input)
            if (controller.signal.aborted) return new Error('The Vault request was cancelled.')
            setListing(result)
            if (input?.operation === 'share' || input?.operation === 'delete') invalidateDesktopConnectorApps()
            if (next) setPage(typeof next === 'function' ? next(result) : next)
            return null
        } catch (cause) {
            const failure = cause instanceof Error ? cause : new Error('Could not save the Vault change.')
            if (showError && !controller.signal.aborted) setError(failure.message)
            return failure
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
    const accounts: Record<string, string[]> = {}
    for (const item of listing?.entries ?? []) {
        if ('kind' in item && item.kind === 'mcp' && item.catalog) (accounts[item.catalog.slug] ??= []).push(entryTitle(item))
    }
    const entry = listing?.entries.find(item => item.id === page)
    // What the Add page opens on: one of its four kinds, or the app of a popular tile.
    const [addKind, setAddKind] = useState<VaultAddKind>('app')
    const [addSlug, setAddSlug] = useState<string | undefined>(undefined)
    const navigate = (next: string) => { setError(''); setPage(next) }
    const add = (kind: VaultAddKind = 'app', slug?: string) => { setAddKind(kind); setAddSlug(slug); navigate('add') }
    // Logos and names come from the app catalog; a Vault entry only keeps the app's id. Null until it is read.
    const [catalog, setCatalog] = useState<Record<string, { name: string; icon?: string | null }> | null>(null)
    useEffect(() => {
        const controller = new AbortController()
        void fetch('/api/desktop/vault/catalog', { cache: 'no-store', signal: controller.signal }).then(async response => {
            const apps = response.ok ? await response.json() as Array<{ slug: string; name: string; icon?: string | null }> : []
            if (!controller.signal.aborted) setCatalog(Array.isArray(apps) ? Object.fromEntries(apps.map(app => [app.slug, { name: app.name, icon: app.icon }])) : {})
        }).catch(() => { if (!controller.signal.aborted) setCatalog({}) /* Tiles fall back to the plain connector mark. */ })
        return () => controller.abort()
    }, [])
    const logoOf = (item: DesktopVaultEntry) => 'kind' in item && item.kind === 'mcp' ? catalog?.[item.catalog?.slug ?? '']?.icon : undefined
    const stepKey = entry?.id ?? page
    const search = query.trim().toLowerCase()
    const filtered = (listing?.entries ?? []).filter(item => (
        !coworkerApp || 'kind' in item && item.kind === 'mcp' && item.catalog?.slug === coworkerApp
    ) && `${entryName(item)} ${entryTitle(item)} ${entrySubtitle(item)}`.toLowerCase().includes(search))
    const apps = filtered.filter(item => entryGroup(item) === 'app')
    const order: VaultEntryGroup[] = ['mcp', 'program', 'secret']
    const others = order.flatMap(group => filtered.filter(item => entryGroup(item) === group))
    const empty = !coworkerApp && listing?.entries.length === 0
    const alert = error && <p className="text-sm text-destructive" role="alert">{error}</p>
    const managedSection = listing && <DesktopManagedApps initialSearch={managedApp} coworkers={listing.coworkers} disabled={busy}
        onVaultChanged={() => { void run() }}
        onChooseCoworkers={name => { void run(undefined, fresh => {
            const connector = fresh.entries.find(item => 'kind' in item && item.kind === 'mcp' && item.name === name)
            if (!connector) throw new Error('The Composio connector is no longer in this Vault.')
            return connector.id
        }) }} />
    return <>
        <DialogHeaderBar icon={LockKeyholeIcon} title={suggestedApp ? 'Add account to Vault' : coworkerApp || managedApp ? 'Manage app in Vault' : 'Vault'}
            description="Sign in to an app once, then pick the coworkers that use it."
            actions={stepKey === 'list' && listing && !empty && !suggestedApp
                && <Button size="xs" variant="secondary" disabled={busy} onClick={() => add('app', coworkerApp)}><Plus className="size-3" />{coworkerApp ? 'Add account' : 'Add'}</Button>} />
        <div className="flex min-h-0 flex-1 flex-col">
            <PanelSteps stepKey={stepKey} depth={stepKey === 'list' ? 0 : 1}>
                {!listing ? (error ? <div className="space-y-4 p-4">{alert}<Button variant="outline" disabled={busy} onClick={() => void run()}>Try again</Button></div> : <VaultSkeleton />)
                    : page === 'managed' ? <PanelScroller className="space-y-4 p-4">{alert}{managedSection}</PanelScroller>
                    : page === 'add' ? <DesktopVaultAdd kind={addKind} onKind={kind => { setError(''); setAddKind(kind) }} slug={suggestedApp?.slug ?? coworkerApp ?? addSlug}
                        busy={busy} alert={alert} existingAccounts={accounts}
                        onBack={suggestedApp ? undefined : () => navigate(managedApp ? 'managed' : 'list')} onCancel={suggestedApp ? onClose : () => navigate('list')}
                        onCreate={input => void run(input, 'list')}
                        onSaveApp={async (slug, methodId, values, account) => {
                            const previousIds = new Set(listing.entries.map(item => item.id))
                            const failure = await run({ operation: 'add-app', slug, methodId, values, ...account }, saved => {
                                const added = saved.entries.filter(item => !previousIds.has(item.id)
                                    && 'kind' in item && item.kind === 'mcp' && item.catalog?.slug === slug)
                                return added.length === 1 ? added[0].id : 'list'
                            }, false)
                            if (failure) throw failure
                        }} />
                    : entry ? <DesktopVaultDetail key={entry.revision} entry={entry} icon={logoOf(entry)} coworkers={listing.coworkers} busy={busy} alert={alert} onSubmit={run}
                        onBack={suggestedApp ? undefined : () => navigate(managedApp ? 'managed' : 'list')}
                        onUseInChat={suggestedApp && (() => suggestedApp.onUse({ key: 'vault:' + entry.id, revision: entry.revision }))} />
                    : suggestedApp ? <div className="space-y-4 p-4">{alert}<Button variant="outline" onClick={onClose}>Return to chat</Button></div>
                    : <PanelScroller className={empty ? 'flex flex-col gap-4 p-4' : 'space-y-4 p-4'}>
                        {alert}
                        {empty ? <DesktopVaultEmpty apps={catalog && popularVaultApps(catalog)} busy={busy} onPick={slug => add('app', slug)} onAdd={kind => add(kind)} />
                            : <>
                                {!coworkerApp && listing.entries.length >= SEARCH_FROM && <div className="relative">
                                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                                    <Input aria-label="Search Vault" placeholder="Search Vault" className="pl-8" value={query} onChange={event => setQuery(event.target.value)} />
                                </div>}
                                {filtered.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{coworkerApp ? 'No accounts for this app in the Vault.' : 'No matching entries.'}</p>}
                                {apps.length > 0 && <div className="@container">
                                    <div className="grid grid-cols-2 gap-2 @md:grid-cols-3" data-vault-apps>
                                        {apps.map(item => <VaultAppTile key={item.id} entry={item} icon={logoOf(item)} coworkers={listing.coworkers} onOpen={() => navigate(item.id)} />)}
                                    </div>
                                </div>}
                                {others.length > 0 && <div className="space-y-1.5" data-vault-rows>
                                    {others.map(item => <PanelRow key={item.id} onClick={() => navigate(item.id)} leading={<VaultEntryIcon entry={item} />}
                                        title={item.name} description={VAULT_GROUP_LABEL[entryGroup(item)]}
                                        actions={<><VaultStatusBadge entry={item} /><VaultCoworkerFaces usage={item} coworkers={listing.coworkers} /></>} />)}
                                </div>}
                            </>}
                        {/* The Mac's own: apps signed in through the person's Composio account. Last, so the top reads as the cloud's Vault. */}
                        {!coworkerApp && managedSection}
                    </PanelScroller>}
            </PanelSteps>
        </div>
    </>
}

/** The list's shape while it is read: six tiles and a row. From upstream VaultPanel.tsx (VaultSkeleton). */
function VaultSkeleton() {
    return <div className="space-y-4 p-4" role="status" aria-label="Loading Vault">
        <div className="@container">
            <div className="grid grid-cols-2 gap-2 @md:grid-cols-3">
                {Array.from({ length: 6 }, (_, index) => <div key={index} className="flex flex-col gap-3 rounded-md border p-3">
                    <Skeleton className="size-10 rounded-lg" />
                    <div className="space-y-1.5"><Skeleton className="h-3.5 w-20" /><Skeleton className="h-2.5 w-28 max-w-full" /></div>
                    <Skeleton className="h-6 w-14" />
                </div>)}
            </div>
        </div>
        <div className="flex items-center gap-3 rounded-md border p-3">
            <Skeleton className="size-8 rounded-md" />
            <div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-28" /><Skeleton className="h-2.5 w-20" /></div>
        </div>
    </div>
}
