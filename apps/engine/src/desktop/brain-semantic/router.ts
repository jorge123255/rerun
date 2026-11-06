import { Hono } from 'hono'
import { z } from 'zod'
import { desktopBrainSemanticSearchInputSchema } from '@rerun/contracts'
import { desktopBrainRequestBody } from '../brain-pages-router.js'
import { assertDesktopRunAdmission } from '../workspace-admission.js'
import { desktopBrainSemanticIndex } from './runtime.js'
export function createDesktopBrainSemanticRouter() {
    const router = new Hono()
    const owner = (value: string | undefined) => z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).parse(value)
    router.get('/:id/status', async c => c.json(await (await desktopBrainSemanticIndex(owner(c.req.param('id')), c.req.raw.signal)).status(c.req.raw.signal)))
    router.post('/:id/search', async c => {
        const input = desktopBrainSemanticSearchInputSchema.parse(await desktopBrainRequestBody(c.req.raw))
        return c.json(await (await desktopBrainSemanticIndex(owner(c.req.param('id')), c.req.raw.signal)).search(input, c.req.raw.signal))
    })
    router.post('/:id/index', async c => {
        const { embed } = z.object({ embed: z.boolean() }).strict().parse(await desktopBrainRequestBody(c.req.raw))
        if (embed) assertDesktopRunAdmission()
        return c.json(await (await desktopBrainSemanticIndex(owner(c.req.param('id')), c.req.raw.signal)).reconcile(embed, c.req.raw.signal))
    })
    return router
}
