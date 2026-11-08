import { useState } from 'react'
import { Badge } from '@rerun/ui/primitives'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import type { DesktopSubscriptionProfileCatalog, DesktopSubscriptionProfileProvider } from './contract'
import { subscriptionProfileChoice, subscriptionProfileLimit } from './projection'

export function SubscriptionProfileSelector({ catalog, onSelect, onName, busy = false }: {
    catalog: DesktopSubscriptionProfileCatalog
    onSelect?: (profileId: string) => Promise<{ status: 'saved' | 'refused' | 'uncertain'; message: string }>
    onName?: (provider: DesktopSubscriptionProfileProvider, displayName: string) => Promise<{ status: 'saved' | 'refused' | 'uncertain'; message: string }>
    busy?: boolean
}) {
    const [notice, setNotice] = useState('')
    const [name, setName] = useState('')
    const [provider, setProvider] = useState<DesktopSubscriptionProfileProvider>('chatgpt')
    const limits = subscriptionProfileLimit(catalog)
    return (
        <section className="flex max-w-full flex-col gap-3" aria-label="Subscription profiles">
            <p className="text-sm text-muted-foreground">Each provider keeps one signed-in session. Adding a name does not connect an account or copy a credential.</p>
            <ul className="flex list-none flex-col gap-2 p-0">
                {limits.map(limit => <li key={limit} className="text-sm text-foreground">{limit}</li>)}
            </ul>
            <ul className="flex list-none flex-col gap-3 p-0">
                {catalog.profiles.map(profile => {
                    const choice = subscriptionProfileChoice(profile)
                    return (
                        <li key={profile.profileId} className="flex max-w-full flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="truncate font-medium">{profile.displayName}</span>
                                    <Badge size="sm" tone={choice.tone}>{choice.badge}</Badge>
                                </div>
                                <p className="mt-1 text-sm text-muted-foreground">{choice.detail}</p>
                            </div>
                            <button
                                type="button"
                                className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md border px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                                disabled={busy || choice.disabled || !onSelect}
                                onClick={() => { if (!onSelect) return; void onSelect(profile.profileId).then(result => setNotice(result.message)) }}
                            >Use this session</button>
                        </li>
                    )
                })}
            </ul>
            <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={event => { event.preventDefault(); if (!onName || !name.trim()) return; void onName(provider, name.trim()).then(result => { setNotice(result.message); if (result.status === 'saved') setName('') }) }}>
                <Field label="Provider" htmlFor="subscription-profile-provider">
                    <select id="subscription-profile-provider" className="min-h-11 rounded-md border bg-background px-2" value={provider} onChange={event => setProvider(event.target.value as DesktopSubscriptionProfileProvider)}>
                        <option value="chatgpt">ChatGPT</option>
                        <option value="claude">Claude</option>
                    </select>
                </Field>
                <Input label="Profile name" value={name} onChange={event => setName(event.target.value)} maxLength={120} />
                <button type="submit" className="inline-flex min-h-11 items-center justify-center rounded-md border px-3 py-2 text-sm" disabled={busy || !onName}>Save unavailable profile</button>
            </form>
            {notice ? <p className="text-sm text-foreground" role="status">{notice}</p> : null}
        </section>
    )
}
