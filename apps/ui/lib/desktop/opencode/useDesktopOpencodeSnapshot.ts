'use client'

import { useEffect, useMemo, useState } from 'react'
import type { DesktopOpencodeRefresh } from '@rerun/contracts'
import { createDesktopOpencodeDriver } from './client'
import type { DesktopOpencodeConnectionSnapshot, DesktopOpencodeDriver } from './driver'

export function useDesktopOpencodeSnapshot(workspaceId: number, connection: { id: string; provider: string } | null, suppliedDriver?: DesktopOpencodeDriver): { snapshot: DesktopOpencodeConnectionSnapshot | null; catalog: DesktopOpencodeRefresh | null; error: string | null } {
    const driver = useMemo(() => suppliedDriver ?? createDesktopOpencodeDriver(), [suppliedDriver])
    const [snapshot, setSnapshot] = useState<DesktopOpencodeConnectionSnapshot | null>(null)
    const [catalog, setCatalog] = useState<DesktopOpencodeRefresh | null>(null)
    const [error, setError] = useState<string | null>(null)
    useEffect(() => {
        if (!connection || connection.provider !== 'opencode') { setSnapshot(null); setCatalog(null); setError(null); return }
        const controller = new AbortController()
        setError(null)
        void driver.snapshot({ workspaceId, connectionId: connection.id }, controller.signal)
            .then(value => { if (!controller.signal.aborted) setSnapshot(value) })
            .catch(cause => { if (!controller.signal.aborted) { setSnapshot(null); setError(cause instanceof Error ? cause.message : 'OpenCode is unavailable.') } })
        void driver.catalog({ workspaceId, connectionId: connection.id, requestId: 'settings-catalog-read', selectedModelId: snapshot?.defaultModelId ?? 'go/deepseek-v4-pro' }, controller.signal)
            .then(value => { if (!controller.signal.aborted) setCatalog(value) })
            .catch(cause => { if (!controller.signal.aborted) { setCatalog(null); setError(cause instanceof Error ? cause.message : 'OpenCode catalog is unavailable.') } })
        return () => { controller.abort() }
    }, [workspaceId, connection?.id, connection?.provider, snapshot?.connectionRevision, driver])
    return { snapshot, catalog, error }
}
