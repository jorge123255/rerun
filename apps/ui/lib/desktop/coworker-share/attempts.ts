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

export type DesktopCoworkerShareAttempts = ReturnType<typeof createDesktopCoworkerShareAttempts>
