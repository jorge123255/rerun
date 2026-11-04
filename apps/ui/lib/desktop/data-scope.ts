import type { RowFilter } from '@rerun/contracts'

/**
 * Which SQLite database a Mac data browser is looking at.
 *
 * A coworker's private database and the workspace shared database are two different files with
 * two different permissions. Nothing here turns one scope into the other: the scope is fixed by
 * the panel that opened the browser, and the route it addresses carries no database selector.
 */
export type DesktopDataScope = { kind: 'agent'; agentId: string } | { kind: 'shared' }

/** The browser's page size is bounded so one request can never stream a whole table back. */
export const DESKTOP_DATA_PAGE_MAX = 200
export const DESKTOP_DATA_DEFAULT_PAGE = 25
/** A search term, a sort column and a filter are all short pieces of UI state, not SQL. */
export const DESKTOP_DATA_TERM_MAX = 200
export const DESKTOP_DATA_MAX_FILTERS = 8
export const DESKTOP_DATA_MAX_ROWIDS = 500
export const DESKTOP_DATA_MAX_COLUMNS = 64

export type DesktopDataExportParams = {
    format: 'csv' | 'json'
    sort?: string
    dir?: 'asc' | 'desc'
    q?: string
    where?: RowFilter[]
}

/** The authenticated desktop adapter for this scope. The two scopes never share a prefix. */
export function desktopDataBase(scope: DesktopDataScope): string {
    return scope.kind === 'agent'
        ? `/api/desktop/agents/${encodeURIComponent(scope.agentId)}/data`
        : '/api/desktop/shared-data'
}

/** Distinguishes the two databases when the last view opened on each table is remembered. */
export function desktopDataStorageKey(scope: DesktopDataScope): string {
    return scope.kind === 'agent' ? `desktop-agent:${scope.agentId}` : 'desktop-shared'
}

export function desktopDataExportUrl(scope: DesktopDataScope, table: string, params: DesktopDataExportParams): string {
    const qs = new URLSearchParams({ table, format: params.format })
    if (params.sort) qs.set('sort', params.sort)
    if (params.dir) qs.set('dir', params.dir)
    if (params.q) qs.set('q', params.q)
    if (params.where?.length) qs.set('where', JSON.stringify(params.where))
    return `${desktopDataBase(scope)}/export?${qs.toString()}`
}

/** Clamps what the browser asks for; shared by the adapter and its tests. */
export function clampDesktopPage(limit: unknown, fallback = DESKTOP_DATA_DEFAULT_PAGE): number {
    const value = typeof limit === 'number' ? limit : Number(limit)
    if (!Number.isFinite(value) || value < 1) return fallback
    return Math.min(Math.floor(value), DESKTOP_DATA_PAGE_MAX)
}

export function clampDesktopOffset(offset: unknown): number {
    const value = typeof offset === 'number' ? offset : Number(offset)
    if (!Number.isFinite(value) || value < 0) return 0
    return Math.min(Math.floor(value), 1_000_000)
}
