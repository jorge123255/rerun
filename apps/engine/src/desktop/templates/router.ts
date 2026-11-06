import { Hono } from 'hono'
import { z } from 'zod'
import { DESKTOP_PORTABLE_TEMPLATE_LIMITS, desktopPortableOperationSchema, desktopTemplateIdSchema, desktopTemplateRevisionSchema, desktopTemplateSelectionSchema } from '@rerun/contracts'
import { join } from 'node:path'
import { agentsDir, dataDir } from '../../config/paths.js'
import { HttpError, notFound } from '../../lib/errors.js'
import { desktopApp } from '../policy.js'
import { TemplateRequestError } from './errors.js'
import { createDesktopTemplateEngine } from './service.js'
import { createDesktopPortableTemplateService } from './portable-service.js'
import { createDesktopPortableFileStore } from './portable-files.js'
import { readForemanTemplateImport } from './install.js'
import { trustedSkillOwners } from '../service-skills/authority.js'

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
    foremanDisabled: z.literal(true).optional(),
    importReceiptId: z.uuid(),
    templateId: desktopTemplateIdSchema,
    revision: desktopTemplateRevisionSchema,
    coworkers: z.array(z.strictObject({
        engineAgentId: z.string().regex(/^i[a-f0-9]{31}$/),
        agentKey: z.string().regex(/^c[0-9]{2}$/),
    })).min(1).max(12),
})

function engine() {
    const ownership = new Map<string, Promise<Map<string, string>>>()
    return createDesktopTemplateEngine({ dataRoot: dataDir(), agentsRoot: agentsDir() }, undefined, {
        includeBinary: true,
        requireTrustedOwnership: true,
        skillOwnership: async ({ engineAgentId, slug }) => {
            let current = ownership.get(engineAgentId)
            if (!current) { current = trustedSkillOwners(join(agentsDir(), engineAgentId, 'workspace')); ownership.set(engineAgentId, current) }
            return (await current).has(slug) || slug.startsWith('svc-') ? 'connector' : 'user'
        },
    })
}

function portable() { return createDesktopPortableTemplateService({ dataRoot: dataDir(), ...createDesktopPortableFileStore(dataDir()) }) }

function reject(error: unknown): never {
    if (error instanceof TemplateRequestError) throw new HttpError(error.status, error.message)
    throw error
}

async function jsonBody(request: Request): Promise<unknown> {
    const length = request.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 262_144)) throw new HttpError(413, 'Template request is too large')
    const reader = request.body?.getReader()
    if (!reader) throw new HttpError(400, 'Invalid template request')
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
        for (;;) {
            request.signal.throwIfAborted()
            const next = await reader.read()
            if (next.done) break
            bytes += next.value.byteLength
            if (bytes > 262_144) throw new HttpError(413, 'Template request is too large')
            chunks.push(next.value)
        }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    request.signal.throwIfAborted()
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
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

for (const operation of ['export', 'import-package', 'delete'] as const) {
    desktopTemplateRoutes.post(`/${operation}`, async c => {
        const body = desktopPortableOperationSchema.safeParse(await jsonBody(c.req.raw))
        if (!body.success || body.data.operation !== operation) throw new HttpError(400, 'Invalid portable template request')
        return c.json(await portable().handle(body.data).catch(reject))
    })
}

desktopTemplateRoutes.get('/portable-receipt/:requestId', async c => c.json(await portable().receipt(c.req.param('requestId')).catch(reject)))

desktopTemplateRoutes.post('/uploads/:uploadId', async c => {
    const request = c.req.raw
    const limit = DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxCompressedBytes
    const length = request.headers.get('content-length')
    if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new HttpError(413, 'Template package is too large')
    const reader = request.body?.getReader()
    if (!reader) throw new HttpError(400, 'Template package is missing')
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
        for (;;) {
            request.signal.throwIfAborted()
            const part = await reader.read()
            if (part.done) break
            bytes += part.value.byteLength
            if (bytes > limit) throw new HttpError(413, 'Template package is too large')
            chunks.push(part.value)
        }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    request.signal.throwIfAborted()
    if (length && Number(length) !== bytes) throw new HttpError(400, 'Template package was incomplete')
    let fileName: string
    try { fileName = decodeURIComponent(request.headers.get('x-template-filename') ?? '') }
    catch { throw new HttpError(400, 'Invalid template filename') }
    return c.json(await createDesktopPortableFileStore(dataDir()).upload(c.req.param('uploadId'), Buffer.concat(chunks), fileName).catch(reject))
})
desktopTemplateRoutes.get('/uploads/:uploadId', async c => c.json(await createDesktopPortableFileStore(dataDir()).uploadInfo(c.req.param('uploadId')).catch(reject)))
desktopTemplateRoutes.get('/artifacts/:artifactId', async c => c.json(await createDesktopPortableFileStore(dataDir()).downloadInfo(c.req.param('artifactId')).catch(reject)))
desktopTemplateRoutes.get('/artifacts/:artifactId/content', async c => {
    const download = await createDesktopPortableFileStore(dataDir()).download(c.req.param('artifactId')).catch(reject)
    return new Response(new Uint8Array(download.bytes), { headers: { 'content-type': 'application/gzip', 'content-length': String(download.bytes.length), 'cache-control': 'no-store' } })
})

desktopTemplateRoutes.get('/', async c => c.json(await engine().list().catch(reject)))

desktopTemplateRoutes.get('/:templateId', async c => {
    const templateId = desktopTemplateIdSchema.safeParse(c.req.param('templateId'))
    if (!templateId.success) throw new HttpError(400, 'Invalid template')
    const revision = c.req.query('revision')
    if (revision !== undefined && !desktopTemplateRevisionSchema.safeParse(revision).success) throw new HttpError(400, 'Invalid template revision')
    return c.json(await engine().detail(templateId.data, revision).catch(reject))
})

desktopTemplateRoutes.get('/foreman-import/:engineAgentId/:receiptId', async c => {
    const engineAgentId = z.string().regex(/^i[a-f0-9]{31}$/).parse(c.req.param('engineAgentId'))
    const receiptId = z.uuid().parse(c.req.param('receiptId'))
    return c.json(await readForemanTemplateImport(agentsDir(),engineAgentId,receiptId))
})
