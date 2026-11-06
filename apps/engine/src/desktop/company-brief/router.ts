import { Hono } from 'hono'
import { z, ZodError } from 'zod'
import {
    companyBriefCancelSchema,
    companyBriefEditSchema,
    companyBriefHandoffSchema,
    companyBriefObserveSchema,
    companyBriefRetrySchema,
    companyBriefSynthesizeSchema,
    foremanChatIdSchema,
    foremanWorkspaceIdSchema,
} from '@rerun/contracts'
import { HttpError } from '../../lib/errors.js'
import { desktopApp } from '../policy.js'
import type { CompanyBriefService } from './service.js'

const zBriefChat = z.strictObject({ workspaceId: foremanWorkspaceIdSchema, chatId: foremanChatIdSchema })

export function createDesktopCompanyBriefRouter(getService: () => CompanyBriefService | Promise<CompanyBriefService>): Hono {
    const app = new Hono()
    app.use('*', async (c, next) => {
        if (!desktopApp()) return c.json({ error: 'Not found' }, 404)
        c.header('Cache-Control', 'no-store')
        await next()
    })
    app.onError((error, c) => {
        const status = error instanceof HttpError ? error.status : error instanceof ZodError ? 400 : 503
        const message = error instanceof HttpError ? error.message : error instanceof ZodError ? 'Invalid company brief request.' : 'Company brief storage is unavailable.'
        return c.json({ error: message }, status as 400)
    })
    app.get('/', async c => {
        const workspaceId = foremanWorkspaceIdSchema.parse(c.req.query('workspaceId'))
        const chatId = foremanChatIdSchema.parse(c.req.query('chatId'))
        return c.json({ attempt: await (await getService()).read(workspaceId, chatId) })
    })
    app.post('/observe', async c => {
        const input = companyBriefObserveSchema.parse(await readBody(c.req.raw))
        await (await getService()).observe(input)
        return c.json({ ok: true })
    })
    app.post('/synthesize', async c => c.json(await (await getService()).synthesize(companyBriefSynthesizeSchema.parse(await readBody(c.req.raw)), c.req.raw.signal)))
    app.post('/cancel-chat', async c => {
        const input = zBriefChat.parse(await readBody(c.req.raw))
        await (await getService()).cancelChat(input.workspaceId, input.chatId)
        return c.json({ ok: true })
    })
    app.post('/cancel', async c => {
        const input = companyBriefCancelSchema.parse(await readBody(c.req.raw))
        return c.json({ attempt: await (await getService()).cancel(input.requestId, input.workspaceId, input.chatId) })
    })
    app.post('/edit', async c => c.json({ attempt: await (await getService()).edit(companyBriefEditSchema.parse(await readBody(c.req.raw))) }))
    app.post('/dismiss', async c => {
        const input = companyBriefCancelSchema.parse(await readBody(c.req.raw))
        return c.json({ attempt: await (await getService()).dismiss(input.requestId, input.workspaceId, input.chatId) })
    })
    app.post('/retry', async c => c.json(await (await getService()).retry(companyBriefRetrySchema.parse(await readBody(c.req.raw)), c.req.raw.signal)))
    app.post('/handoff-receipt', async c => c.json({ receipt: await (await getService()).readHandoff(companyBriefHandoffSchema.parse(await readBody(c.req.raw))) }))
    app.post('/handoff', async c => c.json(await (await getService()).handoff(companyBriefHandoffSchema.parse(await readBody(c.req.raw)))))
    return app
}

async function readBody(request: Request): Promise<unknown> {
    const length = request.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 1_000_000)) throw new HttpError(413, 'Company brief request is too large.')
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Expected a JSON company brief request.')
    const text = await request.text()
    if (text.length > 1_000_000) throw new HttpError(413, 'Company brief request is too large.')
    try { return JSON.parse(text) } catch { throw new HttpError(400, 'Invalid company brief request.') }
}
