'use client'

import { vaultAccountHealthText } from './vault-account-health'
import { DesktopVaultCatalog } from './DesktopVaultCatalog'
import { DesktopMcpOAuthAuthorize } from '../mcp/DesktopMcpOAuthAuthorize'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, ChevronRight, KeyRound, Plug, Plus } from 'lucide-react'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { PanelDialogContent } from '@/components/dialogs/PanelDialogContent'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSteps } from '@/components/ui/panel-steps'
import { PanelScroller } from '@/components/ui/panel-list'
import { desktopVaultListing, desktopVaultProgramCredentialLimit, type DesktopVaultEntry, type DesktopVaultListing, type DesktopVaultMutation } from '@/lib/desktop/vault'

type VaultRequest = DesktopVaultMutation | { operation: 'check-health'; id: string; revision: string }

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

export function DesktopVaultDialog({ onClose }: { onClose: () => void }) {
    return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
        <PanelDialogContent className="sm:h-[min(48rem,90dvh)] sm:max-w-2xl"
            onCloseAutoFocus={event => {
                event.preventDefault()
                document.querySelector<HTMLElement>('[aria-label^="Workspace menu,"]')?.focus({ preventScroll: true })
            }}>
            <DialogHeader className="border-b px-4 py-4 pr-12">
                <DialogTitle>Vault</DialogTitle>
                <DialogDescription>Store apps, MCP servers, and secrets for this workspace and choose their coworkers.</DialogDescription>
            </DialogHeader>
            <VaultPanel />
        </PanelDialogContent>
    </Dialog>
}

type VaultDestination = string | ((listing: DesktopVaultListing) => string)

function VaultPanel() {
    const [listing, setListing] = useState<DesktopVaultListing | null>(null)
    const [page, setPage] = useState('list')
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
    const navigate = (next: string) => { setError(''); setPage(next) }
    const stepKey = entry?.id ?? page
    const filtered = listing?.entries.filter(item => `${entryTitle(item)} ${entrySubtitle(item)}`.toLowerCase().includes(query.trim().toLowerCase()))
    const alert = error && <p className="text-sm text-destructive" role="alert">{error}</p>
    return <PanelSteps stepKey={stepKey} depth={stepKey === 'list' ? 0 : 1}>
        <PanelScroller className="space-y-4 p-4">
            {stepKey !== 'list' && <Button variant="ghost" size="sm" disabled={busy} onClick={() => navigate('list')}><ArrowLeft />Back</Button>}
            {alert}
            {!listing ? (error ? <Button variant="outline" disabled={busy} onClick={() => void run()}>Try again</Button> : <p role="status">Loading Vault…</p>)
                : page === 'add' ? <SecretForm busy={busy} onSubmit={fields => void run({ operation: 'create', ...fields }, 'list')} />
                : page === 'add-app' ? <DesktopVaultCatalog busy={busy} existingAccounts={accounts} onCancel={() => navigate('list')}
                    onSave={async (slug, methodId, values, account) => {
                        const previousIds = new Set(listing.entries.map(item => item.id))
                        const failure = await run({ operation: 'add-app', slug, methodId, values, ...account },
                            saved => saved.entries.find(item => !previousIds.has(item.id)
                                && 'kind' in item && item.kind === 'mcp' && item.catalog?.slug === slug)?.id ?? 'list', false)
                        if (failure) throw failure
                    }} />
                : page === 'add-server' ? <ServerForm busy={busy} onSubmit={fields => void run({ operation: 'create-server', ...fields }, 'list')} />
                : page === 'add-program' ? <ProgramForm busy={busy} onSave={fields => void run({ operation: 'create-program', ...fields }, 'list')} />
                : entry ? <VaultDetail key={entry.revision} entry={entry} coworkers={listing.coworkers} busy={busy} onSubmit={run} />
                : <>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="font-medium">Vault entries</h3>
                        <div className="flex flex-wrap gap-2">
                            <Button variant="outline" size="sm" disabled={busy} onClick={() => navigate('add-app')}><Plus />Add app</Button>
                            <Button variant="outline" size="sm" disabled={busy} onClick={() => navigate('add')}><Plus />Add secret</Button>
                            <Button variant="outline" size="sm" disabled={busy} onClick={() => navigate('add-server')}><Plus />Add MCP server</Button>
                            <Button variant="outline" size="sm" disabled={busy} onClick={() => navigate('add-program')}><Plus />Add local program</Button>
                        </div>
                    </div>
                    {listing.entries.length >= 8 && <Input aria-label="Search Vault" placeholder="Search Vault" value={query} onChange={event => setQuery(event.target.value)} />}
                    {listing.entries.length === 0 ? <p className="text-sm text-muted-foreground">No entries in this workspace.</p>
                        : filtered?.length === 0 ? <p className="text-sm text-muted-foreground">No matching entries.</p>
                        : (['Apps', 'MCP servers', 'Secrets'] as const).map(label => {
                            const items = filtered?.filter(item => entryGroup(item) === label)
                            return !!items?.length && <section key={label} className="space-y-2">
                                <h4 className="text-xs font-medium uppercase text-muted-foreground">{label}</h4>
                                {items.map(item => <PanelRow key={item.id} leading={'kind' in item ? <Plug className="size-4" /> : <KeyRound className="size-4" />} title={entryTitle(item)}
                                    description={`${entrySubtitle(item)} · ${item.sharedWithAll ? 'Every coworker' : item.agentIds.length ? `${item.agentIds.length} assigned` : 'Unassigned'}`}
                                    footer={'kind' in item && item.kind === 'mcp' && item.catalog ? vaultAccountHealthText(item.catalog.health) : undefined}
                                    actions={<ChevronRight className="size-4" />} onClick={() => navigate(item.id)} />)}
                            </section>
                        })}
                </>}
        </PanelScroller>
    </PanelSteps>
}

