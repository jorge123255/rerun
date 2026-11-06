'use client'

import * as React from 'react'
import type { DesktopCoworkerShareImportInput, DesktopCoworkerSnapshotManifest } from '@rerun/contracts'
import type { DesktopCoworkerShareAttempts } from '@/lib/desktop/coworker-share/attempts'
import type { DesktopCoworkerShareClient } from '@/lib/desktop/coworker-share/client'

export function useDesktopCoworkerImportFlow({ client, attempts, targetWorkspaceId, snapshotId, onImported, active = true }: {
    client: DesktopCoworkerShareClient
    attempts: DesktopCoworkerShareAttempts
    targetWorkspaceId: number
    snapshotId: string
    onImported?: (agentId: string) => void | Promise<void>
    active?: boolean
}) {
    const scope = React.useMemo(() => ({ targetWorkspaceId, snapshotId }), [targetWorkspaceId, snapshotId])
    const currentScope = React.useRef(scope)
    currentScope.current = scope
    const importedCallback = React.useRef(onImported)
    importedCallback.current = onImported
    const notified = React.useRef(new Set<string>())
    const activeRef = React.useRef(active)
    activeRef.current = active
    const epoch = React.useRef(0)
    const running = React.useRef(false)
    const [manifest, setManifest] = React.useState<DesktopCoworkerSnapshotManifest | null>(null)
    const [loading, setLoading] = React.useState(true)
    const [approved, setApproved] = React.useState(false)
    const [pendingImports, setPendingImports] = React.useState<DesktopCoworkerShareImportInput[]>([])
    const [importedAgentId, setImportedAgentId] = React.useState<string | null>(null)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)

    const refreshAttempts = React.useCallback(async () => {
        const generation = epoch.current
        try {
            const pending = await attempts.listImport(scope)
            if (activeRef.current && generation === epoch.current && currentScope.current === scope) setPendingImports(pending)
        } catch { if (activeRef.current) setError('Durable import recovery is unavailable. Reopen the panel before importing.') }
    }, [attempts, scope])

    React.useEffect(() => {
        if (!active) return
        const request = ++epoch.current
        setManifest(null)
        setApproved(false)
        setImportedAgentId(null)
        setLoading(true)
        setError(null)
        refreshAttempts()
        void client.preview(snapshotId).then(result => {
            if (!activeRef.current || request !== epoch.current) return
            if (result.packageKey !== snapshotId) throw new Error('This preview belongs to another portable file.')
            setManifest(result)
        }).catch((cause: unknown) => {
            if (activeRef.current && request === epoch.current) setError(cause instanceof Error ? cause.message : 'The portable file could not be previewed.')
        }).finally(() => {
            if (activeRef.current && request === epoch.current) setLoading(false)
        })
        return () => { epoch.current++ }
    }, [active, client, snapshotId, refreshAttempts])

    React.useEffect(() => {
        activeRef.current = active
        return () => {
            activeRef.current = false
            epoch.current++
        }
    }, [active])

    async function importFresh(recovery?: DesktopCoworkerShareImportInput): Promise<boolean> {
        if (running.current || importedAgentId) return importedAgentId !== null
        if (!recovery && (!manifest || !approved)) return false
        const pending = recovery ?? pendingImports.find(candidate => !manifest || candidate.expectedDigest === manifest.contentDigest)
        if (pending && manifest && pending.expectedDigest !== manifest.contentDigest) {
            setError('The portable file changed. Review its current manifest before importing; the older attempt is still saved.')
            return false
        }
        let input: DesktopCoworkerShareImportInput
        if (pending) input = pending
        else if (manifest) input = {
            requestId: crypto.randomUUID(),
            snapshotId,
            expectedDigest: manifest.contentDigest,
            targetWorkspaceId,
        }
        else return false
        if (input.targetWorkspaceId !== targetWorkspaceId || input.snapshotId !== snapshotId) {
            setError('This saved import belongs to another workspace or portable file.')
            return false
        }
        const request = ++epoch.current
        const owns = () => activeRef.current && request === epoch.current && currentScope.current.targetWorkspaceId === input.targetWorkspaceId && currentScope.current.snapshotId === input.snapshotId
        running.current = true
        setBusy(true)
        setError(null)
        try {
            await attempts.rememberImport(input)
            await refreshAttempts()
            if (!owns()) return false
            const result = await client.import(input)
            if (result.status === 'uncertain') {
                if (owns()) setError(result.reason)
                return false
            }
            if (!result.importedAgentId) throw new Error('Import acknowledgement did not identify the fresh copy. Retry this same attempt.')
            if (!owns()) return false
            const notifyKey = JSON.stringify([input.targetWorkspaceId,result.importedAgentId])
            const notify = importedCallback.current
            if (notify && !notified.current.has(notifyKey)) {
                notified.current.add(notifyKey)
                // Start the workspace-owned refresh before showing Done. Closing the dialog
                // must not cancel that read; refresh failure must never retry the installation.
                const failed = () => { if (owns()) setError('The fresh copy is saved, but its board refresh could not be confirmed.') }
                try { void Promise.resolve(notify(result.importedAgentId)).catch(failed) }
                catch { failed() }
            }
            await attempts.forgetImport(input)
            if (!owns()) return false
            setImportedAgentId(result.importedAgentId)
            refreshAttempts()
            return true
        } catch (cause) {
            if (owns()) {
                setError(cause instanceof Error ? cause.message : 'Could not confirm the import. Retry this same attempt.')
                refreshAttempts()
            }
            return false
        } finally {
            running.current = false
            if (owns()) setBusy(false)
        }
    }

    function cancel() {
        epoch.current++
        setApproved(false)
        setBusy(false)
        setError(null)
    }

    return {
        manifest,
        loading,
        approved,
        setApproved,
        pendingImports,
        importedAgentId,
        busy,
        error,
        importFresh,
        recoverImport: (input: DesktopCoworkerShareImportInput) => importFresh(input),
        cancel,
    }
}

export type DesktopCoworkerImportFlow = ReturnType<typeof useDesktopCoworkerImportFlow>
