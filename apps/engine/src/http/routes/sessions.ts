import { Hono } from 'hono'
import { agentExists } from '../../agents/loader.js'
import { getSession, listDesktopThreadMetadata, listSessions, sessionBelongsToAgent } from '../../db/repos/sessions.js'
import { listDesktopDecisionMessages, listDesktopForemanMessages, listMessages, readSavedWorkspaceAttachment } from '../../db/repos/messages.js'
import { desktopAttachmentPathSchema, desktopMcpSignInGuardSchema, desktopMcpSignInSourceResponseSchema, desktopThreadMetadataListSchema, FOREMAN_AGENT_ID } from '@rerun/contracts'
import { readDesktopMcpSignInSource } from '../../desktop/mcp-sign-in/source.js'
import { desktopSecretRequestGuardSchema, desktopSecretSourceResponseSchema } from '@rerun/contracts'
import { z } from 'zod'
import { desktopApp } from '../../desktop/policy.js'
import { readDesktopSecretSource } from '../../desktop/secret-requests/source.js'

export const sessionRoutes = new Hono()

sessionRoutes.post('/:sid/secret-request-source', async c => {
    if (!desktopApp()) return c.json({ error: 'Not found' }, 404)
    const agentId = c.req.param('id')!, sessionId = c.req.param('sid')
    if (!(await sessionBelongsToAgent(sessionId, agentId))) return c.json({ error: 'session not found' }, 404)
    const { source } = z.object({ source: desktopSecretRequestGuardSchema.optional() }).strict().parse(await c.req.json())
    return c.json(desktopSecretSourceResponseSchema.parse({ agentId, sessionId, request: await readDesktopSecretSource(agentId, sessionId, source) }))
})

sessionRoutes.post('/:sid/mcp-sign-in-source', async c => {
    if (!desktopApp()) return c.json({ error: 'Not found' }, 404)
    const agentId = c.req.param('id')!, sessionId = c.req.param('sid')
    if (!(await sessionBelongsToAgent(sessionId, agentId))) return c.json({ error: 'session not found' }, 404)
    const raw = await c.req.text()
    if (Buffer.byteLength(raw) > 65_536) return c.json({ error: 'Source request exceeds limit' }, 413)
    const { source } = z.object({ source: desktopMcpSignInGuardSchema.optional() }).strict().parse(JSON.parse(raw))
    return c.json(desktopMcpSignInSourceResponseSchema.parse({ agentId, sessionId, request: await readDesktopMcpSignInSource(agentId, sessionId, source) }))
})

sessionRoutes.get('/', async c => {
    const agentId = c.req.param('id')!
    if (c.req.query('view') === 'threads') {
        if (!desktopApp() || !agentExists(agentId)) return c.json({ error: 'Not found' }, 404)
        return c.json(desktopThreadMetadataListSchema.parse({ threads: await listDesktopThreadMetadata(agentId) }))
    }
    return c.json({ sessions: await listSessions(agentId, desktopApp()) })
})

sessionRoutes.get('/:sid', async c => {
    const agentId = c.req.param('id')!
    const session = await getSession(agentId, c.req.param('sid'))
    if (!session || session.agentId !== agentId) return c.json({ error: 'session not found' }, 404)
    return c.json(session)
})

sessionRoutes.get('/:sid/messages', async c => {
    const agentId = c.req.param('id')!
    const sid = c.req.param('sid')
    if (!(await sessionBelongsToAgent(sid, agentId))) return c.json({ error: 'session not found' }, 404)
    if (desktopApp() && agentId === FOREMAN_AGENT_ID) return c.json({ messages: await listDesktopForemanMessages(sid) })
    if (desktopApp() && c.req.query('view') === 'desktop-decisions') {
        return c.json({ messages: await listDesktopDecisionMessages(agentId, sid) }, 200, { 'cache-control': 'no-store' })
    }
    return c.json({ messages: await listMessages(agentId, sid) })
})

sessionRoutes.get('/:sid/messages/:mid/attachment', async c => {
    if (!desktopApp()) return c.json({ error: 'Not found' }, 404)
    const paths = c.req.queries('path')
    const path = desktopAttachmentPathSchema.safeParse(paths?.length === 1 ? paths[0] : undefined)
    if (!path.success) return c.json({ error: 'Choose a text attachment' }, 400)
    const attachment = await readSavedWorkspaceAttachment(c.req.param('id')!, c.req.param('sid'), c.req.param('mid'), path.data)
    if (!attachment) return c.json({ error: 'Saved attachment not found' }, 404)
    return c.json(attachment, 200, { 'cache-control': 'no-store' })
})
