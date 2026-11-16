'use client'

import { useState, type ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PanelScroller } from '@/components/ui/panel-list'
import { PanelRow } from '@/components/ui/panel-row'
import { Switch } from '@/components/ui/switch'
import type { DesktopVaultEntry, DesktopVaultListing, DesktopVaultMutation } from '@/lib/desktop/vault'
import { DesktopMcpOAuthAuthorize } from '../mcp/DesktopMcpOAuthAuthorize'
import { DesktopVaultCatalog } from './DesktopVaultCatalog'
import { ProgramCredentials, ProgramForm, readServerCredential, ServerCredentialFields } from './DesktopVaultForms'
import { VaultEntryIcon, VaultStatusBadge } from './DesktopVaultTile'
import { entryLabel, entryName, entrySubtitle, entryTitle, vaultAccountHealthText } from './vault-account-health'

export type VaultRequest = DesktopVaultMutation | { operation: 'check-health'; id: string; revision: string }
export type VaultDestination = string | ((listing: DesktopVaultListing) => string)

/**
 * One entry of the Vault: where its sign-in stands, who uses it, and the way out. The back-arrow
 * header and the Coworkers group of switches are upstream VaultEntryDetail.tsx; each switch saves at
 * once through the same `share` change the Save assignments button sent, with the revision this
 * entry has now. The parent remounts the detail on every new revision. A refused save leaves the
 * switch where the Vault has it and shows the Vault's own message in `alert`.
 * Check connection, Rename, Replace key, Reconnect and Delete are the Mac's and stay here.
 */
export function DesktopVaultDetail({ entry, icon, coworkers, busy, alert, onBack, onSubmit, onUseInChat }: {
    entry: DesktopVaultEntry
    icon?: string | null
    coworkers: DesktopVaultListing['coworkers']
    busy: boolean
    alert?: ReactNode
    onBack?: () => void
    onUseInChat?: () => void
    onSubmit: (input: VaultRequest, next?: VaultDestination, showError?: boolean) => Promise<Error | null>
}) {
    const [replace, setReplace] = useState(false)
    const [renaming, setRenaming] = useState(false)
    const server = 'kind' in entry && entry.kind === 'mcp' ? entry : null
    const program = 'kind' in entry && entry.kind === 'program' ? entry : null
    const target = { id: entry.id, revision: entry.revision }
    const deleteLabel = program ? 'Delete local program' : server?.catalog ? 'Delete app' : server ? 'Delete MCP server' : 'Delete secret'
    const users = entry.sharedWithAll ? 'every coworker' : coworkers.filter(coworker => entry.agentIds.includes(coworker.id)).map(coworker => coworker.name).join(', ')
    const label = entryLabel(entry)
    const share = (agentIds: string[], sharedWithAll: boolean) => { void onSubmit({ operation: 'share', ...target, agentIds, sharedWithAll }) }
    return <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 border-b px-3 py-2.5">
            {onBack && <Button aria-label="Back" variant="ghost" size="icon-sm" className="shrink-0" disabled={busy} onClick={onBack}><ChevronLeft className="size-4" /></Button>}
            <VaultEntryIcon entry={entry} logo={icon} />
            <div className="flex min-w-0 flex-1 flex-col">
                <h3 className="truncate text-sm font-medium">{entryName(entry)}</h3>
                {label && <span className="truncate text-[11px] text-muted-foreground">{label}</span>}
            </div>
            <VaultStatusBadge entry={entry} />
        </div>
        <PanelScroller className="space-y-6 p-4">
            {alert}
            <div>
                <p className="font-mono text-sm break-all text-muted-foreground">{entrySubtitle(entry)}</p>
                {server && <p className="text-sm text-muted-foreground">{server.headerName ? `Header configured: ${server.headerName}` : server.hasBearer ? 'Bearer token configured' : server.browserSignIn ? 'Browser sign-in' : 'No authentication configured'}</p>}
            </div>
            {server?.catalog && <section className="space-y-2" aria-label="Account connection">
                <p role="status" className="text-sm">{vaultAccountHealthText(server.catalog.health, server.signedOut)}</p>
                {server.catalog.health?.message && <p className="text-sm text-muted-foreground">{server.catalog.health.message}</p>}
                <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" disabled={busy || replace || renaming}
                        onClick={() => void onSubmit({ operation: 'check-health', ...target })}>Check connection</Button>
                    {onUseInChat && server.catalog.health?.state === 'healthy' && !!server.catalog.health.toolCount
                        && <Button size="sm" disabled={busy} onClick={onUseInChat}>Use in chat</Button>}
                </div>
            </section>}
            {!onUseInChat && <section className="space-y-2" aria-label="Coworkers">
                <div className="flex h-6 items-center"><h4 className="text-sm font-medium text-muted-foreground">Coworkers</h4></div>
                <p className="text-xs text-muted-foreground">{program ? 'Assigned coworkers can run this program when their Local MCP programs permission is on.' : server?.catalog ? 'Assigned coworkers can use this app when their Apps permission is on.' : server ? 'Assigned coworkers can use this server when their MCP permission is on.' : 'Assigned coworkers can use this variable in approved MCP credential references.'}</p>
                <div className="space-y-1.5">
                    <PanelRow title="Every coworker" description="Each coworker of this workspace, now and later."
                        actions={<Switch aria-label="Every coworker" checked={entry.sharedWithAll} disabled={busy}
                            onCheckedChange={checked => share(entry.agentIds, checked)} />} />
                    {coworkers.length === 0 && <p className="px-1 text-xs text-muted-foreground">No coworkers in this workspace yet.</p>}
                    {coworkers.map(coworker => <PanelRow key={coworker.id} title={coworker.name}
                        actions={<Switch aria-label={coworker.name} checked={entry.sharedWithAll || entry.agentIds.includes(coworker.id)} disabled={busy || entry.sharedWithAll}
                            onCheckedChange={checked => share(checked ? [...entry.agentIds.filter(id => id !== coworker.id), coworker.id] : entry.agentIds.filter(id => id !== coworker.id), false)} />} />)}
                </div>
            </section>}
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
            {replace && server?.catalog && <DesktopVaultCatalog slug={server.catalog.slug} editing busy={busy}
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
                        else void onSubmit({ operation: 'enable-server-oauth', ...target })
                    } else void onSubmit(credential.header ? { operation: 'replace-server-header', ...target, header: credential.header }
                        : { operation: 'replace-server-bearer', ...target, bearer: credential.bearer })
                } else {
                    const field = form.elements.namedItem('value')
                    if (field instanceof HTMLInputElement) {
                        void onSubmit({ operation: 'replace', ...target, value: field.value })
                        field.value = ''
                    }
                }
            }}>
                {server ? <ServerCredentialFields busy={busy} headerName={server.headerName} initial={server.headerName ? 'header' : server.hasBearer ? 'bearer' : server.browserSignIn ? 'browser' : 'none'} />
                    : <label className="block space-y-1 text-sm">New secret value<Input name="value" type="password" autoComplete="new-password" required maxLength={16384} disabled={busy} /></label>}
                <Button type="submit" size="sm" disabled={busy}>{server ? 'Save authentication' : 'Save new value'}</Button>
            </form>}
        </PanelScroller>
    </div>
}
