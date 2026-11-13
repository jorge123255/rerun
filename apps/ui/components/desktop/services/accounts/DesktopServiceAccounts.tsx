'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SERVICE_CATEGORIES, SERVICE_CATEGORY_LABELS } from '@rerun/contracts'
import { HScrollFade } from '@rerun/ui/primitives'
import { Chip } from '@/components/ui/chip'
import { PanelSteps } from '@/components/ui/panel-steps'
import { ServiceList } from '@/components/services/ServiceList'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Icon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { PanelList, PanelScroller, PanelSection } from '@/components/ui/panel-list'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelDeleteButton, PanelEditorBody, PanelEditorHeader, PanelEditorShell } from '@/components/ui/panel-editor'
import { SkeletonPanelRows } from '@/components/ui/skeleton'
import { UnplugIcon } from '@/lib/icons'
import { serviceIconProps } from '@/lib/services/icons'
import type { ServiceSearchResult } from '@/lib/services/types'
import { createDesktopServiceAccountsClient, type DesktopServiceAccountsClient, type ServiceAccountDetail, type ServiceAccountLibraryRow } from '@/lib/desktop/service-accounts-client'
import type { DesktopServiceAccountView } from '@rerun/contracts'
import { DesktopServiceOAuthAccount } from '../oauth/DesktopServiceOAuthAccount'
import { ServiceTransportConnection } from '../transports/ServiceTransportConnection'
import { serviceOAuthClient } from '@/lib/desktop/service-oauth-client'
import { desktopServiceTransportClient } from '@/lib/desktop/service-transports-client'
import { DesktopServiceAccountForm } from './DesktopServiceAccountForm'
import { DesktopVaultDialog } from '../../vault/DesktopVaultDialog'
import { DesktopCoworkerVault } from '../../vault/DesktopCoworkerVault'

function libraryService(row: ServiceAccountLibraryRow): ServiceSearchResult {
    return { slug: row.slug, name: row.name, category: row.category, summary: row.summary, icon: row.icon, requiresSecrets: row.requiresSecrets, setup: row.setup, setupReason: row.setupReason, installed: row.installed, installStatus: row.installStatus, verified: row.verified, multiInstance: row.multiInstance && row.addAccount }
}

function healthText(account: DesktopServiceAccountView) {
    if (account.health.state === 'healthy' && account.status === 'active') return 'Connected (last check)'
    if (account.health.state === 'disconnected') return 'Disconnected'
    if (account.health.state === 'error') return 'Connection failed'
    return 'Unchecked'
}

export function DesktopServiceAccounts(props: { agentId: string; focusSlug?: string; focusRequestKey?: string }) {
    return <Accounts key={props.agentId} {...props} />
}

