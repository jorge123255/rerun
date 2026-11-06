'use client'

import {
    desktopCoworkerShareExportInputSchema,
    desktopCoworkerShareImportInputSchema,
    desktopCoworkerShareRevokeInputSchema,
    type DesktopCoworkerShareExportInput,
    type DesktopCoworkerShareImportInput,
    type DesktopCoworkerShareRevokeInput,
} from '@rerun/contracts'

export type DesktopCoworkerShareStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>
export type DesktopCoworkerShareScope = { workspaceId: number; agentId: string }
export type DesktopCoworkerShareImportScope = { targetWorkspaceId: number; snapshotId: string }
export type DesktopCoworkerShareRevokeScope = DesktopCoworkerShareScope & { snapshotId: string }

const PREFIX = 'rerun-desktop-coworker-share-attempt:v1:'
const part = (value: string | number) => encodeURIComponent(String(value))
const exportPrefix = (scope: DesktopCoworkerShareScope) => `${PREFIX}export:${part(scope.workspaceId)}:${part(scope.agentId)}:`
const importPrefix = (scope: DesktopCoworkerShareImportScope) => `${PREFIX}import:${part(scope.targetWorkspaceId)}:${part(scope.snapshotId)}:`
const revokePrefix = (scope: DesktopCoworkerShareRevokeScope) => `${PREFIX}revoke:${part(scope.workspaceId)}:${part(scope.agentId)}:${part(scope.snapshotId)}:`

function memoryStorage(): DesktopCoworkerShareStorage {
    const values = new Map<string, string>()
    return {
        get length() { return values.size },
        key: index => [...values.keys()][index] ?? null,
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => { values.set(key, value) },
        removeItem: key => { values.delete(key) },
    }
}

function defaultStorage(): DesktopCoworkerShareStorage {
    try { if (globalThis.localStorage) return globalThis.localStorage } catch { /* Use page-lifetime recovery below. */ }
    return memoryStorage()
}

export function createDesktopCoworkerShareAttempts(storage?: DesktopCoworkerShareStorage) {
    const store = storage ?? defaultStorage()
    function keys(prefix: string): string[] {
        const result: string[] = []
        try {
            for (let index = 0; index < store.length; index++) {
                const key = store.key(index)
                if (key?.startsWith(prefix)) result.push(key)
            }
        } catch { return [] }
        return result.sort()
    }
    function read<T>(prefix: string, parse: (value: unknown) => T): T[] {
        return keys(prefix).flatMap(key => {
            try {
                const raw = store.getItem(key)
                return raw ? [parse(JSON.parse(raw))] : []
            } catch { return [] }
        })
    }
    function write(key: string, value: unknown) {
        store.setItem(key, JSON.stringify(value))
    }
    return {
        listExport: (scope: DesktopCoworkerShareScope) => read(exportPrefix(scope), value => desktopCoworkerShareExportInputSchema.parse(value)),
        rememberExport(input: DesktopCoworkerShareExportInput) {
            const parsed = desktopCoworkerShareExportInputSchema.parse(input)
            write(`${exportPrefix(parsed)}${part(parsed.requestId)}`, parsed)
        },
        forgetExport(input: DesktopCoworkerShareExportInput) {
            try { store.removeItem(`${exportPrefix(input)}${part(input.requestId)}`) } catch { /* The server receipt remains authoritative. */ }
        },
        listImport: (scope: DesktopCoworkerShareImportScope) => read(importPrefix(scope), value => desktopCoworkerShareImportInputSchema.parse(value)),
        listWorkspaceImports: (targetWorkspaceId: number) => read(`${PREFIX}import:${part(targetWorkspaceId)}:`, value => desktopCoworkerShareImportInputSchema.parse(value)),
        rememberImport(input: DesktopCoworkerShareImportInput) {
            const parsed = desktopCoworkerShareImportInputSchema.parse(input)
            write(`${importPrefix(parsed)}${part(parsed.requestId)}`, parsed)
        },
        forgetImport(input: DesktopCoworkerShareImportInput) {
            try { store.removeItem(`${importPrefix(input)}${part(input.requestId)}`) } catch { /* The import dedupe remains authoritative. */ }
        },
        listRevoke: (scope: DesktopCoworkerShareRevokeScope) => read(revokePrefix(scope), value => desktopCoworkerShareRevokeInputSchema.parse(value)),
        listRevocations: (scope: DesktopCoworkerShareScope) => read(`${PREFIX}revoke:${part(scope.workspaceId)}:${part(scope.agentId)}:`, value => desktopCoworkerShareRevokeInputSchema.parse(value)),
        rememberRevoke(scope: DesktopCoworkerShareRevokeScope, input: DesktopCoworkerShareRevokeInput) {
            const parsed = desktopCoworkerShareRevokeInputSchema.parse(input)
            if (scope.snapshotId !== parsed.snapshotId) throw new Error('Withdrawal scope changed. Review the local share again.')
            write(`${revokePrefix(scope)}${part(parsed.requestId)}`, parsed)
        },
        forgetRevoke(scope: DesktopCoworkerShareRevokeScope, input: DesktopCoworkerShareRevokeInput) {
            try { store.removeItem(`${revokePrefix(scope)}${part(input.requestId)}`) } catch { /* The withdrawal receipt remains authoritative. */ }
        },
    }
}

