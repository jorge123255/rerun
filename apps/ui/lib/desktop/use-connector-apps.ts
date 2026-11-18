'use client'

import { useCallback, useSyncExternalStore } from 'react'
import { buildDesktopConnectorApps, desktopCoworkerConnectorsSchema, NO_CONNECTOR_APPS, type DesktopConnectorApps } from './connector-apps'

// One module-level store per coworker, shared by every reply of every open chat. A snapshot stays
// in place while a newer one is read, so rows never flash back to their generic icon.
const snapshots = new Map<string, { apps: DesktopConnectorApps; at: number }>()
const listeners = new Map<string, Set<() => void>>()
const inflight = new Map<string, AbortController>()
// How many mounted replies of each coworker hold a step that may belong to an app.
const asking = new Map<string, number>()
/** A chat opened again this soon reuses what the last one read. */
const FRESH_MS = 30_000

async function load(agentId: string) {
    if (inflight.has(agentId)) return
    const controller = new AbortController()
    inflight.set(agentId, controller)
    let apps = snapshots.get(agentId)?.apps ?? NO_CONNECTOR_APPS
    try {
        const response = await fetch(`/api/desktop/coworkers/${encodeURIComponent(agentId)}/connectors`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) })
        if (response.ok) {
            const listing = desktopCoworkerConnectorsSchema.parse(await response.json())
            if (listing.agentId === agentId) apps = buildDesktopConnectorApps(listing)
        }
    } catch { /* Rows keep what they showed: the last snapshot, or today's generic row. */ }
    finally { if (inflight.get(agentId) === controller) inflight.delete(agentId) }
    if (controller.signal.aborted) return
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

export const DESKTOP_CONNECTOR_APPS_CHANGED = 'rerun:connector-apps-changed'

/** Refresh visible chat annotations and the open coworker Apps list after a Vault change. */
export function invalidateDesktopConnectorApps(agentId?: string) {
    for (const id of agentId ? [agentId] : new Set([...asking.keys(), ...snapshots.keys(), ...inflight.keys()])) {
        inflight.get(id)?.abort()
        inflight.delete(id)
        if (asking.has(id)) void load(id)
        else snapshots.delete(id)
    }
    window.dispatchEvent(new CustomEvent(DESKTOP_CONNECTOR_APPS_CHANGED, { detail: agentId }))
}

export function resetDesktopConnectorAppsForTest() {
    for (const controller of inflight.values()) controller.abort()
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
