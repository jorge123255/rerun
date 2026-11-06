'use client'

import * as React from 'react'
import type { DesktopCoworkerShareImportInput, DesktopCoworkerSnapshotManifest } from '@rerun/contracts'
import type { DesktopCoworkerShareAttempts } from '@/lib/desktop/coworker-share/attempts'
import type { DesktopCoworkerShareClient } from '@/lib/desktop/coworker-share/client'

export function useDesktopCoworkerImportFlow({ client, attempts, targetWorkspaceId, snapshotId, active = true }: {
    client: DesktopCoworkerShareClient
    attempts: DesktopCoworkerShareAttempts
    targetWorkspaceId: number
    snapshotId: string
    active?: boolean
}) {
    const scope = React.useMemo(() => ({ targetWorkspaceId, snapshotId }), [targetWorkspaceId, snapshotId])
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

    const refreshAttempts = React.useCallback(() => {
        setPendingImports(attempts.listImport(scope))
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
        return () => {
            activeRef.current = false
            epoch.current++
        }
    }, [])

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
        const request = ++epoch.current
        running.current = true
        setBusy(true)
        setError(null)
        try {
            attempts.rememberImport(input)
            refreshAttempts()
            const result = await client.import(input)
            if (result.status === 'uncertain') {
                if (activeRef.current && request === epoch.current) setError(result.reason)
                return false
            }
            if (!result.importedAgentId) throw new Error('Import acknowledgement did not identify the fresh copy. Retry this same attempt.')
            if (!activeRef.current || request !== epoch.current) return false
            attempts.forgetImport(input)
            setImportedAgentId(result.importedAgentId)
            refreshAttempts()
            return true
        } catch (cause) {
            if (activeRef.current && request === epoch.current) {
                setError(cause instanceof Error ? cause.message : 'Could not confirm the import. Retry this same attempt.')
                refreshAttempts()
            }
            return false
        } finally {
            running.current = false
            if (activeRef.current && request === epoch.current) setBusy(false)
        }
    }

    function cancel() {
        epoch.current++
        running.current = false
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