function entryTitle(entry: DesktopVaultEntry) {
    return 'kind' in entry && entry.kind === 'mcp' ? entry.catalog?.label ?? entry.catalog?.name ?? entry.name : entry.name
}

function entrySubtitle(entry: DesktopVaultEntry) {
    if (!('kind' in entry)) return entry.variable
    if (entry.kind === 'program') return entry.executable
    return entry.catalog?.label ? entry.catalog.name + ' · ' + entry.url : entry.url
}

function entryGroup(entry: DesktopVaultEntry) {
    if (!('kind' in entry)) return 'Secrets'
    return entry.kind === 'mcp' && entry.catalog ? 'Apps' : 'MCP servers'
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

type ServerCredential = { bearer: string; browserSignIn?: true; header?: { name: string; value: string } }

function readServerCredential(form: HTMLFormElement, data: FormData): ServerCredential {
    const value = String(data.get('credential') ?? '')
    const field = form.elements.namedItem('credential')
    if (field instanceof HTMLInputElement) field.value = ''
    if (data.get('authentication') === 'browser') return { bearer: '', browserSignIn: true }
    return data.get('authentication') === 'header'
        ? { bearer: '', header: { name: String(data.get('headerName')), value } }
        : { bearer: data.get('authentication') === 'bearer' ? value : '' }
}

function ServerCredentialFields({ busy, initial = 'none', headerName }: { busy: boolean; initial?: string; headerName?: string }) {
    const [mode, setMode] = useState(initial)
    return <fieldset disabled={busy} className="space-y-3">
        <label className="block space-y-1 text-sm">Authentication
            <select name="authentication" className="block h-9 w-full rounded-md border bg-background px-2 text-sm" value={mode} onChange={event => setMode(event.target.value)}>
                <option value="none">None</option>
                <option value="bearer">Bearer token</option>
                <option value="browser">Browser sign-in</option>
                <option value="header">Custom header</option>
            </select>
        </label>
        {mode === 'header' && <label className="block space-y-1 text-sm">Header name<Input name="headerName" placeholder="X-API-Key" required maxLength={128} defaultValue={headerName} /></label>}
        {(mode === 'header' || mode === 'bearer') && <label className="block space-y-1 text-sm">{mode === 'header' ? 'Header value' : 'Bearer token'}
            <Input key={mode} name="credential" type="password" autoComplete="new-password" required maxLength={8192} />
        </label>}
    </fieldset>
}

function ServerForm({ busy, onSubmit }: { busy: boolean; onSubmit: (input: { name: string; url: string } & ServerCredential) => void }) {
    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        const form = event.currentTarget
        const data = new FormData(form)
        onSubmit({ name: String(data.get('name')), url: String(data.get('url')), ...readServerCredential(form, data) })
    }
    return <form onSubmit={submit} className="space-y-4">
        <h3 className="font-medium">Add MCP server</h3>
        <label className="block space-y-1 text-sm">Name<Input name="name" required maxLength={64} pattern="[A-Za-z0-9_\-]+" disabled={busy} /></label>
        <label className="block space-y-1 text-sm">HTTPS endpoint<Input name="url" type="url" required maxLength={2048} disabled={busy} /></label>
        <ServerCredentialFields busy={busy} />
        <Button type="submit" disabled={busy}>Save MCP server</Button>
    </form>
}

