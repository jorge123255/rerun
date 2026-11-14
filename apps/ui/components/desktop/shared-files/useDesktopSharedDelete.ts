'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { holdDraftAdmission, isDesktopQuitting, subscribeDraftShutdown } from '@/lib/desktop/draft-writes'
import { deleteDesktopSharedEntry } from '@/lib/desktop/shared-workspace-files'

export function useDesktopSharedDelete(workspaceId: number | null | undefined, scope: string) {
    const owner = useMemo(() => ({ workspaceId, scope }), [workspaceId, scope])
    const [pendingScope, setPendingScope] = useState<typeof owner | null>(null)
    const pending = useRef<AbortController | null>(null)
    useEffect(() => {
        const stop = subscribeDraftShutdown(() => pending.current?.abort())
        return () => { pending.current?.abort(); pending.current = null; stop() }
    }, [owner])

    return { deleting: pendingScope === owner, remove: async (path: string, revision: string | undefined) => {
        if (!workspaceId || !revision || pending.current || isDesktopQuitting()) return false
        const controller = new AbortController()
        pending.current = controller
        const release = holdDraftAdmission()
        setPendingScope(owner)
        try {
            await deleteDesktopSharedEntry(workspaceId, path, revision, controller.signal)
            return !controller.signal.aborted
        } catch (error) {
            if (!controller.signal.aborted) toast.error(error instanceof Error && error.message
                ? error.message : 'The delete could not be confirmed. Refresh Shared files before trying again.')
            return false
        } finally {
            if (pending.current === controller) {
                pending.current = null
                setPendingScope(null)
            }
            release()
        }
    } }
}
