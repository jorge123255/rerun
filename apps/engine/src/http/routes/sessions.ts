import { Hono } from 'hono'
import { agentExists } from '../../agents/loader.js'
import { getSession, listDesktopThreadMetadata, listSessions, sessionBelongsToAgent } from '../../db/repos/sessions.js'
import { listMessages } from '../../db/repos/messages.js'
import { desktopMcpSignInGuardSchema, desktopMcpSignInSourceResponseSchema, desktopThreadMetadataListSchema } from '@rerun/contracts'
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
    return c.json({ messages: await listMessages(agentId, sid) })
})
