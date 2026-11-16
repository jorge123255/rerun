'use client'

import type { ReactNode } from 'react'
import { PanelEditorHeader } from '@/components/ui/panel-editor'
import { PanelScroller } from '@/components/ui/panel-list'
import { Segmented } from '@/components/ui/segmented'
import type { DesktopVaultMutation } from '@/lib/desktop/vault'
import { DesktopVaultCatalog } from './DesktopVaultCatalog'
import { ProgramForm, SecretForm, ServerForm } from './DesktopVaultForms'

export type VaultAddKind = 'app' | 'mcp' | 'secret' | 'program'

const KINDS: { value: VaultAddKind; label: string }[] = [
    { value: 'app', label: 'Apps' }, { value: 'mcp', label: 'MCP server' }, { value: 'secret', label: 'Secret' },
    // The Mac's own fourth kind: upstream types a command into its MCP form instead.
    { value: 'program', label: 'Local program' },
]

type Create = Extract<DesktopVaultMutation, { operation: 'create' | 'create-server' | 'create-program' }>

/**
 * "Add to the Vault": a segmented control over the searchable app catalog, the MCP server form, the
 * secret form and the Mac's local-program form. Layout from upstream VaultAddApp.tsx and
 * VaultAddOther.tsx; the forms and what they send are the Mac's own.
 * `slug` opens it on one app already picked, with no control to leave that app.
 */
export function DesktopVaultAdd({ kind, onKind, slug, busy, alert, existingAccounts, onBack, onCancel, onSaveApp, onCreate }: {
    kind: VaultAddKind
    onKind: (kind: VaultAddKind) => void
    slug?: string
    busy: boolean
    alert?: ReactNode
    existingAccounts: Record<string, string[]>
    /** The header's back arrow. None when the Vault was opened to add one app from a chat. */
    onBack?: () => void
    onCancel: () => void
    onSaveApp: (slug: string, methodId: string, values: Record<string, string>, account?: { label?: string; expectedAccounts: number }) => Promise<void>
    onCreate: (input: Create) => void
}) {
    const header = <>
        <PanelEditorHeader title="Add to the Vault" onBack={busy ? undefined : onBack} />
        <div className="border-b px-3 pt-3">
            <Segmented className="mb-3 w-full" value={kind} onChange={next => { if (!busy) onKind(next) }} options={KINDS} />
        </div>
    </>
    if (slug || kind === 'app') return <DesktopVaultCatalog slug={slug} busy={busy} existingAccounts={existingAccounts} listHeader={header}
        onBack={busy ? undefined : onBack} onCancel={onCancel} onSave={onSaveApp} />
    return <div className="flex h-full flex-col">
        {header}
        <PanelScroller className="space-y-4 p-4">
            {alert}
            {kind === 'secret' ? <SecretForm busy={busy} onSubmit={fields => onCreate({ operation: 'create', ...fields })} />
                : kind === 'mcp' ? <ServerForm busy={busy} onSubmit={fields => onCreate({ operation: 'create-server', ...fields })} />
                : <ProgramForm busy={busy} onSave={fields => onCreate({ operation: 'create-program', ...fields })} />}
        </PanelScroller>
    </div>
}
