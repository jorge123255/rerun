'use client'
import { holdDraftAdmission } from '@/lib/desktop/draft-writes'
import { z } from 'zod'
import { desktopWorkspaceRenameResultSchema } from '@rerun/contracts'
import { desktopWorkspaceBridge } from './client'
const snapshot = z.strictObject({ workspaceId: z.number().int().positive(), launchNonce: z.string().min(1), pending: z.strictObject({ requestId: z.string().uuid(), name: z.string().trim().min(1).max(60), iconCatalogId: z.string().nullable() }).nullable() })
let syncing: Promise<void> | undefined
/** Retries the saved metadata intent only. Atomic SQLite settings are already committed. */
export function flushDesktopWorkspaceMetadata(): Promise<void> {
    const bridge = desktopWorkspaceBridge()
    if (!bridge) return Promise.resolve()
    if (syncing) return syncing
    const release = holdDraftAdmission()
    syncing = (async () => {
        let owner: { workspaceId: number; launchNonce: string } | undefined
        for (let attempt = 0; attempt < 8; attempt++) {
            const response = await fetch('/api/desktop/workspaces/metadata', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(10000) })
            if (!response.ok) throw new Error('Workspace list will refresh when its saved settings can be read.')
            const state = snapshot.parse(await response.json())
            if (owner && (owner.workspaceId !== state.workspaceId || owner.launchNonce !== state.launchNonce)) throw new Error('The active workspace changed.')
            owner = state
            if (!state.pending) return
            const result = desktopWorkspaceRenameResultSchema.parse(await bridge.rename({ ...state.pending, workspaceId: state.workspaceId }))
            if (!result.ok || result.workspace.workspaceId !== state.workspaceId || result.workspace.name !== state.pending.name || result.workspace.iconCatalogId !== state.pending.iconCatalogId) throw new Error('Workspace settings were saved; the workspace list could not refresh yet.')
            const acknowledgement = await fetch('/api/desktop/workspaces/metadata', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: state.pending.requestId, workspaceId: state.workspaceId, launchNonce: state.launchNonce }), credentials: 'same-origin', signal: AbortSignal.timeout(10000) })
            if (!acknowledgement.ok || !z.strictObject({ ok: z.literal(true) }).safeParse(await acknowledgement.json()).success) throw new Error('Workspace list refresh will be retried.')
        }
        throw new Error('Workspace list refresh will be retried after the latest settings finish saving.')
    })().finally(() => { syncing = undefined; release() })
    return syncing
}
