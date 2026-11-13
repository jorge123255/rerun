'use client'

import { useEffect, useState } from 'react'
import { ArrowLeft, ChevronRight, Plug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PanelRow } from '@/components/ui/panel-row'
import type { ServiceAccountMethod } from '@/lib/desktop/service-accounts-client'
import { DesktopServiceAccountForm } from '../services/accounts/DesktopServiceAccountForm'

type CatalogApp = { slug: string; name: string; summary: string; multiInstance: boolean; methods: ServiceAccountMethod[] }

export function DesktopVaultCatalog({ slug, busy, replacesSignIn, existingAccounts, onSave, onCancel }: {
    slug?: string
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

    if (error) return <p role="alert" className="text-sm text-destructive">Could not load the app catalog. Go back and try again.</p>
    if (!apps) return <p role="status" className="text-sm text-muted-foreground">Loading apps…</p>
    const app = slug ? apps.find(item => item.slug === slug) : selected
    if (app) {
        const accounts = existingAccounts?.[app.slug] ?? []
        const names = new Set(accounts.map(account => account.toLowerCase()))
        let number = 2
        while (names.has((app.name + ' ' + number).toLowerCase())) number++
        return (
            <div className="space-y-4">
                {!slug && <Button variant="ghost" size="sm" disabled={busy} onClick={clearSelection}><ArrowLeft />All apps</Button>}
                <header>
                    <h3 className="font-medium">{app.name}</h3>
                    {app.summary && <p className="text-sm text-muted-foreground">{app.summary}</p>}
                </header>
                {!slug && accounts.length > 0 && !app.multiInstance
                    ? <p className="text-sm text-muted-foreground">This app already has an account in the Vault.</p>
                    : <>
                        {!slug && <label className="block space-y-1 text-sm">
                            Account name
                            <Input maxLength={120} disabled={busy} placeholder={accounts.length ? app.name + ' ' + number : app.name}
                                value={label} onChange={event => setLabel(event.target.value)} />
                        </label>}
                        {replacesSignIn && <p className="text-sm text-muted-foreground">Saving authentication will replace this app’s current browser sign-in.</p>}
                        <DesktopServiceAccountForm identity={app.slug} methods={app.methods} saved={null}
                            disabled={busy} submitLabel={slug ? 'Save authentication' : 'Save app'}
                            oauthSubmitLabel={slug ? 'Save authentication' : 'Set up browser sign-in'}
                            onSubmit={(methodId, values) => onSave(app.slug, methodId, values, slug ? undefined : {
                                ...(label.trim() && { label: label.trim() }), expectedAccounts: accounts.length,
                            })}
                            onCancel={slug ? onCancel : clearSelection} />
                    </>}
            </div>
        )
    }
    if (slug) return <p role="status" className="text-sm text-muted-foreground">This app has no authentication method available in the current catalog.</p>

    const search = query.trim().toLowerCase()
    const matches = apps.filter(item => `${item.name} ${item.slug} ${item.summary}`.toLowerCase().includes(search))
    return <div className="space-y-3">
        <h3 className="font-medium">Add an app</h3>
        <Input aria-label="Search apps" placeholder="Search apps" value={query} onChange={event => setQuery(event.target.value)} />
        {!matches.length && <p className="text-sm text-muted-foreground">No matching apps.</p>}
        {matches.map(item => <PanelRow key={item.slug} title={item.name} description={item.summary}
            footer={existingAccounts?.[item.slug]?.length ? (existingAccounts[item.slug].length + ' in Vault') : undefined}
            leading={<Plug className="size-4" />} actions={<ChevronRight className="size-4" />}
            onClick={() => setSelected(item)} />)}
    </div>
}
