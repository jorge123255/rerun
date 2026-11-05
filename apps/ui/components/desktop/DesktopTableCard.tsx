'use client'

import type { TableCard } from '@rerun/contracts'
import { TableCard as TableCardBase } from '@rerun/ui/chat'
import type { DataFocus } from '@/lib/data/source'
import { desktopViewActions } from '@/lib/desktop/data-views'
import { desktopTableCardFocus, desktopTableCardImageUrl, desktopTableCardOf } from '@/lib/desktop/table-card'
import type { DesktopDataScope } from '@/lib/desktop/data-scope'
import { useEffect, useMemo, useState } from 'react'

/**
 * A table card in a Mac conversation. It reuses the web card's layouts and frame unchanged and adds
 * only what this host knows: the authenticated image route, the panel to open, and the truth about a
 * view that no longer exists. Root supplies `onOpen`, because only it knows where a database panel
 * lives in this build.
 */
export function DesktopTableCard({ card, agentId, onOpen }: {
    card: TableCard
    /** The coworker that owns this conversation. Its Files are the only ones a picture cell may read. */
    agentId?: string
    onOpen?: (focus: DataFocus) => void
}) {
    const safe = useMemo(() => desktopTableCardOf(card), [card])
    const [missingView, setMissingView] = useState<string | null>(null)
    const cardScope = safe?.scope
    const scope = useMemo<DesktopDataScope | null>(
        () => cardScope === 'shared' ? { kind: 'shared' } : agentId ? { kind: 'agent', agentId } : null,
        [cardScope, agentId],
    )
    const table = safe?.table
    const view = safe?.view

    // A deleted view must not quietly become another view: the browser falls back to a remembered
    // one, so the card says the view is gone and opens the table for the user to pick again.
    useEffect(() => {
        setMissingView(null)
        if (!scope || !table || !view) return
        let cancelled = false
        void desktopViewActions(scope).listViews(table).then(result => {
            if (cancelled || !result.success) return
            if (!result.views.some(saved => saved.name === view || saved.name.toLowerCase() === view.toLowerCase())) setMissingView(view)
        })
        return () => { cancelled = true }
    }, [scope, table, view])

    if (!safe) return null

    const open = onOpen && scope
        ? () => onOpen(missingView ? { table: safe.table } : desktopTableCardFocus(safe))
        : undefined
    const reason = scope ? undefined : 'Open this coworker’s chat to browse its database.'
    const fileUrl = (path: string) => safe.scope === 'shared' ? null : desktopTableCardImageUrl(agentId, path)

    return <div data-desktop-table-card>
        <TableCardBase card={safe} fileUrl={fileUrl} onOpen={open} openDisabledReason={reason} />
        {missingView && <p className="px-3 pt-1 text-[11px] text-muted-foreground">
            The view “{missingView}” was deleted. Open the table to choose another view, or save a new one in the Database view editor.
        </p>}
    </div>
}