function Accounts({ agentId, focusSlug, focusRequestKey }: { agentId: string; focusSlug?: string; focusRequestKey?: string }) {
    const oauthDriver = useMemo(() => serviceOAuthClient(), [agentId])
    const transportClient = useMemo(() => desktopServiceTransportClient(), [agentId])
    const [client, setClient] = useState<DesktopServiceAccountsClient | null>(null)
    const [accounts, setAccounts] = useState<DesktopServiceAccountView[]>([])
    const [catalog, setCatalog] = useState<ServiceAccountLibraryRow[]>([])
    const [vaultApp, setVaultApp] = useState<string | null>(null)
    const [vaultRefresh, setVaultRefresh] = useState(0)
    const [detail, setDetail] = useState<ServiceAccountDetail | null>(null)
    const [selected, setSelected] = useState<string | null>(null)
    const [query, setQuery] = useState('')
    const [category, setCategory] = useState('')
    const [total, setTotal] = useState(0)
    const [opening, setOpening] = useState(false)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const source = useRef<DesktopServiceAccountsClient | null>(null)
    const epoch = useRef(0)
    const loadEpoch = useRef(0)
    const offset = useRef(0)
    const loadingPage = useRef(false)
    const mutation = useRef(false)
    const focused = useRef<string | null>(null)
    const selection = useRef<string | null>(null)
    selection.current = selected
    const formIdentityRef = useRef('new')
    useEffect(() => {
        const next = createDesktopServiceAccountsClient(agentId)
        source.current = next
        setClient(next)
        return () => {
            source.current = null
            epoch.current += 1
            loadEpoch.current += 1
            next.dispose()
        }
    }, [agentId])
    const load = useCallback(async (append = false) => {
        if (!client || append && loadingPage.current) return
        const current = ++loadEpoch.current
        loadingPage.current = true
        setLoading(true)
        try {
            const [rows, page] = await Promise.all([client.installed(), client.catalog(query, category, append ? offset.current : 0)])
            if (source.current !== client || current !== loadEpoch.current) return
            setAccounts(rows)
            offset.current = (append ? offset.current : 0) + page.services.length
            setCatalog(previous => append ? [...previous, ...page.services.filter(row => !previous.some(saved => saved.slug === row.slug))] : page.services)
            setTotal(page.total)
            setError('')
        } catch {
            if (source.current === client && current === loadEpoch.current) setError('Could not load apps. Retry to read the local catalog and connection state.')
        } finally {
            if (source.current === client && current === loadEpoch.current) { loadingPage.current = false; setLoading(false) }
        }
    }, [client, query, category])
    useEffect(() => {
        if (!client) return
        loadEpoch.current += 1
        offset.current = 0
        setCatalog([])
        setLoading(true)
        const timer = setTimeout(() => void load(), 150)
        return () => clearTimeout(timer)
    }, [client, load])
    const openSlug = useCallback(async (slug: string, accountKey?: string) => {
        if (!client || mutation.current) return
        const current = ++epoch.current
        setOpening(true)
        try {
            const next = await client.detail(slug)
            if (source.current !== client || current !== epoch.current) return
            if (!accountKey && next.vaultManaged && !next.accounts.length) {
                setVaultApp(slug)
                setError('')
                return
            }
            setDetail(next)
            const key = accountKey ?? next.accounts.find(account => account.key === slug)?.key ?? next.accounts[0]?.key ?? `new:${slug}`
            selection.current = key
            setSelected(key)
            setError('')
        } catch {
            if (source.current === client && current === epoch.current) setError('Could not load this app’s details.')
        } finally {
            if (source.current === client && current === epoch.current) setOpening(false)
        }
    }, [client])
    useEffect(() => {
        const key = JSON.stringify([agentId, focusSlug, focusRequestKey])
        if (!client || !focusSlug || busy || focused.current === key) return
        focused.current = key
        void openSlug(focusSlug)
    }, [client, agentId, focusSlug, focusRequestKey, busy, openSlug])
    function back() {
        if (mutation.current) return
        epoch.current += 1
        selection.current = null
        setDetail(null)
        setSelected(null)
        setError('')
    }
    const selectedAccount = detail?.accounts.find(account => account.key === selected) ?? null
    const formIdentity = selectedAccount ? `${selectedAccount.installationId}/${selectedAccount.revision}` : selected ?? 'new'
    formIdentityRef.current = formIdentity
    async function refresh() {
        if (!client || !detail) return
        const current = epoch.current
        const next = await client.detail(detail.slug)
        if (source.current !== client || current !== epoch.current) return
        setDetail(next)
        await load()
    }
    async function mutate(kind: 'probe' | 'disconnect' | 'remove') {
        if (!client || !selectedAccount || mutation.current) return
        mutation.current = true
        setBusy(true)
        setError('')
        const current = epoch.current
        const key = selectedAccount.key
        try {
            const result = await client[kind](selectedAccount.key, selectedAccount.revision)
            if (source.current !== client || current !== epoch.current || selection.current !== key) return
            if (kind === 'remove' && result.status === 'removed') {
                selection.current = null
                setDetail(null)
                setSelected(null)
                await load()
            } else await refresh()
        } catch (caught) {
            if (source.current === client && current === epoch.current && selection.current === key) setError(caught instanceof Error ? caught.message : 'Operation refused or acknowledgement unknown. Refresh connection state before retrying.')
        } finally {
            mutation.current = false
            if (source.current === client) setBusy(false)
        }
    }
    if (!client) return <SkeletonPanelRows rows={6} />
    const editor = detail && selected
    return (
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col" data-state={loading ? 'loading' : error ? 'unavailable' : accounts.length || catalog.length ? 'ready' : 'empty'}>
            {vaultApp && <DesktopVaultDialog coworkerApp={vaultApp} onClose={() => {
                setVaultApp(null)
                setVaultRefresh(value => value + 1)
                void load()
            }} />}
            <PanelSteps stepKey={editor ? `setup:${selected}` : 'list'} depth={editor ? 1 : 0}>
            {editor ? (
                <PanelEditorShell>
                    <PanelEditorHeader title={selectedAccount?.label || detail.name} onBack={busy ? undefined : back} />
                    <PanelEditorBody>
                        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
                        <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">{detail.description || detail.summary}</p>
                        <p className="text-xs text-muted-foreground">{detail.localLimitations}</p>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh().catch(() => { if (source.current === client) setError('Could not refresh connection state.') })}>Refresh connection state</Button>
                        {selectedAccount && (
                            <div className="space-y-2">
                                <p className="text-xs">{healthText(selectedAccount)}{selectedAccount.health.checkedAt ? ` · ${selectedAccount.health.checkedAt}` : ''}</p>
                                <p className="text-xs text-muted-foreground">{selectedAccount.health.message}</p>
                                <div className="flex flex-wrap gap-2">
                                    {selectedAccount.shape !== 'oauth' && selectedAccount.transport !== 'sse' && <>
                                        <Button size="sm" variant="outline" disabled={busy || selectedAccount.health.state === 'disconnected'} onClick={() => void mutate('probe')}>Probe connection</Button>
                                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void mutate('disconnect')}>Disconnect</Button>
                                    </>}
                                    <PanelDeleteButton label={`Uninstall ${selectedAccount.label || detail.name}`} disabled={busy} busy={busy} onClick={() => void mutate('remove')} confirmTitle={`Uninstall ${selectedAccount.label || detail.name}?`} confirmDescription="The coworker loses this account’s owned resources and tools. Other accounts stay. Local credentials are removed; the remote API key is not revoked." confirmLabel="Uninstall" />
                                </div>
                            </div>
                        )}
                        {selectedAccount?.shape === 'oauth' && <DesktopServiceOAuthAccount coworkerId={agentId} account={selectedAccount} driver={oauthDriver} onChanged={() => { void refresh().catch(() => setError('Could not refresh this account.')) }} />}
                        {selectedAccount?.transport === 'sse' && <ServiceTransportConnection account={{ agentId, key: selectedAccount.key, installationId: selectedAccount.installationId, revision: selectedAccount.revision }} name={selectedAccount.label || detail.name} client={transportClient} />}
                        <DesktopServiceAccountForm
                            key={formIdentity}
                            identity={formIdentity}
                            disabled={busy}
                            methods={detail.authMethods}
                            saved={selectedAccount}
                            submitLabel={selectedAccount ? 'Save' : 'Install'}
                            onCancel={back}
                            onSubmit={async (methodId, values) => {
                                if (!client || mutation.current) throw new Error('An app change is already in progress.')
                                mutation.current = true
                                setBusy(true)
                                const current = epoch.current, identity = formIdentity, chosen = selected
                                try {
                                    const result = selectedAccount
                                        ? await client.reconfigure(selectedAccount.key, selectedAccount.revision, methodId, values)
                                        : await client.install(detail.slug, chosen?.startsWith('additional:') ? 'additional' : 'new', methodId, values)
                                    if (source.current !== client || current !== epoch.current || selection.current !== chosen || formIdentityRef.current !== identity) return
                                    if (result.accountKey) { selection.current = result.accountKey; setSelected(result.accountKey) }
                                    await refresh()
                                } finally {
                                    mutation.current = false
                                    if (source.current === client) setBusy(false)
                                }
                            }}
                        />
                    </PanelEditorBody>
                </PanelEditorShell>
            ) : (
                <div className="flex h-full min-w-0 flex-col">
                    <div className="space-y-2 border-b p-3">
                        <Input className="h-8 text-sm" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search apps…" />
                        <HScrollFade className="-mx-1 gap-1.5 px-1" fadeClassName="from-background"><Chip selected={!category} onClick={() => setCategory('')}>All</Chip>{SERVICE_CATEGORIES.filter(item => item !== 'other').map(item => <Chip key={item} selected={category === item} onClick={() => setCategory(item)}>{SERVICE_CATEGORY_LABELS[item]}</Chip>)}</HScrollFade>
                    </div>
                    <PanelScroller className="space-y-4">
                        {error && (
                            <div className="space-y-2">
                                <p role="alert" className="text-xs text-destructive">{error}</p>
                                <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
                            </div>
                        )}
                        {opening && <p role="status" className="text-xs text-muted-foreground">Loading app details…</p>}
                        <PanelSection label="Installed">
                            {loading && !accounts.length ? <SkeletonPanelRows rows={3} leading /> : accounts.length ? (
                                <PanelList>
                                    {accounts.map(account => (
                                        <PanelRow key={account.installationId} title={account.label || account.name} leading={<Icon {...serviceIconProps(account.icon, account.category)} size="sm" />} description={healthText(account)} onClick={() => void openSlug(account.slug, account.key)} actions={<Button size="sm" variant="outline" onClick={() => void openSlug(account.slug, account.key)}>Configure</Button>} />
                                    ))}
                                </PanelList>
                            ) : !error && <EmptyState icon={UnplugIcon} title="No apps installed" description="Add an app from the Library to extend this coworker’s tools." />}
                        </PanelSection>
                        <DesktopCoworkerVault key={vaultRefresh} agentId={agentId} query={query} />
                        <PanelSection label="Library">
                            {loading && !catalog.length ? <SkeletonPanelRows rows={6} leading /> : catalog.length ? (
                                <ServiceList services={catalog.map(libraryService)} onInstall={slug => void openSlug(slug)} onAddAccount={slug => { const row = catalog.find(item => item.slug === slug); if (row?.addAccount) void openSlug(slug, `additional:${slug}`) }} />
                            ) : !error && <EmptyState className="py-8" icon={UnplugIcon} title="No apps found" description="We could not find an app matching your search." />}
                            {offset.current < total && <Button size="sm" variant="outline" disabled={loading} onClick={() => void load(true)}>{loading ? 'Loading…' : 'Load more apps'}</Button>}
                        </PanelSection>
                    </PanelScroller>
                </div>
            )}
            </PanelSteps>
        </div>
    )
}

/** Shared mount for the desktop Apps panel. */
export function DesktopServiceAccountsMount({ agentId }: { agentId: string }) {
    return <DesktopServiceAccounts agentId={agentId} />
}
