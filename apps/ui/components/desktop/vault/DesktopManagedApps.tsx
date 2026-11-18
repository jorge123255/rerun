'use client'

import { useCallback, useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react'
import { desktopManagedAppsResultSchema, desktopManagedAppsViewSchema, type DesktopManagedAppsAction, type DesktopManagedAppsView } from '@rerun/contracts'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { invalidateDesktopConnectorApps } from '@/lib/desktop/use-connector-apps'
import { DesktopAppLogo } from './DesktopAppLogo'

const URL_PATH = '/api/desktop/managed-apps'

/**
 * Managed apps in the Vault: Gmail, Outlook and the other apps that are signed in through the
 * person's own Composio account. The key is typed here once and kept sealed on this Mac; the
 * sign-in to each app is held by Composio, which the section says before a key is given.
 */
export function DesktopManagedApps({ coworkers, disabled = false, onVaultChanged, onChooseCoworkers, initialSearch = '' }: { coworkers: readonly { id: string; name: string }[]; disabled?: boolean; onVaultChanged?: () => void; onChooseCoworkers?: (connector: string) => void; initialSearch?: string }) {
    const [view, setView] = useState<DesktopManagedAppsView | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [key, setKey] = useState('')
    const [query, setQuery] = useState(initialSearch)
    const [removeKey, setRemoveKey] = useState(false)
    // The accounts Composio could not be asked to sign out when the key was last removed: the key was kept for them.
    const [notSignedOut, setNotSignedOut] = useState<readonly string[]>([])
    const [added, setAdded] = useState('')
    // The account another one is being added beside, and the label typed for it.
    const [another, setAnother] = useState<{ id: string; label: string } | null>(null)

    const request = useRef<AbortController | null>(null)
    const [browserLink, setBrowserLink] = useState<{ id: string; href: string } | null>(null)
    const read = useCallback(async () => {
        if (request.current) return
        const controller = new AbortController()
        request.current = controller
        try {
            const response = await fetch(URL_PATH, { cache: 'no-store', signal: controller.signal })
            if (!response.ok) throw new Error()
            const result = desktopManagedAppsViewSchema.parse(await response.json())
            if (!controller.signal.aborted) setView(result)
        } catch {
            if (!controller.signal.aborted) setError('Could not load managed apps from the Vault.')
        } finally { if (request.current === controller) request.current = null }
    }, [])
    useEffect(() => {
        void read()
        return () => { request.current?.abort(); request.current = null }
    }, [read])

    const checkBrowserAccount = useEffectEvent(() => {
        const id = browserLink?.id
        if (id && !disabled && view?.accounts.some(row => row.id === id && row.status === 'pending')) void send({ action: 'refresh', id })
    })
    useEffect(() => {
        const onFocus = () => checkBrowserAccount()
        window.addEventListener('focus', onFocus)
        return () => window.removeEventListener('focus', onFocus)
    }, [])

    async function act(action: DesktopManagedAppsAction): Promise<boolean> {
        return (await send(action)) !== null
    }
    async function send(action: DesktopManagedAppsAction) {
        if (request.current) return null
        const controller = new AbortController()
        request.current = controller
        setBusy(true); setError('')
        try {
            const response = await fetch(URL_PATH, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) })
            const body = await response.json().catch(() => null)
            if (controller.signal.aborted) return null
            if (!response.ok) { setError(typeof body?.error === 'string' ? body.error : 'That did not go through. Try again.'); return null }
            const result = desktopManagedAppsResultSchema.parse(body)
            setView(result.view)
            if (action.action === 'attach') invalidateDesktopConnectorApps(action.agentId)
            else invalidateDesktopConnectorApps()
            // A Composio Connect key became a Vault connector: the Vault list above is read again to show it.
            if (result.addedToVault) { setAdded(result.addedToVault); onVaultChanged?.() }
            // The sign-in page opens in the browser; the app only ever asks Composio whether it finished.
            if (result.signIn && (action.action === 'connect' || action.action === 'refresh' && action.retry)) {
                const id = action.action === 'refresh' ? action.id : result.view.accounts.find(account =>
                    account.slug === action.slug && (account.label ?? '') === (action.label ?? '') && account.status === 'pending')?.id ?? null
                const href = new URL(result.signIn)
                if (href.protocol !== 'https:' || href.username || href.password) throw new Error('Invalid sign-in page')
                setBrowserLink(id && result.view.accounts.some(account => account.id === id && account.status === 'pending') ? { id, href: href.href } : null)
                window.open(href.href, '_blank', 'noopener,noreferrer')
            } else {
                setBrowserLink(previous => previous && result.view.accounts.some(account => account.id === previous.id && account.status === 'pending') ? previous : null)
            }
            return result
        } catch { if (!controller.signal.aborted) setError('That did not go through. Try again.'); return null }
        finally { if (request.current === controller) { request.current = null; setBusy(false) } }
    }

    if (!view) return <section aria-label="Managed apps" className="space-y-2 rounded-lg border border-border p-3">
        <h3 className="font-medium">Managed apps</h3>
        {error ? <><p role="alert" className="text-sm text-destructive">{error}</p>
            <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => { setError(''); void read() }}>Retry managed apps</Button></>
            : <p role="status" className="text-sm text-muted-foreground">Loading managed apps…</p>}
    </section>
    const locked = busy || disabled
    const taken = new Set(view.accounts.map(account => account.slug))
    const signsOut = view.keyRemovalSignsOut ?? 0
    // A project can offer more than a thousand apps: the list shows the first matches and search finds the rest.
    const SHOWN = 40
    const matches = view.apps.filter(app => !taken.has(app.slug) && `${app.name} ${app.slug} ${app.summary}`.toLowerCase().includes(query.trim().toLowerCase()))
    const offered = matches.slice(0, SHOWN)
    return (
        <section className="space-y-3 rounded-lg border border-border p-3" aria-label="Managed apps" data-testid="desktop-managed-apps">
            <div>
                <h3 className="font-medium">Managed apps</h3>
                <p className="text-sm text-muted-foreground">
                    {view.connector
                        ? `Every app Composio offers: ${view.apps.length} to choose from. Connect one and sign in in your browser. Assigning this connector gives the selected coworkers access to all its signed-in apps when their Custom MCP servers permission is on.`
                        : view.configured
                        ? `Every app in your Composio account: ${view.apps.length} to choose from. Their sign-ins are held by Composio.`
                        : 'Gmail, Google Calendar, Outlook and every other app Composio offers. They need your own Composio key, and you pay Composio for it.'}
                </p>
            </div>
            {view.connector && onChooseCoworkers && <Button type="button" size="sm" variant="outline" disabled={locked} onClick={() => onChooseCoworkers(view.connector!)}>Choose coworkers for Composio</Button>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {added && <p role="status" className="text-sm text-foreground">
                Composio was added to the Vault as “{added}”. Open it in the list above and choose its coworkers, then connect your apps below. A coworker’s sends and deletes still wait for your answer.
            </p>}
            {!view.configured ? (
                <form className="space-y-2" onSubmit={(event: FormEvent) => { event.preventDefault(); void act({ action: 'set-key', key: key.trim() }).then(saved => { if (saved) setKey('') }) }}>
                    <p className="text-sm text-muted-foreground">
                        Your sign-in to each app is held by Composio, not on this Mac, and a coworker’s calls to the app go through Composio. The key itself stays on this Mac and is never shown to a coworker. A Composio Connect key (it starts with ck_) works here too.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <Input aria-label="Composio key" type="password" autoComplete="off" spellCheck={false} placeholder="Composio key" className="min-w-0 flex-1"
                            value={key} disabled={locked} onChange={event => setKey(event.target.value)} />
                        <Button type="submit" size="sm" disabled={locked || key.trim().length < 8}>Save key</Button>
                    </div>
                </form>
            ) : (
                <>
                    {view.accounts.filter(account => `${account.name} ${account.label ?? ''} ${account.slug}`.toLowerCase().includes(query.trim().toLowerCase())).map(account => {
                        // Two accounts of one app are told apart by the label given to the second.
                        const title = account.label ? `${account.name} · ${account.label}` : account.name
                        const waiting = account.status !== 'active'
                        return (
                        <div key={account.id} className="space-y-2 rounded-md border border-border p-2.5" data-managed-account={account.slug}>
                            <div className="flex flex-wrap items-center gap-2">
                                <DesktopAppLogo logo={view.apps.find(app => app.slug === account.slug)?.logo} />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium">{title}</p>
                                    <p className={account.status === 'expired' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>{account.status === 'active' ? 'Signed in' : account.status === 'expired' ? 'The sign-in has expired. Sign in again to give it back to its coworkers.' : 'Waiting for you to finish signing in in your browser'}</p>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    {(waiting || view.connector) && <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => { void act({ action: 'refresh', id: account.id }) }}>Check sign-in</Button>}
                                    {waiting && browserLink?.id === account.id && <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => window.open(browserLink.href, '_blank', 'noopener,noreferrer')}>Open sign-in page</Button>}
                                    {waiting && <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => { void act({ action: 'refresh', id: account.id, retry: true }) }}>{account.status === 'expired' ? 'Sign in again' : browserLink?.id === account.id ? 'Get a new sign-in link' : 'Open sign-in again'}</Button>}
                                    <Button type="button" variant="ghost" size="sm" disabled={locked} aria-label={`Remove ${title}`} onClick={() => { void act({ action: 'remove', id: account.id }) }}>Remove</Button>
                                </div>
                            </div>
                            {account.status === 'active' && view.connector && <p className="text-xs text-muted-foreground">Shared through the “{view.connector}” connector. Removing this account signs it out at Composio.</p>}
                            {account.status === 'active' && !view.connector && (coworkers.length === 0
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
                            {!view.connector && (another?.id === account.id
                                ? <form className="flex flex-wrap gap-2" onSubmit={(event: FormEvent) => { event.preventDefault(); void act({ action: 'connect', slug: account.slug, label: another.label.trim() }).then(done => { if (done) setAnother(null) }) }}>
                                    <Input aria-label={`Label for another ${account.name} account`} placeholder="Label, such as Work or Personal" maxLength={40} className="min-w-0 flex-1"
                                        value={another.label} disabled={locked} onChange={event => setAnother({ id: account.id, label: event.target.value })} />
                                    <Button type="submit" size="sm" disabled={locked || !another.label.trim()}>Connect</Button>
                                    <Button type="button" variant="ghost" size="sm" disabled={locked} onClick={() => setAnother(null)}>Cancel</Button>
                                </form>
                                : <button type="button" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50" disabled={locked} aria-label={`Add another ${account.name} account`} onClick={() => setAnother({ id: account.id, label: '' })}>
                                    Add another account of this app
                                </button>)}
                        </div>
                        )
                    })}
                    <div className="space-y-2">
                        <Input aria-label="Search managed apps" placeholder="Search managed apps" value={query} onChange={event => setQuery(event.target.value)} />
                        <ul className="max-h-56 divide-y divide-border overflow-auto rounded-md border border-border">
                            {offered.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">No matching apps.</li>}
                            {offered.map(app => (
                                <li key={app.slug} className="flex items-center gap-3 px-3 py-2">
                                    <DesktopAppLogo logo={app.logo} />
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium">{app.name}</p>
                                        <p className="truncate text-xs text-muted-foreground">{app.summary}</p>
                                    </div>
                                    <Button type="button" variant="outline" size="sm" disabled={locked} aria-label={`Connect ${app.name}`} onClick={() => { void act({ action: 'connect', slug: app.slug }) }}>Connect</Button>
                                </li>
                            ))}
                        </ul>
                        {matches.length > SHOWN && <p className="text-xs text-muted-foreground">Showing {SHOWN} of {matches.length}. Search to find the others.</p>}
                    </div>
                    {view.connector && <button type="button" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50" disabled={locked} onClick={() => { void act({ action: 'find' }) }}>
                        {busy ? 'Working…' : 'Find apps already signed in at Composio'}
                    </button>}
                    {!view.connector && <button type="button" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50" disabled={locked} onClick={() => setRemoveKey(true)}>
                        Remove the Composio key
                    </button>}
                    <ConfirmDialog open={removeKey} onOpenChange={open => { setRemoveKey(open); if (!open) setNotSignedOut([]) }}
                        title={notSignedOut.length ? 'The key was kept' : 'Remove the Composio key?'}
                        description={notSignedOut.length
                            ? `Composio could not be reached or refused the key, so ${notSignedOut.length === 1 ? 'this account is' : 'these accounts are'} still signed in there: ${notSignedOut.join(', ')}. Cancel and try again later, or remove the key anyway and leave ${notSignedOut.length === 1 ? 'that sign-in' : 'those sign-ins'} at Composio. Without the key this Mac cannot sign them out later; you would do that in your Composio account.`
                            : `Every managed app account in this Vault is removed with it, and coworkers lose those apps. ${signsOut === 0 ? 'No account here has a sign-in at Composio to sign out.' : `${signsOut === 1 ? '1 account this Mac signed in is' : `${signsOut} accounts this Mac signed in are`} signed out at Composio first.`} Nothing else in your Composio account is touched.`}
                        confirmLabel={notSignedOut.length ? 'Remove key anyway' : 'Remove key'} pending={busy}
                        onConfirm={event => {
                            // The dialog stays open until Composio has answered: it either closes or says what was left.
                            event.preventDefault()
                            void send({ action: 'remove-key', ...(notSignedOut.length ? { leaveSignedIn: true } : {}) }).then(result => {
                                if (result?.notSignedOut?.length) setNotSignedOut(result.notSignedOut)
                                else { setRemoveKey(false); setNotSignedOut([]) }
                            })
                        }} />
                </>
            )}
        </section>
    )
}
