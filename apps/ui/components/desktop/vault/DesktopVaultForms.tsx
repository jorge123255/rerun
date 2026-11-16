'use client'

import { useState, type FormEvent } from 'react'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { desktopVaultProgramCredentialLimit, type DesktopVaultEntry, type DesktopVaultMutation } from '@/lib/desktop/vault'

// The Vault's own forms. What they collect and send is unchanged; the Add page and an entry's
// detail draw them. A typed value is cleared from its field as soon as it is handed on.

export function SecretForm({ busy, onSubmit }: { busy: boolean; onSubmit: (input: { name: string; variable: string; value: string }) => void }) {
    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        const form = event.currentTarget
        const data = new FormData(form)
        onSubmit({ name: String(data.get('name')), variable: String(data.get('variable')), value: String(data.get('value')) })
        const field = form.elements.namedItem('value')
        if (field instanceof HTMLInputElement) field.value = ''
    }
    return <form onSubmit={submit} className="space-y-4">
        <label className="block space-y-1 text-sm">Name<Input name="name" required maxLength={120} disabled={busy} /></label>
        <label className="block space-y-1 text-sm">Variable name<Input name="variable" placeholder="EXAMPLE_API_KEY" required maxLength={128} pattern="[A-Za-z_][A-Za-z0-9_]*" disabled={busy} /></label>
        <label className="block space-y-1 text-sm">Secret value<Input name="value" type="password" autoComplete="new-password" required maxLength={16384} disabled={busy} /></label>
        <Button type="submit" disabled={busy}>Save secret</Button>
    </form>
}

export type ServerCredential = { bearer: string; browserSignIn?: true; header?: { name: string; value: string } }

export function readServerCredential(form: HTMLFormElement, data: FormData): ServerCredential {
    const value = String(data.get('credential') ?? '')
    const field = form.elements.namedItem('credential')
    if (field instanceof HTMLInputElement) field.value = ''
    if (data.get('authentication') === 'browser') return { bearer: '', browserSignIn: true }
    return data.get('authentication') === 'header'
        ? { bearer: '', header: { name: String(data.get('headerName')), value } }
        : { bearer: data.get('authentication') === 'bearer' ? value : '' }
}

export function ServerCredentialFields({ busy, initial = 'none', headerName }: { busy: boolean; initial?: string; headerName?: string }) {
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

export function ServerForm({ busy, onSubmit }: { busy: boolean; onSubmit: (input: { name: string; url: string } & ServerCredential) => void }) {
    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        const form = event.currentTarget
        const data = new FormData(form)
        onSubmit({ name: String(data.get('name')), url: String(data.get('url')), ...readServerCredential(form, data) })
    }
    return <form onSubmit={submit} className="space-y-4">
        <label className="block space-y-1 text-sm">Name<Input name="name" required maxLength={64} pattern="[A-Za-z0-9_\-]+" disabled={busy} /></label>
        <label className="block space-y-1 text-sm">HTTPS endpoint<Input name="url" type="url" required maxLength={2048} disabled={busy} /></label>
        <ServerCredentialFields busy={busy} />
        <Button type="submit" disabled={busy}>Save MCP server</Button>
    </form>
}

export type ProgramFields = { name: string; executable: string; args: string[] }

export function ProgramForm({ busy, entry, onSave }: {
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
        {entry && <h3 className="font-medium">Review local program</h3>}
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

export function ProgramCredentials({ entry, busy, onSubmit }: {
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
