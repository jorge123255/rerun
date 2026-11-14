import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { desktopOpencodeSettingsRequest } from '@rerun/contracts'
import { desktopOpencodeCatalogView, refreshDesktopOpencodeCatalog } from './catalog.js'
import { readDesktopOpencodeLimits, refreshDesktopOpencodeLimits } from './limits.js'
import { HttpError } from '../../lib/errors.js'
import type { createDesktopOpencodeConnectionStore } from './connection-store.js'

const noStore = { 'Cache-Control': 'no-store' }

export function desktopOpencodeConnectionRoutes(store: ReturnType<typeof createDesktopOpencodeConnectionStore>, launchNonce: string) {
    const routes = new Hono()
    routes.onError((error, c) => {
        if (error instanceof HttpError && error.status === 400) return c.json({ error: error.message }, 400, noStore)
        if (error instanceof HttpError && error.status === 409) return c.json({ error: error.message }, 409, noStore)
        return c.json({ error: 'OpenCode credential storage is unavailable.' }, 503, noStore)
    })
    routes.use('*', async (c, next) => {
        if (c.req.header('x-rerun-launch-nonce') !== launchNonce) return c.json({ error: 'The app launch changed.' }, 409, noStore)
        await next()
    })
    routes.get('/', async c => c.json({ connection: await store.view(c.req.raw.signal) }, 200, noStore))
    routes.post('/', bodyLimit({ maxSize: 96_000 }), async c => {
        const parsed = desktopOpencodeSettingsRequest.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Send a valid OpenCode connection change.' }, 400, noStore)
        const input = parsed.data
        if (input.action !== 'catalog' && input.action !== 'refresh' && input.action !== 'usage')
            return c.json({ connection: await store.change(input, c.req.raw.signal) }, 200, noStore)
        const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(20_000)])
        const connection = await store.view(signal)
        if (!connection || connection.workspaceId !== input.workspaceId) throw new HttpError(409, 'OpenCode connection changed.')
        if (input.action === 'usage') {
            const connectionId = connection.connectionId + ':' + connection.revision
            const fresh = !!input.refresh && !!await refreshDesktopOpencodeLimits({
                workspaceId: input.workspaceId, connectionId, fetch, signal, apiKey: await store.credential(connection.revision, signal),
            })
            if ((await store.view(signal))?.revision !== connection.revision) throw new HttpError(409, 'OpenCode connection changed.')
            const usage = readDesktopOpencodeLimits(input.workspaceId, connectionId)
            return c.json({ windows: usage?.windows ?? [], capturedAt: usage?.capturedAt ?? null, fresh }, 200, noStore)
        }
        const scope = { workspaceId: input.workspaceId, requestId: input.requestId, selectedModelId: input.selectedModelId,
            enabledModelIds: connection.enabledModelIds }
        const catalog = input.action === 'refresh'
            ? await refreshDesktopOpencodeCatalog({ ...scope, signal, fetch })
            : desktopOpencodeCatalogView(scope)
        if ((await store.view(signal))?.revision !== connection.revision) throw new HttpError(409, 'OpenCode connection changed.')
        return c.json(catalog, 200, noStore)
    })
    return routes
}