type ProgramFields = { name: string; executable: string; args: string[] }

function ProgramForm({ busy, entry, onSave }: {
    busy: boolean; entry?: Extract<DesktopVaultEntry, { kind: 'program' }>; onSave: (input: ProgramFields) => void
}) {
    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        onSave({
            name: entry?.name ?? String(data.get('name')),
            executable: String(data.get('executable')),
            args: String(data.get('arguments')).split('\n').filter(Boolean),
        })
    }
    return <form onSubmit={submit} className="space-y-4">
        <h3 className="font-medium">{entry ? 'Review local program' : 'Add local program'}</h3>
        {!entry && <label className="block space-y-1 text-sm">Name<Input name="name" required maxLength={64} pattern="[A-Za-z0-9_\-]+" disabled={busy} /></label>}
        <label className="block space-y-1 text-sm">Executable path<Input name="executable" defaultValue={entry?.executable} required maxLength={4096} placeholder="/absolute/path/to/installed-server" disabled={busy} /></label>
        <label className="block space-y-1 text-sm">Arguments, one per line
            <textarea name="arguments" defaultValue={entry?.args.join('\n')} disabled={busy} className="block min-h-20 w-full rounded-md border bg-background p-2 font-mono text-sm" />
        </label>
        <p className="text-xs text-muted-foreground">Choose a program you trust. It runs with your Mac user’s access. Keep secrets out of arguments. Coworkers also need the Local MCP programs permission.</p>
        {!!entry?.credentialNames.length && <p className="text-xs text-muted-foreground">Changing the executable or its arguments clears saved credentials. Re-enter them after reviewing the program.</p>}
        <Button type="submit" disabled={busy}>{entry ? 'Save reviewed program' : 'Save local program'}</Button>
    </form>
}

function ProgramCredentials({ entry, busy, onSubmit }: {
    entry: Extract<DesktopVaultEntry, { kind: 'program' }>
    busy: boolean
    onSubmit: (input: DesktopVaultMutation) => void
}) {
    const [edit, setEdit] = useState<string | null>(null)
    const target = { id: entry.id, revision: entry.revision }
    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        const form = event.currentTarget
        const data = new FormData(form)
        const field = form.elements.namedItem('credential')
        if (field instanceof HTMLInputElement) field.value = ''
        onSubmit({ operation: 'set-program-credential', ...target, variable: edit || String(data.get('variable')), value: String(data.get('credential')) })
    }
    return <section className="space-y-3 border-t pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-medium">Program credentials</h4>
            <Button size="sm" variant="outline" disabled={busy || entry.credentialNames.length >= desktopVaultProgramCredentialLimit} onClick={() => setEdit('')}>Add credential</Button>
        </div>
        <p className="text-xs text-muted-foreground">These values are available only to this program when it runs for an assigned coworker.</p>
        {entry.credentialNames.map(variable => <div key={variable} className="flex flex-wrap items-center justify-between gap-2">
            <span className="break-all font-mono text-sm">{variable}</span>
            <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={busy} aria-label={`Replace ${variable}`} onClick={() => setEdit(variable)}>Replace</Button>
                <ConfirmDialog title={`Remove ${variable}?`} description="The program will no longer receive this credential." confirmLabel="Remove credential"
                    pending={busy} onConfirm={() => onSubmit({ operation: 'remove-program-credential', ...target, variable })}>
                    <Button size="sm" variant="outline" disabled={busy} aria-label={`Remove ${variable}`}>Remove</Button>
                </ConfirmDialog>
            </div>
        </div>)}
        {edit !== null && <form key={edit} onSubmit={submit} className="space-y-3">
            {edit ? <p className="font-mono text-sm">{edit}</p>
                : <label className="block space-y-1 text-sm">Variable name<Input name="variable" required maxLength={128} pattern="[A-Za-z_][A-Za-z0-9_]*" placeholder="SERVICE_API_KEY" disabled={busy} /></label>}
            <label className="block space-y-1 text-sm">Credential value<Input name="credential" type="password" autoComplete="new-password" required maxLength={8192} disabled={busy} /></label>
            <div className="flex gap-2">
                <Button size="sm" type="submit" disabled={busy}>Save credential</Button>
                <Button size="sm" type="button" variant="outline" disabled={busy} onClick={() => setEdit(null)}>Cancel</Button>
            </div>
        </form>}
    </section>
}

