'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { desktopManagedAppsResultSchema, desktopManagedAppsViewSchema, type DesktopManagedAppsAction, type DesktopManagedAppsView } from '@rerun/contracts'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const URL_PATH = '/api/desktop/managed-apps'

/**
 * Managed apps in the Vault: Gmail, Outlook and the other apps that are signed in through the
 * person's own Composio account. The key is typed here once and kept sealed on this Mac; the
 * sign-in to each app is held by Composio, which the section says before a key is given.
 */
export function DesktopManagedApps({ coworkers, disabled = false }: { coworkers: readonly { id: string; name: string }[]; disabled?: boolean }) {
    const [view, setView] = useState<DesktopManagedAppsView | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [key, setKey] = useState('')
    const [query, setQuery] = useState('')
    const [removeKey, setRemoveKey] = useState(false)

    const read = useCallback(async () => {
        try {
            const response = await fetch(URL_PATH, { cache: 'no-store' })
            if (response.ok) setView(desktopManagedAppsViewSchema.parse(await response.json()))
        } catch { /* The rest of the Vault works without this section. */ }
    }, [])
    useEffect(() => { void read() }, [read])

    async function act(action: DesktopManagedAppsAction): Promise<boolean> {
        setBusy(true); setError('')
        try {
            const response = await fetch(URL_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) })
            const body = await response.json().catch(() => null)
            if (!response.ok) { setError(typeof body?.error === 'string' ? body.error : 'That did not go through. Try again.'); return false }
            const result = desktopManagedAppsResultSchema.parse(body)
            setView(result.view)
            // The sign-in page opens in the browser; the app only ever asks Composio whether it finished.
            if (result.signIn) window.open(result.signIn, '_blank', 'noopener,noreferrer')
            return true
        } catch { setError('That did not go through. Try again.'); return false }
        finally { setBusy(false) }
    }

    if (!view) return null
    const locked = busy || disabled
    const taken = new Set(view.accounts.map(account => account.slug))
    const offered = view.apps.filter(app => !taken.has(app.slug) && `${app.name} ${app.summary}`.toLowerCase().includes(query.trim().toLowerCase()))
    return (
        <section className="space-y-3 rounded-lg border border-border p-3" aria-label="Managed apps" data-testid="desktop-managed-apps">
            <div>
                <h3 className="font-medium">Managed apps</h3>
                <p className="text-sm text-muted-foreground">
                    Gmail, Google Calendar, Outlook and {Math.max(0, view.apps.length - 3)} more apps sign in through Composio. They need your own Composio key, and you pay Composio for it.
                </p>
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {!view.configured ? (
                <form className="space-y-2" onSubmit={(event: FormEvent) => { event.preventDefault(); void act({ action: 'set-key', key: key.trim() }).then(saved => { if (saved) setKey('') }) }}>
                    <p className="text-sm text-muted-foreground">
                        Your sign-in to each app is held by Composio, not on this Mac, and a coworker’s calls to the app go through Composio. The key itself stays on this Mac and is never shown to a coworker.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <Input aria-label="Composio key" type="password" autoComplete="off" spellCheck={false} placeholder="Composio key" className="min-w-0 flex-1"
                            value={key} disabled={locked} onChange={event => setKey(event.target.value)} />
                        <Button type="submit" size="sm" disabled={locked || key.trim().length < 8}>Save key</Button>
                    </div>
                </form>
            ) : (
                <>
                    {view.accounts.map(account => (
                        <div key={account.id} className="space-y-2 rounded-md border border-border p-2.5" data-managed-account={account.slug}>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-medium">{account.name}</p>
                                    <p className="text-xs text-muted-foreground">{account.status === 'active' ? 'Signed in' : 'Waiting for you to finish signing in in your browser'}</p>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    {account.status === 'pending' && <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => { void act({ action: 'refresh', id: account.id }) }}>Check sign-in</Button>}
                                    <Button type="button" variant="ghost" size="sm" disabled={locked} aria-label={`Remove ${account.name}`} onClick={() => { void act({ action: 'remove', id: account.id }) }}>Remove</Button>
                                </div>
                            </div>
                            {account.status === 'active' && (coworkers.length === 0
                                ? <p className="text-xs text-muted-foreground">No coworkers in this workspace yet.</p>
                                : <fieldset className="flex flex-wrap gap-x-4 gap-y-1" disabled={locked}>
                                    <legend className="mb-1 text-xs text-muted-foreground">Coworkers that may use it</legend>
                                    {coworkers.map(coworker => (
                                        <label key={coworker.id} className="flex items-center gap-1.5 text-sm">
                                            <input type="checkbox" checked={account.agentIds.includes(coworker.id)}
                                                onChange={event => { void act({ action: 'attach', id: account.id, agentId: coworker.id, attached: event.target.checked }) }} />
                                            {coworker.name}
                                        </label>
                                    ))}
                                </fieldset>)}
                        </div>
                    ))}
                    <div className="space-y-2">
                        <Input aria-label="Search managed apps" placeholder="Search managed apps" value={query} onChange={event => setQuery(event.target.value)} />
                        <ul className="max-h-56 divide-y divide-border overflow-auto rounded-md border border-border">
                            {offered.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">No matching apps.</li>}
                            {offered.map(app => (
                                <li key={app.slug} className="flex items-center justify-between gap-3 px-3 py-2">
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-medium">{app.name}</p>
                                        <p className="truncate text-xs text-muted-foreground">{app.summary}</p>
                                    </div>
                                    <Button type="button" variant="outline" size="sm" disabled={locked} aria-label={`Connect ${app.name}`} onClick={() => { void act({ action: 'connect', slug: app.slug }) }}>Connect</Button>
                                </li>
                            ))}
                        </ul>
                    </div>
                    <button type="button" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50" disabled={locked} onClick={() => setRemoveKey(true)}>
                        Remove the Composio key
                    </button>
                    <ConfirmDialog open={removeKey} onOpenChange={setRemoveKey} title="Remove the Composio key?"
                        description="Every managed app account in this Vault is removed with it, and coworkers lose those apps."
                        confirmLabel="Remove key" pending={busy} onConfirm={() => { void act({ action: 'remove-key' }).then(() => setRemoveKey(false)) }} />
                </>
            )}
        </section>
    )
}
