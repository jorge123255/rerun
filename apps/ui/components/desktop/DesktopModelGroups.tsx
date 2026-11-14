'use client'

import { useMemo, useState } from 'react'
import { ProviderIcon } from '@/lib/engine/provider-icons'
import { ChevronDownIcon, SearchIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'

type Group = { connectionId: string; name: string; provider: string; models: { id: string; label: string }[] }

/**
 * A model list by provider, one provider open at a time unless the person opens more: the one whose
 * model is in use starts open. Typing in the search shows the matches of every provider.
 */
export function useDesktopModelGroups<G extends Group>(catalog: readonly G[], activeConnectionId: string | null | undefined) {
    const [query, setQuery] = useState('')
    // What the person opened or closed by hand; a provider not listed follows the default.
    const [chosen, setChosen] = useState<Record<string, boolean>>({})
    const needle = query.trim().toLowerCase()
    const total = catalog.reduce((sum, group) => sum + group.models.length, 0)
    const groups = useMemo(() => catalog.map(group => {
        const models = needle ? group.models.filter(model => model.label.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle)) : group.models
        // A short list has nothing to fold away.
        const open = needle ? models.length > 0 : chosen[group.connectionId] ?? (catalog.length === 1 || total <= 8 || group.connectionId === activeConnectionId)
        return { group, models, open }
    }).filter(entry => !needle || entry.models.length > 0), [catalog, needle, chosen, activeConnectionId, total])
    return {
        query, setQuery, groups, total,
        searchable: total > 8,
        toggle: (connectionId: string, open: boolean) => setChosen(current => ({ ...current, [connectionId]: !open })),
    }
}

export function DesktopModelSearch({ value, onChange, label = 'Search models' }: { value: string; onChange(value: string): void; label?: string }) {
    return <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5">
        <SearchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <input type="search" aria-label={label} placeholder={label} value={value} onChange={event => onChange(event.target.value)}
            className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
    </label>
}

export function DesktopModelGroupHeader({ name, provider, count, open, searching, onToggle }: {
    name: string; provider: string; count: number; open: boolean; searching?: boolean; onToggle(): void
}) {
    return <button type="button" aria-expanded={open} disabled={searching} data-model-group={name}
        className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-muted/40 disabled:hover:bg-transparent" onClick={onToggle}>
        <ProviderIcon provider={provider} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span className="shrink-0 tabular-nums">{count}</span>
        {!searching && <ChevronDownIcon aria-hidden className={cn('size-3.5 shrink-0 transition-transform', !open && '-rotate-90')} />}
    </button>
}
