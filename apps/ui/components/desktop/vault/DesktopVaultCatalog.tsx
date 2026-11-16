'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { ArrowLeft, ChevronRight, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PanelEditorHeader } from '@/components/ui/panel-editor'
import { PanelScroller } from '@/components/ui/panel-list'
import { PanelRow } from '@/components/ui/panel-row'
import { Skeleton } from '@/components/ui/skeleton'
import type { ServiceAccountMethod } from '@/lib/desktop/service-accounts-client'
import { DesktopServiceAccountForm } from '../services/accounts/DesktopServiceAccountForm'
import { DesktopAppLogo } from './DesktopAppLogo'

type CatalogApp = { slug: string; name: string; summary: string; icon?: string | null; multiInstance: boolean; methods: ServiceAccountMethod[] }

/**
 * The app catalog and the form that signs in to one app. With `listHeader` it draws the whole Add
 * page the way upstream VaultAddApp.tsx does: the header and segmented control it is handed, the
 * search field, the apps as rows, and a back-arrow header once an app is picked. Without it (an
 * entry's own Replace key form) it draws only the form.
 */
export function DesktopVaultCatalog({ slug, editing = false, busy, replacesSignIn, existingAccounts, onSave, onCancel, listHeader, onBack }: {
    slug?: string
    listHeader?: ReactNode
    /** Paged only: where the back arrow of an app opened by its slug leads. None, no arrow. */
    onBack?: () => void
    editing?: boolean
    busy: boolean
    replacesSignIn?: boolean
    existingAccounts?: Record<string, string[]>
    onSave: (slug: string, methodId: string, values: Record<string, string>, account?: { label?: string; expectedAccounts: number }) => Promise<void>
    onCancel: () => void
}) {
    const [apps, setApps] = useState<CatalogApp[] | null>(null)
    const [error, setError] = useState(false)
    const [query, setQuery] = useState('')
    const [selected, setSelected] = useState<CatalogApp | null>(null)
    const [label, setLabel] = useState('')
    const clearSelection = () => { setSelected(null); setLabel('') }

    useEffect(() => {
        const controller = new AbortController()
        const path = '/api/desktop/vault/catalog' + (slug ? '?' + new URLSearchParams({ q: slug }) : '')
        void (async () => {
            try {
                const response = await fetch(path, { cache: 'no-store', signal: controller.signal })
                if (!response.ok) throw new Error('Catalog unavailable')
                const entries = await response.json() as CatalogApp[]
                if (!controller.signal.aborted) setApps(entries)
            } catch {
                if (!controller.signal.aborted) setError(true)
            }
        })()
        return () => controller.abort()
    }, [slug])

    const paged = listHeader !== undefined
    // The page's own chrome while the catalog is read or could not be: the list header, or a plain back arrow.
    const frame = (body: ReactNode) => !paged ? body : <div className="flex h-full flex-col">
        {slug ? <PanelEditorHeader title="Add to the Vault" onBack={onBack} /> : listHeader}
        <PanelScroller className="space-y-1.5 p-3">{body}</PanelScroller>
    </div>
    if (error) return frame(<p role="alert" className="text-sm text-destructive">Could not load the app catalog. Go back and try again.</p>)
    if (!apps) return frame(!paged ? <p role="status" className="text-sm text-muted-foreground">Loading apps…</p>
        : <div role="status" aria-label="Loading apps" className="space-y-1.5">
            {Array.from({ length: 6 }, (_, index) => <div key={index} className="flex items-center gap-3 rounded-md border p-3">
                <Skeleton className="size-8 rounded-md" />
                <div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-24" /><Skeleton className="h-2.5 w-48" /></div>
            </div>)}
        </div>)
    const app = slug ? apps.find(item => item.slug === slug) : selected
    if (app) {
        const accounts = existingAccounts?.[app.slug] ?? []
        const names = new Set(accounts.map(account => account.toLowerCase()))
        let number = 2
        while (names.has((app.name + ' ' + number).toLowerCase())) number++
        const form = !editing && accounts.length > 0 && !app.multiInstance
            ? <p className="text-sm text-muted-foreground">This app already has an account in the Vault.</p>
            : <>
                {!editing && <label className="block space-y-1 text-sm">
                    Account name
                    <Input maxLength={120} disabled={busy} placeholder={accounts.length ? app.name + ' ' + number : app.name}
                        value={label} onChange={event => setLabel(event.target.value)} />
                </label>}
                {replacesSignIn && <p className="text-sm text-muted-foreground">Saving authentication will replace this app’s current browser sign-in.</p>}
                <DesktopServiceAccountForm identity={app.slug} methods={app.methods} saved={null}
                    disabled={busy} submitLabel={editing ? 'Save authentication' : 'Save app'}
                    oauthSubmitLabel={editing ? 'Save authentication' : 'Set up browser sign-in'}
                    onSubmit={(methodId, values) => onSave(app.slug, methodId, values, editing ? undefined : {
                        ...(label.trim() && { label: label.trim() }), expectedAccounts: accounts.length,
                    })}
                    onCancel={slug || editing ? onCancel : clearSelection} />
            </>
        if (paged) return <div className="flex h-full flex-col">
            <PanelEditorHeader title={app.name} onBack={slug ? onBack : busy ? undefined : clearSelection} backLabel={slug ? 'Back' : 'All apps'} />
            <PanelScroller className="space-y-4 p-4">
                {app.summary && <p className="text-sm text-muted-foreground">{app.summary}</p>}
                {form}
            </PanelScroller>
        </div>
        return (
            <div className="space-y-4">
                {!slug && <Button variant="ghost" size="sm" disabled={busy} onClick={clearSelection}><ArrowLeft />All apps</Button>}
                <header>
                    <h3 className="font-medium">{app.name}</h3>
                    {app.summary && <p className="text-sm text-muted-foreground">{app.summary}</p>}
                </header>
                {form}
            </div>
        )
    }
    if (slug) return frame(<p role="status" className="text-sm text-muted-foreground">This app has no authentication method available in the current catalog.</p>)

    const search = query.trim().toLowerCase()
    const matches = apps.filter(item => `${item.name} ${item.slug} ${item.summary}`.toLowerCase().includes(search))
    const rows = <>
        {!matches.length && <p className={paged ? 'py-6 text-center text-sm text-muted-foreground' : 'text-sm text-muted-foreground'}>No matching apps.</p>}
        {matches.map(item => <PanelRow key={item.slug} title={item.name} description={item.summary}
            footer={existingAccounts?.[item.slug]?.length ? (existingAccounts[item.slug].length + ' in Vault') : undefined}
            leading={<DesktopAppLogo logo={item.icon} className="size-8 rounded-md" />} actions={<ChevronRight className="size-4 text-muted-foreground" />}
            onClick={() => setSelected(item)} />)}
    </>
    if (paged) return <div className="flex h-full flex-col">
        {listHeader}
        <div className="border-b p-3">
            <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input aria-label="Search apps" placeholder="Search apps" className="pl-8" value={query} onChange={event => setQuery(event.target.value)} />
            </div>
        </div>
        <PanelScroller className="space-y-1.5 p-3">{rows}</PanelScroller>
    </div>
    return <div className="space-y-3">
        <h3 className="font-medium">Add an app</h3>
        <Input aria-label="Search apps" placeholder="Search apps" value={query} onChange={event => setQuery(event.target.value)} />
        {rows}
    </div>
}
