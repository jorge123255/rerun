'use client'

import type { TableCard } from '@rerun/contracts'
import { TableCard as TableCardBase } from '@rerun/ui/chat'
import type { DataFocus } from '@/lib/data/source'
import { desktopViewActions } from '@/lib/desktop/data-views'
import { desktopTableCardImageUrl, desktopTableCardOf } from '@/lib/desktop/table-card'
import type { DesktopDataScope } from '@/lib/desktop/data-scope'
import { useEffect, useMemo, useRef, useState } from 'react'

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
    if (!safe) return null
    return <TableCardTarget key={JSON.stringify([agentId, safe.scope, safe.table, safe.view])} card={safe} agentId={agentId} onOpen={onOpen} />
}

function TableCardTarget({ card, agentId, onOpen }: { card: TableCard; agentId?: string; onOpen?: (focus: DataFocus) => void }) {
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const request = useRef<AbortController | null>(null)
    const active = useRef(true)
    const latestOpen = useRef(onOpen)
    latestOpen.current = onOpen
    useEffect(() => {
        active.current = true
        return () => { active.current = false; request.current?.abort() }
    }, [])
    // Even shared cards need a real conversation owner; the payload itself is never authority.
    const scope: DesktopDataScope | null = !agentId ? null : card.scope === 'shared' ? { kind: 'shared' } : { kind: 'agent', agentId }
    const openTarget = async () => {
        if (!scope || !latestOpen.current || request.current) return
        if (!card.view) { latestOpen.current({ table: card.table }); return }
        const pending = new AbortController()
        request.current = pending
        setBusy(true)
        setError(null)
        try {
            // Resolve only on a deliberate Open. Replaying a frozen transcript never reads live
            // databases. A missing view or failed lookup must not fall back to another tab.
            const result = await desktopViewActions(scope).listViews(card.table)
            if (!active.current || pending.signal.aborted) return
            if (!result.success) throw new Error(result.error)
            const view = result.views.find(saved => saved.name === card.view || saved.name.toLowerCase() === card.view!.toLowerCase())
            if (!view) {
                setError(`The view “${card.view}” is no longer available. Choose a view in the Database view editor, or restore this saved view and try again.`)
                return
            }
            // An id keeps a same-name replacement or rename from selecting the wrong tab.
            latestOpen.current?.({ table: card.table, view: view.id })
        } catch (error) {
            if (active.current && !pending.signal.aborted) setError(error instanceof Error ? error.message : 'Could not open this view. Try again.')
        } finally {
            if (request.current === pending) request.current = null
            if (active.current && !pending.signal.aborted) setBusy(false)
        }
    }

    const open = onOpen && scope && !busy
        ? () => { void openTarget() }
        : undefined
    const reason = !scope ? 'Open this coworker’s chat to browse its database.' : busy ? 'Opening this saved view…' : undefined
    const fileUrl = (path: string) => card.scope === 'shared' ? null : desktopTableCardImageUrl(agentId, path)

    return <div data-desktop-table-card>
        <TableCardBase card={card} fileUrl={fileUrl} onOpen={open} openDisabledReason={reason} />
        {error && <p role="status" className="px-3 pt-1 text-[11px] text-muted-foreground">{error}</p>}
    </div>
}
