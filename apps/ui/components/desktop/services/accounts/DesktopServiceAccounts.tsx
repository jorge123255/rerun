'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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
import type { DesktopServiceAccountView } from '../../../../../../packages/contracts/src/desktop-service-accounts'
import { DesktopServiceAccountForm } from './DesktopServiceAccountForm'

function libraryService(row: ServiceAccountLibraryRow): ServiceSearchResult {
    return { slug: row.slug, name: row.name, category: row.category, summary: row.summary, icon: row.icon, requiresSecrets: row.requiresSecrets, setup: row.setup, setupReason: row.setupReason, installed: row.installed, installStatus: row.installStatus, verified: row.verified, multiInstance: row.multiInstance }
}

function healthText(account: DesktopServiceAccountView) {
    if (account.health.state === 'healthy' && account.status === 'active') return 'Connected (last check)'
    if (account.health.state === 'disconnected') return 'Disconnected'
    if (account.health.state === 'error') return 'Connection failed'
    return 'Unchecked'
}

export function DesktopServiceAccounts({ agentId }: { agentId: string }) {
    const [client, setClient] = useState<DesktopServiceAccountsClient | null>(null)
    const [accounts, setAccounts] = useState<DesktopServiceAccountView[]>([])
    const [catalog, setCatalog] = useState<ServiceAccountLibraryRow[]>([])
    const [detail, setDetail] = useState<ServiceAccountDetail | null>(null)
    const [selected, setSelected] = useState<string | null>(null)
    const [query, setQuery] = useState('')
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const source = useRef<DesktopServiceAccountsClient | null>(null)
    const epoch = useRef(0)
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
            next.dispose()
        }
    }, [agentId])
    const load = useCallback(async () => {
        if (!client) return
        const current = ++epoch.current
        setLoading(true)
        try {
            const [rows, page] = await Promise.all([client.installed(), client.catalog(query)])
            if (source.current !== client || current !== epoch.current) return
            setAccounts(rows)
            setCatalog(page.services)
            setError('')
        } catch {
            if (source.current === client && current === epoch.current) setError('Could not load apps. Retry to read the local catalog and connection state.')
        } finally {
            if (source.current === client && current === epoch.current) setLoading(false)
        }
    }, [client, query])
    useEffect(() => {
        if (!client) return
        const timer = setTimeout(() => void load(), 150)
        return () => clearTimeout(timer)
    }, [client, load])
    async function openSlug(slug: string, accountKey?: string) {
        if (!client || busy) return
        const current = ++epoch.current
        try {
            const next = await client.detail(slug)
            if (source.current !== client || current !== epoch.current) return
            setDetail(next)
            setSelected(accountKey ?? next.accounts[0]?.key ?? `new:${slug}`)
            setError('')
        } catch {
            if (source.current === client && current === epoch.current) setError('Could not load this app’s details.')
        }
    }
    const selectedAccount = detail?.accounts.find(account => account.key === selected) ?? null
    const formIdentity = selectedAccount?.installationId ?? selected ?? 'new'
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
        if (!client || !selectedAccount || busy) return
        setBusy(true)
        setError('')
        const current = epoch.current
        const key = selectedAccount.key
        try {
            const result = await client[kind](selectedAccount.key, selectedAccount.revision)
            if (source.current !== client || current !== epoch.current || selected !== key) return
            if (kind === 'remove' && result.status === 'removed') {
                setDetail(null)
                setSelected(null)
            } else await refresh()
        } catch (caught) {
            if (source.current === client && current === epoch.current && selected === key) setError(caught instanceof Error ? caught.message : 'Operation refused or acknowledgement unknown. Refresh connection state before retrying.')
        } finally {
            if (source.current === client) setBusy(false)
        }
    }
    if (!client) return <SkeletonPanelRows rows={6} />
    const editor = detail && selected
    return (
        <div className="flex h-full min-w-0 flex-col" data-state={loading ? 'loading' : error ? 'unavailable' : accounts.length || catalog.length ? 'ready' : 'empty'}>
            {editor ? (
                <PanelEditorShell>
                    <PanelEditorHeader title={selectedAccount?.label || detail.name} onBack={busy ? undefined : () => { epoch.current += 1; setDetail(null); setSelected(null) }} />
                    <PanelEditorBody>
                        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
                        <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">{detail.description || detail.summary}</p>
                        <p className="text-xs text-muted-foreground">{detail.localLimitations}</p>
                        {selectedAccount && (
                            <div className="space-y-2">
                                <p className="text-xs">{healthText(selectedAccount)}{selectedAccount.health.checkedAt ? ` · ${selectedAccount.health.checkedAt}` : ''}</p>
                                <p className="text-xs text-muted-foreground">{selectedAccount.health.message}</p>
                                <div className="flex flex-wrap gap-2">
                                    <Button size="sm" variant="outline" disabled={busy || selectedAccount.health.state === 'disconnected'} onClick={() => void mutate('probe')}>Probe connection</Button>
                                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void mutate('disconnect')}>Disconnect</Button>
                                    <PanelDeleteButton label={`Uninstall ${selectedAccount.label || detail.name}`} disabled={busy} busy={busy} onClick={() => void mutate('remove')} confirmTitle={`Uninstall ${selectedAccount.label || detail.name}?`} confirmDescription="The coworker loses this account’s owned resources and tools. Other accounts stay. Local credentials are removed; the remote API key is not revoked." confirmLabel="Uninstall" />
                                </div>
                            </div>
                        )}
                        <DesktopServiceAccountForm
                            identity={formIdentity}
                            methods={detail.authMethods}
                            saved={selectedAccount}
                            submitLabel={selectedAccount ? 'Save' : 'Install'}
                            onCancel={() => undefined}
                            onSubmit={async (methodId, values) => {
                                if (!client) return
                                const current = epoch.current
                                const identity = formIdentity
                                const chosen = selected
                                const result = selectedAccount
                                    ? await client.reconfigure(selectedAccount.key, selectedAccount.revision, methodId, values)
                                    : await client.install(detail.slug, chosen?.startsWith('additional:') ? 'additional' : 'new', methodId, values)
                                if (source.current !== client || current !== epoch.current || selection.current !== chosen || formIdentityRef.current !== identity) return
                                if (result.accountKey) setSelected(result.accountKey)
                                await refresh()
                            }}
                        />
                    </PanelEditorBody>
                </PanelEditorShell>
            ) : (
                <div className="flex h-full min-w-0 flex-col">
                    <div className="space-y-2 border-b p-3">
                        <Input className="h-8 text-sm" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search apps…" />
                    </div>
                    <PanelScroller className="space-y-4">
                        {error && (
                            <div className="space-y-2">
                                <p role="alert" className="text-xs text-destructive">{error}</p>
                                <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
                            </div>
                        )}
                        <PanelSection label="Installed">
                            {loading && !accounts.length ? <SkeletonPanelRows rows={3} leading /> : accounts.length ? (
                                <PanelList>
                                    {accounts.map(account => (
                                        <PanelRow key={account.installationId} title={account.label || account.name} leading={<Icon {...serviceIconProps(account.icon, account.category)} size="sm" />} description={healthText(account)} onClick={() => void openSlug(account.slug, account.key)} actions={<Button size="sm" variant="outline" onClick={() => void openSlug(account.slug, account.key)}>Configure</Button>} />
                                    ))}
                                </PanelList>
                            ) : !error && <EmptyState icon={UnplugIcon} title="No apps installed" description="Add an app from Discover to extend this coworker’s tools." />}
                        </PanelSection>
                        <PanelSection label="Discover">
                            {loading && !catalog.length ? <SkeletonPanelRows rows={6} leading /> : catalog.length ? (
                                <ServiceList services={catalog.map(libraryService)} onInstall={slug => void openSlug(slug, `new:${slug}`)} onAddAccount={slug => { const row = catalog.find(item => item.slug === slug); if (row?.addAccount) void openSlug(slug, `additional:${slug}`) }} />
                            ) : !error && <EmptyState className="py-8" icon={UnplugIcon} title="No apps found" description="We could not find an app matching your search." />}
                        </PanelSection>
                    </PanelScroller>
                </div>
            )}
        </div>
    )
}

/** Root mounts this beside the existing Apps panel. It does not replace that panel. */
export function DesktopServiceAccountsMount({ agentId }: { agentId: string }) {
    return <DesktopServiceAccounts agentId={agentId} />
}
