import 'server-only'
import { z } from 'zod'
import { desktopToolInstallGuestIdentitySchema, desktopToolInstallInputSchema, desktopToolInstallRunIdentitySchema, desktopToolInstallSnapshotSchema, desktopGuestShellPackageEvidenceSchema } from '@rerun/contracts'
import { authenticateDesktopEngineRequest } from '../auth'
import { openDesktopDatabase } from '../database'
import { assertCoworkerNotDeleting } from '../coworker-delete'
import { boundedText } from '../mcp/remote'
import { readDesktopRuntime } from '../runtime'
import { assertDesktopSetupChatAllowed } from '../setup/service'

const inputSchema = z.strictObject({ launchNonce: z.string().min(1), source: z.strictObject({ engineAgentId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200) }), guest: desktopToolInstallGuestIdentitySchema, packages: desktopToolInstallInputSchema.shape.packages })
/** Host-owned approved installation receipts, never package assertions supplied by a model or guest. */
export async function handleDesktopGuestShellEvidence(request: Request) {
    try {
        const runtime = await authenticateDesktopEngineRequest(request)
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15000)])
        const input = inputSchema.parse(JSON.parse(await boundedText(new Response(request.body), signal, 8192)))
        if (input.launchNonce !== runtime.launchNonce || input.guest.launchNonce !== runtime.launchNonce || input.guest.engineAgentId !== input.source.engineAgentId) throw new Error('Guest owner changed')
        const db = await openDesktopDatabase(runtime.dataRoot)
        async function owner() {
            const rows = (await db.execute({ sql: `SELECT a.id FROM desktop_agents a JOIN desktop_sessions s ON s.agent_id=a.id WHERE a.workspace_id=1 AND a.enabled=1 AND a.engine_agent_id=? AND s.engine_session_id=?`, args: [input.source.engineAgentId, input.source.sessionId] })).rows
            if (rows.length !== 1) throw new Error('Guest conversation changed')
            const id = String(rows[0]!.id)
            await assertCoworkerNotDeleting(db, id); await assertDesktopSetupChatAllowed(runtime, id)
            signal.throwIfAborted(); return id
        }
        const agentId = await owner()
        const rows = (await db.execute({ sql: `SELECT identity,snapshot FROM desktop_tool_installs WHERE json_extract(identity,'$.agentId')=? AND json_extract(identity,'$.guest.engineAgentId')=? AND json_extract(identity,'$.guest.launchNonce')=? AND json_extract(identity,'$.guest.sessionGeneration')=? AND json_extract(identity,'$.guest.workspaceFingerprint')=? ORDER BY updated_at DESC LIMIT 4096`, args: [agentId, input.guest.engineAgentId, input.guest.launchNonce, input.guest.sessionGeneration, input.guest.workspaceFingerprint] })).rows
        const snapshots = rows.flatMap(row => {
            const identity = desktopToolInstallRunIdentitySchema.parse(JSON.parse(String(row.identity)))
            if (identity.agentId !== agentId || JSON.stringify(identity.guest) !== JSON.stringify(input.guest) || row.snapshot === 'null') return []
            const snapshot = desktopToolInstallSnapshotSchema.parse(JSON.parse(String(row.snapshot)))
            return snapshot.agentId === agentId && ['installed', 'partial'].includes(snapshot.status) ? [snapshot] : []
        })
        // A later reviewed install changes the workspace manifest/lock for every package. Preserve each
        // target's original approval, but compare the guest with the newest confirmed workspace hashes.
        const latest = snapshots.flatMap(snapshot => snapshot.packages).find(item => item.status === 'installed' && item.manifestSha256 && item.lockSha256)
        if (!latest) throw new Error('Reviewed workspace evidence is unavailable')
        const evidence = input.packages.map(target => {
            if (!snapshots.some(snapshot => snapshot.packages.some(item => item.package === target && item.status === 'installed'))) throw new Error('A reviewed package receipt is unavailable')
            return desktopGuestShellPackageEvidenceSchema.parse({ package: target, manifestSha256: latest.manifestSha256, lockSha256: latest.lockSha256 })
        })
        if (agentId !== await owner() || JSON.stringify(await readDesktopRuntime()) !== JSON.stringify(runtime)) throw new Error('Guest owner changed')
        signal.throwIfAborted()
        return Response.json({ evidence }, { headers: { 'Cache-Control': 'no-store' } })
    } catch { return Response.json({ error: 'Reviewed package evidence is unavailable for this isolated computer.' }, { status: 409 }) }
}
