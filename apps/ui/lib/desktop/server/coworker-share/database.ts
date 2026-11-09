import 'server-only'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { desktopCoworkerShareDatabasePackageSchema, type DesktopCoworkerShareSource } from '@rerun/contracts'
import { request } from '@/lib/engine/client'
import { PORTABLE_DATABASE_MEMBER, readPortableDatabaseMember } from '../../../../../engine/src/desktop/coworker-share-database/member'
import { canonicalJson } from '../../../../../engine/src/desktop/coworker-share-database/hash'
import { engineOf } from '../settings'
import type { DesktopRuntime } from '../runtime'

export async function readShareDatabaseMember(runtime: DesktopRuntime, agentRoot: string, agentId: string, engineAgentId: string, signal?: AbortSignal) {
    if (process.platform !== 'darwin') return null
    signal?.throwIfAborted()
    try {
        // Existence only. The engine worker opens and verifies the exact canonical private file.
        if (!(await lstat(join(agentRoot, 'data', 'agent.db'))).isFile()) return null
        const requestId = `source:${agentId}`
        const pkg = await request(engineOf(runtime), '/desktop/coworker-share-database/capture', {
            method: 'POST', cache: 'no-store', redirect: 'error',
            body: JSON.stringify({ workspaceId: runtime.workspaceId, agentId, engineAgentId, requestId }),
            signal: AbortSignal.any([AbortSignal.timeout(12_000), ...(signal ? [signal] : [])]),
        }, value => desktopCoworkerShareDatabasePackageSchema.parse(value))
        const bytes = Buffer.from(canonicalJson(pkg))
        const verified = readPortableDatabaseMember(bytes)
        if (verified.sourceWorkspaceId !== runtime.workspaceId || verified.sourceAgentId !== agentId
            || verified.captureRequestId !== requestId || verified.tables.length === 0) return null
        signal?.throwIfAborted()
        return { digest: verified.digest, member: { path: PORTABLE_DATABASE_MEMBER, bytes, kind: 'text' as const,
            ownership: 'user' as const, flagged: [], binary: false, textScanned: true } }
    } catch {
        signal?.throwIfAborted()
        // The other Share sections stay available for an unsupported or absent database.
        return null
    }
}

export function databasePreviewFromSource(source: DesktopCoworkerShareSource) {
    const member = source.members.find(member => member.path === PORTABLE_DATABASE_MEMBER)
    if (!member) return null
    const database = readPortableDatabaseMember(member.bytes)
    return { available: true, contents: database.contents, viewCount: database.views.length, digest: database.digest }
}
