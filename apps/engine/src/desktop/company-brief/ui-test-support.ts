import { createClient } from '@libsql/client'
import { Hono } from 'hono'
import { desktopRouteAllowed } from '../policy.js'
import { createDesktopCompanyBriefRouter } from './router.js'
import { createCompanyBriefService } from './service.js'
import type { CompanyBriefModel } from './model.js'

/** Engine-owned fixture: UI tests exercise real routes without adopting engine compiler settings. */
export async function createMountedCompanyBriefTestEngine(complete: CompanyBriefModel['complete']) {
    const db = createClient({ url: 'file::memory:' })
    try {
        const service = createCompanyBriefService(async () => db, {
            model: { confirm: async () => true, complete },
            brain: { readPage: async () => null, openProposal: async () => null, propose: async () => { throw new Error('Creating a brief must not propose a Brain page.') } },
        })
        await service.initialize()
        const engine = new Hono()
        engine.use('*', async (context, next) => {
            if (!desktopRouteAllowed(context.req.method, context.req.path)) return context.json({ error: 'Desktop route refused.' }, 403)
            await next()
        })
        engine.route('/desktop/company-brief', createDesktopCompanyBriefRouter(() => service))
        return { fetch: (request: Request) => engine.fetch(request), close: () => db.close() }
    } catch (error) { db.close(); throw error }
}
