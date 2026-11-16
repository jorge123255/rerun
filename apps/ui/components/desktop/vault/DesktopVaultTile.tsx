'use client'

import type { ReactNode } from 'react'
import { KeyRound, Server, SquareTerminal } from 'lucide-react'
import { Icon } from '@/components/ui/icon'
import { PANEL_CARD, PANEL_CARD_INTERACTIVE } from '@/components/ui/panel-row'
import type { DesktopVaultEntry } from '@/lib/desktop/vault'
import { cn } from '@/lib/utils'
import { AgentBuddy } from '@rerun/ui/iso-grid'
import { Badge } from '@rerun/ui/primitives'
import { DesktopAppLogo, desktopAppLogoSource } from './DesktopAppLogo'
import { entryGroup, entryLabel, entryName, vaultEntryStatus } from './vault-account-health'

type Coworker = { id: string; name: string }
type Usage = Pick<DesktopVaultEntry, 'sharedWithAll' | 'agentIds'>

const SHOWN_FACES = 3

/**
 * Who uses an entry, drawn rather than written: the coworkers' board avatars, "All" when it is shared
 * with everyone, "+N" past three. Nothing at all for an entry nobody uses. The faces are decorative,
 * so the sentence they replace stays on the group. Markup from upstream VaultCoworkerFaces.tsx.
 */
export function VaultCoworkerFaces({ usage, coworkers, size = 24, className }: { usage: Usage; coworkers: readonly Coworker[]; size?: number; className?: string }) {
    const assigned = usage.agentIds.map(id => coworkers.find(coworker => coworker.id === id)).filter((coworker): coworker is Coworker => !!coworker)
    if (!usage.sharedWithAll && assigned.length === 0) return null
    const summary = usage.sharedWithAll ? 'Every coworker' : `Used by ${assigned.map(coworker => coworker.name).join(', ')}`
    const more = assigned.length - SHOWN_FACES
    return <span role="img" aria-label={summary} title={summary} className={cn('flex shrink-0 items-center', className)}>
        {usage.sharedWithAll ? <Badge size="xs" tone="neutral" glow={false}>All</Badge> : <>
            {assigned.slice(0, SHOWN_FACES).map((coworker, index) => <AgentBuddy key={coworker.id} agentId={coworker.id} size={size} animated={false} facing="right" className={cn(index > 0 && '-ml-2')} />)}
            {more > 0 && <span className="ml-1 text-xs text-muted-foreground tabular-nums">+{more}</span>}
        </>}
    </span>
}

/** Where an entry's sign-in stands, when something is wrong with it. After upstream VaultStatusBadge (VaultPanel.tsx). */
export function VaultStatusBadge({ entry }: { entry: DesktopVaultEntry }) {
    const status = vaultEntryStatus(entry)
    return status && <Badge size="xs" tone={status.tone} glow={false}>{status.label}</Badge>
}

/** An app's logo in the tile the cloud draws its service icons in; an MCP server, program or secret gets its glyph. */
export function VaultEntryIcon({ entry, logo, size = 'sm' }: { entry?: DesktopVaultEntry; logo?: string | null; size?: 'sm' | 'md' }) {
    if (desktopAppLogoSource(logo)) return <DesktopAppLogo logo={logo} className={size === 'md' ? 'size-10 rounded-lg' : 'size-8 rounded-md'} />
    const group = entry ? entryGroup(entry) : 'app'
    return <Icon icon={group === 'secret' ? KeyRound : group === 'program' ? SquareTerminal : Server} size={size} />
}

/**
 * One app account as a tile: its logo first, what is wrong with it if anything, then the account it
 * is signed in with and the coworkers that use it. Markup from upstream VaultAppTile.tsx.
 */
export function VaultAppTile({ entry, icon, coworkers, onOpen, badges }: { entry: DesktopVaultEntry; icon?: string | null; coworkers: readonly Coworker[]; onOpen: () => void; badges?: ReactNode }) {
    const status = <VaultStatusBadge entry={entry} />
    return <button type="button" onClick={onOpen} data-vault-tile={entry.id}
        className={cn(PANEL_CARD, PANEL_CARD_INTERACTIVE, 'flex min-w-0 flex-col items-start gap-3 p-3 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none')}>
        <span className="flex w-full items-start justify-between gap-2">
            <VaultEntryIcon entry={entry} logo={icon} size="md" />
            <span className="flex min-w-0 flex-wrap justify-end gap-1" data-vault-badges>{badges}{status}</span>
        </span>
        <span className="flex w-full min-w-0 flex-col gap-0.5">
            <span className="truncate text-sm font-medium">{entryName(entry)}</span>
            {/* An empty line rather than none, so the tiles of a row keep their faces on one line. */}
            <span className="truncate text-xs text-muted-foreground">{entryLabel(entry) || ' '}</span>
        </span>
        <span className="flex h-6 items-center"><VaultCoworkerFaces usage={entry} coworkers={coworkers} /></span>
    </button>
}
