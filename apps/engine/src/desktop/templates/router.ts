import { Hono } from 'hono'
import { z } from 'zod'
import { desktopTemplateIdSchema, desktopTemplateRevisionSchema, desktopTemplateSelectionSchema } from '@rerun/contracts'
import { agentsDir, dataDir } from '../../config/paths.js'
import { HttpError, notFound } from '../../lib/errors.js'
import { desktopApp } from '../policy.js'
import { TemplateRequestError } from './errors.js'
import { createDesktopTemplateEngine } from './service.js'

const draftBody = z.strictObject({ requestId: z.uuid(), title: z.string() })
const planBody = z.strictObject({
    requestId: z.uuid(),
    templateId: desktopTemplateIdSchema,
    revision: desktopTemplateRevisionSchema,
    coworkers: z.array(z.strictObject({
        agentId: z.uuid(),
        engineAgentId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    })).min(1).max(12),
})
const captureBody = z.strictObject({
    requestId: z.uuid(),
    templateId: desktopTemplateIdSchema,
    revision: desktopTemplateRevisionSchema,
    planRevision: desktopTemplateRevisionSchema,
    selections: z.array(desktopTemplateSelectionSchema).min(1).max(12),
})
const installBody = z.strictObject({
    importReceiptId: z.uuid(),
    templateId: desktopTemplateIdSchema,
    revision: desktopTemplateRevisionSchema,
    coworkers: z.array(z.strictObject({
        engineAgentId: z.string().regex(/^i[a-f0-9]{31}$/),
        agentKey: z.string().regex(/^c[0-9]{2}$/),
    })).min(1).max(12),
})

function engine() {
    return createDesktopTemplateEngine({ dataRoot: dataDir(), agentsRoot: agentsDir() })
}

function reject(error: unknown): never {
    if (error instanceof TemplateRequestError) throw new HttpError(error.status, error.message)
    throw error
}

async function jsonBody(request: Request): Promise<unknown> {
    const length = request.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 262_144)) throw new HttpError(413, 'Template request is too large')
    const text = await request.text()
    if (text.length > 262_144) throw new HttpError(413, 'Template request is too large')
    try { return JSON.parse(text) as unknown }
    catch { throw new HttpError(400, 'Invalid template request') }
}

export const desktopTemplateRoutes = new Hono()

desktopTemplateRoutes.use('*', async (c, next) => {
    if (!desktopApp()) throw notFound('desktop templates')
    await next()
})

desktopTemplateRoutes.post('/draft', async c => {
    const body = draftBody.safeParse(await jsonBody(c.req.raw))
    if (!body.success) throw new HttpError(400, 'Invalid template request')
    return c.json(await engine().createDraft(body.data.requestId, body.data.title).catch(reject))
})

desktopTemplateRoutes.post('/plan', async c => {
    const body = planBody.safeParse(await jsonBody(c.req.raw))
    if (!body.success) throw new HttpError(400, 'Invalid template request')
    return c.json(await engine().plan(body.data).catch(reject))
})

desktopTemplateRoutes.post('/capture', async c => {
    const body = captureBody.safeParse(await jsonBody(c.req.raw))
    if (!body.success) throw new HttpError(400, 'Invalid template request')
    return c.json({ status: 'captured' as const, ...(await engine().capture(body.data).catch(reject)) })
})

desktopTemplateRoutes.post('/install', async c => {
    const body = installBody.safeParse(await jsonBody(c.req.raw))
    if (!body.success) throw new HttpError(400, 'Invalid template request')
    return c.json(await engine().install(body.data).catch(reject))
})

desktopTemplateRoutes.get('/', async c => c.json(await engine().list().catch(reject)))

desktopTemplateRoutes.get('/:templateId', async c => {
    const templateId = desktopTemplateIdSchema.safeParse(c.req.param('templateId'))
    if (!templateId.success) throw new HttpError(400, 'Invalid template')
    const revision = c.req.query('revision')
    if (revision !== undefined && !desktopTemplateRevisionSchema.safeParse(revision).success) throw new HttpError(400, 'Invalid template revision')
    return c.json(await engine().detail(templateId.data, revision).catch(reject))
})