type LocalAttempts = ReturnType<typeof createDesktopCoworkerShareAttempts>
export type DesktopCoworkerShareAttempts = { [K in keyof LocalAttempts]: (...args: Parameters<LocalAttempts[K]>) => ReturnType<LocalAttempts[K]> | Promise<ReturnType<LocalAttempts[K]>> }

/** Production recovery lives in app.db and survives changing loopback origins. */
export function createDesktopCoworkerShareServerAttempts(workspaceId: number, routeAgentId: string): DesktopCoworkerShareAttempts {
    const url = `/api/desktop/coworkers/${encodeURIComponent(routeAgentId)}/share`
    const call = async (kind: 'export' | 'import' | 'revoke',mode: 'remember' | 'forget' | 'list',extra: Record<string,unknown> = {}) => {
        const query = new URLSearchParams({ attempts: kind,...(typeof extra.snapshotId === 'string' ? { forSnapshot: extra.snapshotId } : {}),...(extra.workspaceWide ? { workspaceWide: '1' } : {}) })
        const response = await fetch(mode === 'list' ? `${url}?${query}` : url,{ ...(mode === 'list' ? { method: 'GET' } : { method: 'POST',headers: { 'Content-Type': 'application/json' },body: JSON.stringify({ action: 'attempts',kind,mode,...extra }) }),cache: 'no-store',signal: AbortSignal.timeout(15_000) })
        if (!response.ok) throw new Error('Durable share recovery did not acknowledge. Retry the same attempt.')
        return response.json() as Promise<{ attempts?: unknown[] }>
    }
    const own = (scope: DesktopCoworkerShareScope) => { if (scope.workspaceId !== workspaceId || scope.agentId !== routeAgentId) throw new Error('Share recovery scope changed.') }
    const list = async <T>(kind: 'export' | 'import' | 'revoke',parse: (raw: unknown) => T,extra?: Record<string,unknown>) => ((await call(kind,'list',extra)).attempts ?? []).map(parse)
    return {
        listExport: async scope => { own(scope); return list('export',raw => desktopCoworkerShareExportInputSchema.parse(raw)) },
        rememberExport: async input => { own(input); await call('export','remember',{ input }) },
        forgetExport: async input => { own(input); await call('export','forget',{ input }) },
        listImport: async scope => { if (scope.targetWorkspaceId !== workspaceId) throw new Error('Share recovery scope changed.'); return list('import',raw => desktopCoworkerShareImportInputSchema.parse(raw),{ snapshotId: scope.snapshotId,workspaceWide: true }) },
        listWorkspaceImports: async target => { if (target !== workspaceId) throw new Error('Share recovery scope changed.'); return list('import',raw => desktopCoworkerShareImportInputSchema.parse(raw),{ workspaceWide: true }) },
        rememberImport: async input => { if (input.targetWorkspaceId !== workspaceId) throw new Error('Share recovery scope changed.'); await call('import','remember',{ input }) },
        forgetImport: async input => { if (input.targetWorkspaceId !== workspaceId) throw new Error('Share recovery scope changed.'); await call('import','forget',{ input }) },
        listRevoke: async scope => { own(scope); return list('revoke',raw => desktopCoworkerShareRevokeInputSchema.parse(raw),{ snapshotId: scope.snapshotId }) },
        listRevocations: async scope => { own(scope); return list('revoke',raw => desktopCoworkerShareRevokeInputSchema.parse(raw)) },
        rememberRevoke: async (scope,input) => { own(scope); if (scope.snapshotId !== input.snapshotId) throw new Error('Share recovery scope changed.'); await call('revoke','remember',{ input }) },
        forgetRevoke: async (scope,input) => { own(scope); await call('revoke','forget',{ input }) },
    }
}
