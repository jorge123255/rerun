import { createClient } from '@libsql/client'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { BRAIN_DB_MIGRATIONS } from '../../db/brainDb.js'
import { desktopRouteAllowed } from '../policy.js'
import { createDesktopBrainPagesStore } from '../brain-pages.js'
import { createDesktopBrainPagesRouter } from '../brain-pages-router.js'
import { bindDesktopCompanyBriefBrain } from './brain.js'
import { createDesktopCompanyBriefRouter } from './router.js'
import { createCompanyBriefService } from './service.js'
import type { CompanyBriefModel } from './model.js'

/** Engine-owned fixture: UI tests exercise real routes without adopting engine compiler settings. */
export async function createMountedCompanyBriefTestEngine(complete: CompanyBriefModel['complete']) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rerun-company-brain-flow-')))
    const directory = join(root, 'brain')
    await mkdir(directory, { mode: 0o700 })
    const brainDb = createClient({ url: `file:${join(root, 'brain.db')}` })
    const db = createClient({ url: 'file::memory:' })
    try {
        for (const step of BRAIN_DB_MIGRATIONS) await step.up(brainDb)
        const brain = createDesktopBrainPagesStore(directory, async () => brainDb)
        await brain.initialize()
        const service = createCompanyBriefService(async () => db, {
            model: { confirm: async () => true, complete },
            brain: bindDesktopCompanyBriefBrain(brain),
        })
        await service.initialize()
        const engine = new Hono()
        engine.use('*', async (context, next) => {
            if (!desktopRouteAllowed(context.req.method, context.req.path)) return context.json({ error: 'Desktop route refused.' }, 403)
            await next()
        })
        engine.route('/desktop/company-brief', createDesktopCompanyBriefRouter(() => service))
        engine.route('/desktop/brain/pages', createDesktopBrainPagesRouter(async () => brain))
        return { fetch: (request: Request) => engine.fetch(request), close: async () => { db.close(); brainDb.close(); await rm(root, { recursive: true, force: true }) } }
    } catch (error) { db.close(); brainDb.close(); await rm(root, { recursive: true, force: true }); throw error }
}
