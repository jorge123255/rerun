import { Hono } from 'hono'
import { z, ZodError } from 'zod'
import { brainConfirmSectionsSchema } from '@rerun/contracts'
import { brainDbDir, brainDbPath, brainDir, dataDir } from '../config/paths.js'
import { getBrainDb } from '../db/brainDb.js'
import { HttpError } from '../lib/errors.js'
import { desktopApp } from './policy.js'
import { pinDesktopDataFile, verifyDesktopDataFile } from './data-executor.js'
import { assertDesktopBrainDirectory, createDesktopBrainPagesStore, desktopBrainWriteSchema } from './brain-pages.js'

export const DESKTOP_BRAIN_BODY_MAX_BYTES = 300_000
export type DesktopBrainPagesStore = ReturnType<typeof createDesktopBrainPagesStore>
const restoreSchema = z.object({ expectedHash: z.string().regex(/^[a-f0-9]{32}$/) }).strict()
let store: DesktopBrainPagesStore | undefined
let storeDirectory: string | undefined
async function localStore(): Promise<DesktopBrainPagesStore> {
    await assertDesktopBrainDirectory(brainDir())
    await assertDesktopBrainDirectory(brainDbDir())
    if (!store || storeDirectory !== brainDir()) {
        const directory = brainDir()
        const pin = await pinDesktopDataFile(dataDir(), brainDbPath())
        store = createDesktopBrainPagesStore(directory, async () => {
            await verifyDesktopDataFile(pin)
            const database = await getBrainDb()
            await verifyDesktopDataFile(pin)
            return database
        })
        storeDirectory = directory
    }
    return store
}

async function body(request: Request): Promise<unknown> {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new HttpError(415, 'Use application/json.')
    if (Number(request.headers.get('content-length')) > DESKTOP_BRAIN_BODY_MAX_BYTES) throw new HttpError(413, 'Brain request is too large.')
    const reader = request.body?.getReader()
    if (!reader) throw new HttpError(400, 'Missing Brain request body.')
    const chunks: Uint8Array[] = []
    let size = 0
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
    const cancel = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
        signal.throwIfAborted()
        while (true) {
            const item = await reader.read()
            signal.throwIfAborted()
            if (item.done) break
            size += item.value.byteLength
            if (size > DESKTOP_BRAIN_BODY_MAX_BYTES) throw new HttpError(413, 'Brain request is too large.')
            chunks.push(item.value)
        }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
        catch { throw new HttpError(400, 'Invalid Brain JSON.') }
    } finally { signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => {}) }
}

// Mount only behind the engine's bearer authentication and desktop route allowlist.
export function createDesktopBrainPagesRouter(getStore: () => Promise<DesktopBrainPagesStore> = localStore): Hono {
    const app = new Hono()
    app.use('*', async (c, next) => {
        if (!desktopApp()) return c.json({ error: 'Not found' }, 404)
        c.header('Cache-Control', 'no-store')
        await next()
    })
    app.onError((error, c) => {
        const status = error instanceof HttpError ? error.status : error instanceof ZodError || error instanceof SyntaxError ? 400 : 503
        return c.json({ error: status === 409 ? 'This page changed. Reload it before applying your change.' : status === 404 ? 'Brain page or revision not found.' : status === 400 ? 'Invalid Brain request.' : status === 413 ? 'Brain request is too large.' : status === 415 ? 'Use application/json.' : 'Brain storage is unavailable.' }, status as 400)
    })
    app.get('/', async c => c.json({ pages: await (await getStore()).listPages() }))
    app.get('/:slug', async c => c.json(await (await getStore()).readPage(c.req.param('slug'))))
    app.put('/:slug', async c => {
        const input = desktopBrainWriteSchema.parse(await body(c.req.raw))
        c.req.raw.signal.throwIfAborted()
        return c.json(await (await getStore()).savePage(c.req.param('slug'), input))
    })
    app.delete('/:slug', async c => c.json(await (await getStore()).deletePage(c.req.param('slug'))))
    app.get('/:slug/revisions', async c => c.json({ revisions: await (await getStore()).listRevisions(c.req.param('slug')) }))
    app.get('/:slug/revisions/:rid', async c => c.json(await (await getStore()).readRevision(c.req.param('slug'), c.req.param('rid'))))
    app.post('/:slug/revert/:rid', async c => {
        const input = restoreSchema.parse(await body(c.req.raw))
        c.req.raw.signal.throwIfAborted()
        return c.json(await (await getStore()).restorePage(c.req.param('slug'), c.req.param('rid'), input.expectedHash))
    })
    app.post('/:slug/confirm', async c => {
        const input = brainConfirmSectionsSchema.strict().parse(await body(c.req.raw))
        c.req.raw.signal.throwIfAborted()
        return c.json(await (await getStore()).confirmSections(c.req.param('slug'), input.headings))
    })
    return app
}
