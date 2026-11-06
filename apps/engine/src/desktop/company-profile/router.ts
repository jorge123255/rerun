import { Hono } from 'hono'
import { ZodError } from 'zod'
import { desktopCompanyProfileEngineDecideInputSchema, desktopCompanyProfileEngineEnrichInputSchema } from '@rerun/contracts'
import { HttpError } from '../../lib/errors.js'
import { desktopApp } from '../policy.js'
import { decideCompanyIndustry } from './classifier.ts'
import { openDesktopCompanyProfileInferenceAdapter, type CompanyProfileInferenceAdapter } from './model.ts'
import { inferCompanyProfile } from './profile.ts'

export function createDesktopCompanyProfileRouter(adapter: CompanyProfileInferenceAdapter = openDesktopCompanyProfileInferenceAdapter()): Hono {
    const app = new Hono()
    app.use('*', async (c, next) => {
        if (!desktopApp()) return c.json({ error: 'Not found' }, 404)
        c.header('Cache-Control', 'no-store')
        await next()
    })
    app.onError((error, c) => {
        const status = error instanceof HttpError ? error.status : error instanceof ZodError ? 400 : 503
        const message = error instanceof HttpError ? error.message : error instanceof ZodError ? 'Invalid company profile request.' : 'Company profile inference is unavailable.'
        return c.json({ error: message }, status as 400)
    })
    app.post('/decide', async c => c.json(await decideCompanyIndustry(
        desktopCompanyProfileEngineDecideInputSchema.parse(await readBody(c.req.raw)),
        adapter,
        { signal: c.req.raw.signal },
    )))
    app.post('/enrich', async c => c.json(await inferCompanyProfile(
        desktopCompanyProfileEngineEnrichInputSchema.parse(await readBody(c.req.raw)),
        adapter,
        { signal: c.req.raw.signal },
    )))
    return app
}

async function readBody(request: Request): Promise<unknown> {
    const length = request.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 1_000_000)) throw new HttpError(413, 'Company profile request is too large.')
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Expected a JSON company profile request.')
    const text = await request.text()
    if (text.length > 1_000_000) throw new HttpError(413, 'Company profile request is too large.')
    try { return JSON.parse(text) } catch { throw new HttpError(400, 'Invalid company profile request.') }
}
