'use client'

import { Lock, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { PANEL_CARD, PANEL_CARD_INTERACTIVE } from '@/components/ui/panel-row'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { VaultEntryIcon } from './DesktopVaultTile'
import type { VaultAddKind } from './DesktopVaultAdd'

const POPULAR_SHOWN = 6

// Upstream offers an empty Vault six popular apps. Two of its six (Slack, HubSpot) are not apps this
// Mac can add from its own catalog, so the list is longer and only the first six the catalog has
// are shown. An app that is not there would open an empty Add page.
const POPULAR_APPS = ['notion', 'slack', 'hubspot', 'linear', 'github', 'airtable', 'asana', 'jira', 'intercom', 'dropbox', 'zapier', 'clickup'] as const
export function popularVaultApps(catalog: Record<string, { name: string; icon?: string | null }>): { slug: string; name: string; icon?: string | null }[] {
    return POPULAR_APPS.filter(slug => catalog[slug]).slice(0, POPULAR_SHOWN).map(slug => ({ slug, ...catalog[slug] }))
}

const OTHER: { kind: VaultAddKind; label: string }[] = [
    { kind: 'app', label: 'Other app' }, { kind: 'mcp', label: 'MCP server' }, { kind: 'secret', label: 'Secret' },
    // The Mac's own: a program installed on this Mac, which the cloud has no place for.
    { kind: 'program', label: 'Local program' },
]

/**
 * An empty Vault offers the apps people add first, one click each, rather than a sentence about
 * them. Markup from upstream VaultEmpty.tsx; `apps` is null until the catalog is read.
 */
export function DesktopVaultEmpty({ apps, busy, onPick, onAdd }: {
    apps: { slug: string; name: string; icon?: string | null }[] | null
    busy: boolean
    onPick: (slug: string) => void
    onAdd: (kind: VaultAddKind) => void
}) {
    return <div className="my-auto flex flex-col items-center gap-5 py-4 text-center">
        <Icon icon={Lock} size="xl" />
        <p className="text-sm font-medium">Sign in once, share with your coworkers</p>
        {apps?.length !== 0 && <section aria-label="Popular apps" className="grid w-full max-w-sm grid-cols-3 gap-2">
            {apps === null ? Array.from({ length: POPULAR_SHOWN }, (_, index) => <div key={index} className="flex flex-col items-center gap-2 rounded-md border p-3">
                <Skeleton className="size-8 rounded-lg" />
                <Skeleton className="h-3 w-14" />
            </div>) : apps.map(app => <button key={app.slug} type="button" disabled={busy} onClick={() => onPick(app.slug)}
                className={cn(PANEL_CARD, PANEL_CARD_INTERACTIVE, 'flex w-full min-w-0 flex-col items-center gap-2 p-3 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60')}>
                <VaultEntryIcon logo={app.icon} />
                <span className="w-full truncate text-xs">{app.name}</span>
            </button>)}
        </section>}
        <div className="flex flex-wrap items-center justify-center gap-2">
            {OTHER.map(({ kind, label }) => <Button key={kind} size="xs" variant="secondary" disabled={busy} onClick={() => onAdd(kind)}><Plus className="size-3" />{label}</Button>)}
        </div>
    </div>
}
