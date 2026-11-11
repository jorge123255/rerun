import 'server-only'
import { desktopWorkspaceAttachmentSchema } from '@rerun/contracts'
import { EngineRequestError, request } from '@/lib/engine/client'
import { DesktopHttpError } from './auth'
import { assertCoworkerNotDeleting } from './coworker-delete'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { engineOf } from './settings'
import { findDesktopAgent, findDesktopSession } from './store'

export function workspaceAttachmentPreviewResponse(path: string, content: string): Response {
    const name = path.split('/').pop()!.replaceAll('\\', '_')
    const filename = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    return new Response(content, { headers: {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename*=UTF-8''${filename}`,
        'content-security-policy': "default-src 'none'; sandbox",
        'x-content-type-options': 'nosniff',
    } })
}

export async function readDesktopSavedWorkspaceAttachment(runtime: DesktopRuntime, sessionId: string, messageId: string, path: string, signal: AbortSignal) {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const session = await findDesktopSession(db, sessionId)
    const agent = session && await findDesktopAgent(db, session.agentId)
    if (!session || !agent) throw new DesktopHttpError(404, 'Saved attachment not found.')
    await assertCoworkerNotDeleting(db, agent.id)
    const encode = encodeURIComponent
    const route = `/agents/${encode(agent.engineAgentId)}/sessions/${encode(session.engineSessionId)}/messages/${encode(messageId)}/attachment?${new URLSearchParams({ path })}`
    try {
        const file = await request(engineOf(runtime), route, {
            method: 'GET', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        }, data => desktopWorkspaceAttachmentSchema.parse(data))
        if (file.path !== path) throw new DesktopHttpError(409, 'The attachment does not match this message.')
        signal.throwIfAborted()
        await assertCoworkerNotDeleting(db, agent.id)
        return file
    } catch (error) {
        if (error instanceof DesktopHttpError) throw error
        if (error instanceof EngineRequestError && error.status === 404) throw new DesktopHttpError(404, 'Saved attachment not found.')
        throw new DesktopHttpError(502, 'Could not load this attachment. Try again.')
    }
}
