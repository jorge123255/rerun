'use client'

import * as React from 'react'
import { createDesktopCoworkerShareServerAttempts, type DesktopCoworkerShareAttempts } from '@/lib/desktop/coworker-share/attempts'
import { createDesktopCoworkerShareClient, type DesktopCoworkerShareClient } from '@/lib/desktop/coworker-share/client'
import type { DesktopCoworkerShareSectionBindings } from '@/lib/desktop/coworker-share/sections'
import { DesktopCoworkerImportDialog } from './DesktopCoworkerImportDialog'
import { DesktopCoworkerShareDialog } from './DesktopCoworkerShareDialog'

export function DesktopCoworkerShareNavigation({ workspaceId, agentId, agentName, sourceRevision, open, onOpenChange, importSnapshot = null, onImportSnapshotChange, onImported, onOpenCoworker, attempts, sectionBindings = null }: {
    workspaceId: number
    agentId: string
    agentName: string
    sourceRevision: string
    open: boolean
    onOpenChange: (open: boolean) => void
    importSnapshot?: string | null
    onImportSnapshotChange?: (snapshotId: string | null) => void
    onImported?: (agentId: string) => void | Promise<void>
    onOpenCoworker?: (agentId: string) => void
    attempts?: DesktopCoworkerShareAttempts
    sectionBindings?: DesktopCoworkerShareSectionBindings | null
}) {
    const [client, setClient] = React.useState<DesktopCoworkerShareClient | null>(null)
    const [localImport, setLocalImport] = React.useState<string | null>(importSnapshot)
    const attemptStore = React.useMemo(() => attempts ?? createDesktopCoworkerShareServerAttempts(workspaceId,agentId), [attempts,workspaceId,agentId])
    React.useEffect(() => { setLocalImport(importSnapshot) }, [importSnapshot])
    React.useEffect(() => {
        const next = createDesktopCoworkerShareClient({ workspaceId, routeAgentId: agentId })
        setClient(next)
        return () => { next.dispose(); setClient(null) }
    }, [workspaceId, agentId])
    const closeImport = React.useCallback((next: boolean) => {
        setLocalImport(next ? localImport : null)
        if (!next) onImportSnapshotChange?.(null)
    }, [localImport, onImportSnapshotChange])
    if (!client) return null
    const snapshot = importSnapshot ?? localImport
    return <>
        <DesktopCoworkerShareDialog
            open={open}
            onOpenChange={onOpenChange}
            client={client}
            attempts={attemptStore}
            workspaceId={workspaceId}
            agentId={agentId}
            agentName={agentName}
            sourceRevision={sourceRevision}
            sectionBindings={sectionBindings}
            onPreviewImport={snapshotId => {
                onOpenChange(false)
                setLocalImport(snapshotId)
                onImportSnapshotChange?.(snapshotId)
            }}
        />
        {snapshot && <DesktopCoworkerImportDialog
            open
            onOpenChange={closeImport}
            client={client}
            attempts={attemptStore}
            targetWorkspaceId={workspaceId}
            snapshotId={snapshot}
            onImported={onImported}
            onOpenCoworker={onOpenCoworker}
        />}
    </>}
