import { Hono } from 'hono'
import { ZodError } from 'zod'
import { brainProposalStatusSchema } from '@rerun/contracts'
import { HttpError } from '../lib/errors.js'
import { desktopApp } from './policy.js'
import { desktopBrainDecisionSchema } from './brain-proposals.js'
import { desktopBrainRequestBody, getDesktopBrainStore, type DesktopBrainPagesStore } from './brain-pages-router.js'

/** Shares the pages repository, transaction, lock and durable decision receipts. */
export function createDesktopBrainProposalsRouter(getStore: () => Promise<DesktopBrainPagesStore> = getDesktopBrainStore): Hono {
    const app = new Hono()
    app.use('*', async (c, next) => {
        if (!desktopApp()) return c.json({ error: 'Not found' }, 404)
        c.header('Cache-Control', 'no-store')
        await next()
    })
    app.onError((error, c) => {
        const status = error instanceof HttpError ? error.status : error instanceof ZodError ? 400 : 503
        return c.json({ error: status === 409 ? 'This proposal or page changed. Review the current version.' : status === 404 ? 'Proposal not found.' : status === 400 ? 'Invalid Brain decision.' : 'Brain storage is unavailable.' }, status as 400)
    })
    app.get('/', async c => c.json({ proposals: await (await getStore()).listProposals(brainProposalStatusSchema.parse(c.req.query('status') ?? 'proposed')) }))
    app.get('/count', async c => c.json({ count: await (await getStore()).countProposals() }))
    for (const decision of ['accept', 'dismiss'] as const) {
        app.post(`/:id/${decision}`, async c => {
            const input = desktopBrainDecisionSchema.parse(await desktopBrainRequestBody(c.req.raw))
            if (decision === 'dismiss' && input.edits) throw new HttpError(400, 'Dismiss does not edit a page.')
            c.req.raw.signal.throwIfAborted()
            return c.json(await (await getStore()).decideProposal(c.req.param('id'), decision, input))
        })
    }
    return app
}