function VaultDetail({ entry, coworkers, busy, onSubmit }: {
    entry: DesktopVaultEntry
    coworkers: DesktopVaultListing['coworkers']
    busy: boolean
    onSubmit: (input: VaultRequest, next?: VaultDestination, showError?: boolean) => Promise<Error | null>
}) {
    const [agentIds, setAgentIds] = useState(entry.agentIds)
    const [sharedWithAll, setSharedWithAll] = useState(entry.sharedWithAll)
    const [replace, setReplace] = useState(false)
    const [renaming, setRenaming] = useState(false)
    const server = 'kind' in entry && entry.kind === 'mcp' ? entry : null
    const program = 'kind' in entry && entry.kind === 'program' ? entry : null
    const target = { id: entry.id, revision: entry.revision }
    const deleteLabel = program ? 'Delete local program' : server?.catalog ? 'Delete app' : server ? 'Delete MCP server' : 'Delete secret'
    const changed = sharedWithAll !== entry.sharedWithAll || agentIds.length !== entry.agentIds.length || agentIds.some(id => !entry.agentIds.includes(id))
    const users = entry.sharedWithAll ? 'every coworker' : coworkers.filter(coworker => entry.agentIds.includes(coworker.id)).map(coworker => coworker.name).join(', ')
    return <div className="space-y-5">
        <header>
            <h3 className="font-medium">{entryTitle(entry)}</h3>
            <p className="font-mono text-sm text-muted-foreground">{entrySubtitle(entry)}</p>
            {server && <p className="text-sm text-muted-foreground">{server.headerName ? `Header configured: ${server.headerName}` : server.hasBearer ? 'Bearer token configured' : server.browserSignIn ? 'Browser sign-in' : 'No authentication configured'}</p>}
        </header>
        {server?.catalog && <section className="space-y-2 border-t pt-4" aria-label="Account connection">
            <p role="status" className="text-sm">{vaultAccountHealthText(server.catalog.health)}</p>
            {server.catalog.health?.message && <p className="text-sm text-muted-foreground">{server.catalog.health.message}</p>}
            <Button size="sm" variant="outline" disabled={busy || replace || renaming}
                onClick={() => void onSubmit({ operation: 'check-health', ...target })}>Check connection</Button>
        </section>}
        <fieldset disabled={busy} className="space-y-3 border-t pt-4">
            <legend className="text-sm font-medium">Coworkers</legend>
            <p className="text-sm text-muted-foreground">{program ? 'Assigned coworkers can run this program when their Local MCP programs permission is on.' : server?.catalog ? 'Assigned coworkers can use this app when their Apps permission is on.' : server ? 'Assigned coworkers can use this server when their MCP permission is on.' : 'Assigned coworkers can use this variable in approved MCP credential references.'}</p>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sharedWithAll} onChange={event => setSharedWithAll(event.target.checked)} />Every coworker</label>
            {coworkers.map(coworker => <label key={coworker.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" disabled={sharedWithAll} checked={sharedWithAll || agentIds.includes(coworker.id)}
                    onChange={event => setAgentIds(ids => event.target.checked ? [...ids, coworker.id] : ids.filter(id => id !== coworker.id))} />
                {coworker.name}
            </label>)}
            <Button size="sm" disabled={busy || !changed} onClick={() => onSubmit({ operation: 'share', ...target, agentIds, sharedWithAll })}>Save assignments</Button>
        </fieldset>
        {server?.browserSignIn && <div className="space-y-2 border-t pt-4">
            <DesktopMcpOAuthAuthorize vaultId={server.id} name={server.name} revision={server.revision} active={!busy && !replace && !renaming} />
            <ConfirmDialog title="Disconnect browser sign-in?" description="Coworkers will need you to sign in again before using this connection."
                confirmLabel="Disconnect" pending={busy} onConfirm={() => onSubmit({ operation: 'clear-server-oauth', ...target })}>
                <Button size="sm" variant="outline" disabled={busy}>Disconnect browser sign-in</Button>
            </ConfirmDialog>
        </div>}
        {program && <ProgramCredentials entry={program} busy={busy} onSubmit={onSubmit} />}
        <div className="flex flex-wrap gap-2 border-t pt-4">
            {server?.catalog && <Button variant="outline" size="sm" disabled={busy} onClick={() => { setReplace(false); setRenaming(!renaming) }}>Rename account</Button>}
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { setRenaming(false); setReplace(!replace) }}>{program ? 'Review program' : server ? 'Change authentication' : 'Replace value'}</Button>
            <ConfirmDialog title={`Delete “${entryTitle(entry)}”?`} description={users ? `This removes the entry and its assignment for ${users}.` : 'This removes the entry from this workspace.'}
                confirmLabel={deleteLabel} pending={busy} onConfirm={() => onSubmit({ operation: 'delete', ...target }, 'list')}>
                <Button variant="outline" size="sm" disabled={busy}>{deleteLabel}</Button>
            </ConfirmDialog>
        </div>
        {renaming && server?.catalog && <form className="space-y-2" onSubmit={event => {
            event.preventDefault()
            const label = String(new FormData(event.currentTarget).get('label')).trim()
            if (label) void onSubmit({ operation: 'rename-app', ...target, label })
        }}>
            <label className="block space-y-1 text-sm">Account name
                <Input name="label" defaultValue={entryTitle(entry)} required maxLength={120} disabled={busy} />
            </label>
            <Button type="submit" size="sm" disabled={busy}>Save account name</Button>
        </form>}
        {replace && program && <ProgramForm busy={busy} entry={program} onSave={fields => onSubmit({ operation: 'replace-program', ...target, executable: fields.executable, args: fields.args })} />}
        {replace && server?.catalog && <DesktopVaultCatalog slug={server.catalog.slug} busy={busy}
            replacesSignIn={server.browserSignIn}
            onCancel={() => setReplace(false)} onSave={async (_slug, methodId, values) => {
                const failure = await onSubmit({ operation: 'configure-app', ...target, methodId, values }, undefined, false)
                if (failure) throw failure
            }} />}
        {replace && !program && !server?.catalog && <form className="space-y-3" onSubmit={event => {
            event.preventDefault()
            const form = event.currentTarget
            if (server) {
                const credential = readServerCredential(form, new FormData(form))
                if (credential.browserSignIn) {
                    if (server.browserSignIn) setReplace(false)
                    else onSubmit({ operation: 'enable-server-oauth', ...target })
                } else onSubmit(credential.header ? { operation: 'replace-server-header', ...target, header: credential.header }
                    : { operation: 'replace-server-bearer', ...target, bearer: credential.bearer })
            } else {
                const field = form.elements.namedItem('value')
                if (field instanceof HTMLInputElement) {
                    onSubmit({ operation: 'replace', ...target, value: field.value })
                    field.value = ''
                }
            }
        }}>
            {server ? <ServerCredentialFields busy={busy} headerName={server.headerName} initial={server.headerName ? 'header' : server.hasBearer ? 'bearer' : server.browserSignIn ? 'browser' : 'none'} />
                : <label className="block space-y-1 text-sm">New secret value<Input name="value" type="password" autoComplete="new-password" required maxLength={16384} disabled={busy} /></label>}
            <Button type="submit" size="sm" disabled={busy}>{server ? 'Save authentication' : 'Save new value'}</Button>
        </form>}
    </div>
}
