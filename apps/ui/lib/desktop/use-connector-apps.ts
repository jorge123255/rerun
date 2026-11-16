'use client'

import { useCallback, useSyncExternalStore } from 'react'
import { buildDesktopConnectorApps, desktopCoworkerConnectorsSchema, NO_CONNECTOR_APPS, type DesktopConnectorApps } from './connector-apps'

// One module-level store per coworker, shared by every reply of every open chat. A snapshot stays
// in place while a newer one is read, so rows never flash back to their generic icon.
const snapshots = new Map<string, { apps: DesktopConnectorApps; at: number }>()
const listeners = new Map<string, Set<() => void>>()
const inflight = new Set<string>()
// How many mounted replies of each coworker hold a step that may belong to an app.
const asking = new Map<string, number>()
/** A chat opened again this soon reuses what the last one read. */
const FRESH_MS = 30_000

async function load(agentId: string) {
    if (inflight.has(agentId)) return
    inflight.add(agentId)
    let apps = snapshots.get(agentId)?.apps ?? NO_CONNECTOR_APPS
    try {
        const response = await fetch(`/api/desktop/coworkers/${encodeURIComponent(agentId)}/connectors`, { cache: 'no-store', signal: AbortSignal.timeout(20_000) })
        if (response.ok) {
            const listing = desktopCoworkerConnectorsSchema.parse(await response.json())
            if (listing.agentId === agentId) apps = buildDesktopConnectorApps(listing)
        }
    } catch { /* Rows keep what they showed: the last snapshot, or today's generic row. */ }
    finally { inflight.delete(agentId) }
    snapshots.set(agentId, { apps, at: Date.now() })
    for (const listener of listeners.get(agentId) ?? []) listener()
}

function subscribe(agentId: string, wanted: boolean, listener: () => void) {
    let set = listeners.get(agentId)
    if (!set) listeners.set(agentId, set = new Set())
    // The first reply that needs the apps asks; the replies mounted beside it share that one read.
    const known = snapshots.get(agentId)
    if (wanted && !asking.has(agentId) && (!known || Date.now() - known.at > FRESH_MS)) void load(agentId)
    if (wanted) asking.set(agentId, (asking.get(agentId) ?? 0) + 1)
    set.add(listener)
    return () => {
        set.delete(listener)
        if (!wanted) return
        const left = (asking.get(agentId) ?? 1) - 1
        if (left > 0) asking.set(agentId, left)
        else asking.delete(agentId)
    }
}

/** After the coworker's apps change, so an open chat's rows follow. */
export function invalidateDesktopConnectorApps(agentId: string) {
    if (asking.has(agentId)) void load(agentId)
    else snapshots.delete(agentId)
}

export function resetDesktopConnectorAppsForTest() {
    snapshots.clear(); listeners.clear(); inflight.clear(); asking.clear()
}

/**
 * `wanted` is false for a reply with no step that could belong to an app: it reads nothing, so a
 * chat of plain replies and built-in tools never asks.
 */
export function useDesktopConnectorApps(agentId: string | undefined, wanted = true): DesktopConnectorApps {
    const subscribeTo = useCallback((callback: () => void) => agentId ? subscribe(agentId, wanted, callback) : () => {}, [agentId, wanted])
    return useSyncExternalStore(
        subscribeTo,
        () => agentId ? snapshots.get(agentId)?.apps ?? NO_CONNECTOR_APPS : NO_CONNECTOR_APPS,
        () => NO_CONNECTOR_APPS,
    )
}
