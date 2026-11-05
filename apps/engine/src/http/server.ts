import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { ZodError } from 'zod'
import { auth } from './auth.js'
import { foremanGuard } from './foreman-guard.js'
import { healthRoutes } from './routes/health.js'
import { agentRoutes } from './routes/agents.js'
import { desktopAgentCreationRoutes } from './routes/desktop-agent-creation.js'
import { desktopNewAgentReadingRoutes } from '../desktop/new-agent-reading.js'
import { connectionRoutes } from './routes/connections.js'
import { planRoutes } from './routes/plan.js'
import { chatRoutes } from './routes/chat.js'
import { sessionRoutes } from './routes/sessions.js'
import { memoryRoutes } from './routes/memories.js'
import { createDataRouter } from './routes/data.js'
import { createDesktopDataRouter } from '../desktop/data-router.js'
import { prepareDesktopDataFile, verifyDesktopDataFile } from '../desktop/data-executor.js'
import { createSkillFilesRouter, skillRoutes } from './routes/skills.js'
import { skillProposalRoutes } from './routes/skill-proposals.js'
import { scheduleRoutes } from './routes/schedules.js'
import { triggerRoutes } from './routes/triggers.js'
import { runRoutes, usageRoutes } from './routes/runs.js'
import { statsRoutes } from './routes/stats.js'
import { mountCloudRoutes } from '../cloud/index.js'
import { toolRoutes } from './routes/tools.js'
import { updateRoutes } from './routes/update.js'
import { doctorRoutes } from './routes/doctor.js'
import { createFilesRouter } from './routes/files.js'
import { createDesktopBrainPagesRouter } from '../desktop/brain-pages-router.js'
import { createDesktopBrainProposalsRouter } from '../desktop/brain-proposals-router.js'
import { brainRoutes } from './routes/brain.js'
import { agentDesktopRoutes, desktopRoutes } from './routes/desktop.js'
import { HttpError, notFound } from '../lib/errors.js'
import { agentExists } from '../agents/loader.js'
import { workspaceDir, sharedDir, dataDir, agentDataDbPath, sharedDbPath } from '../config/paths.js'
import { AGENT_HIDDEN_TABLES, getAgentDb } from '../db/agentDb.js'
import { getSharedDb, SHARED_HIDDEN_TABLES } from '../db/sharedDb.js'
import { logger } from '../lib/logger.js'
import { desktopApp } from '../desktop/policy.js'
import { beginDesktopAgentWork } from '../desktop/agent-lifecycle.js'

export function createServer(): Hono {
    const app = new Hono()

    app.route('/', healthRoutes)

    const api = new Hono()
    api.use('*', auth)
    api.use('*', async (c, next) => {
        if (!desktopApp()) return next()
        const match = /^\/agents\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(c.req.path)
        if (!match || ['import', 'foreman', 'default'].includes(match[1])) return next()
        if (c.req.method === 'DELETE' && c.req.path === `/agents/${match[1]}`) return next()
        // The duplicate operation leases both identities itself. Its completed receipt can be
        // replayed even after the original has gone; requiring the source here would break it.
        if (c.req.method === 'POST' && c.req.path === `/agents/${match[1]}/duplicate`) return next()
        const release = beginDesktopAgentWork(match[1])
        try {
            if (!agentExists(match[1])) throw notFound('agent')
            await next()
        } finally { release() }
    })
    api.use('/agents/:id', foremanGuard)
    api.use('/agents/:id/*', foremanGuard)
    api.route('/update', updateRoutes)
    api.route('/doctor', doctorRoutes)
    api.route('/tools', toolRoutes)
    api.route('/connections', connectionRoutes)
    api.route('/plan', planRoutes)
    api.route('/agents', agentRoutes)
    api.route('/desktop/agents', desktopAgentCreationRoutes)
    api.route('/desktop/new-agent', desktopNewAgentReadingRoutes)
    api.route('/agents/:id/sessions', sessionRoutes)
    api.route('/agents/:id/memories', memoryRoutes)
    api.route(
        '/agents/:id/data',
        desktopApp() ? createDesktopDataRouter(async c => {
            const id = c.req.param('id')!
            if (!agentExists(id)) throw notFound('agent')
            const pin = await prepareDesktopDataFile(dataDir(), agentDataDbPath(id))
            const client = await getAgentDb(id)
            await verifyDesktopDataFile(pin)
            return client
        }) : createDataRouter(c => {
            const id = c.req.param('id')!
            if (!agentExists(id)) throw notFound('agent')
            return getAgentDb(id)
        }, AGENT_HIDDEN_TABLES)
    )
    api.route('/agents/:id/skills/:slug/files', createSkillFilesRouter())
    api.route('/agents/:id/skills', skillRoutes)
    api.route('/agents/:id/skill-proposals', skillProposalRoutes)
    api.route('/agents/:id/schedules', scheduleRoutes)
    api.route('/agents/:id/triggers', triggerRoutes)
    api.route('/agents/:id/runs', runRoutes)
    api.route('/agents/:id/usage', usageRoutes)
    api.route('/agents/:id/stats', statsRoutes)
    mountCloudRoutes(api)
    api.route(
        '/agents/:id/files',
        createFilesRouter(c => {
            const id = c.req.param('id')!
            if (!agentExists(id)) throw notFound('agent')
            return workspaceDir(id)
        })
    )
    api.route('/shared/files', createFilesRouter(() => sharedDir()))
    api.route('/shared/data', desktopApp() ? createDesktopDataRouter(async () => {
        const pin = await prepareDesktopDataFile(dataDir(), sharedDbPath())
        const client = await getSharedDb()
        await verifyDesktopDataFile(pin)
        return client
    }) : createDataRouter(() => getSharedDb(), SHARED_HIDDEN_TABLES))
    api.route('/brain', brainRoutes)
    if (desktopApp()) {
        api.route('/desktop/brain/pages', createDesktopBrainPagesRouter())
        api.route('/desktop/brain/proposals', createDesktopBrainProposalsRouter())
    }
    api.route('/desktop', desktopRoutes)
    api.route('/agents/:id/desktop', agentDesktopRoutes)
    api.route('/agents/:id', chatRoutes)
    app.route('/', api)

    app.onError((err, c) => {
        if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400)
        if (err instanceof Error && err.message.startsWith('Path escapes the root')) return c.json({ error: err.message }, 400)
        if (err instanceof ZodError) {
            const msg = err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')
            return c.json({ error: msg || 'Invalid request body' }, 400)
        }
        if (err instanceof HTTPException) return err.getResponse()
        logger.error({ err: String(err) }, 'unhandled error')
        return c.json({ error: 'Internal server error' }, 500)
    })

    return app
}
