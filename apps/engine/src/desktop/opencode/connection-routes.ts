import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { desktopOpencodeConnectionChange } from '@rerun/contracts'
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
        const parsed = desktopOpencodeConnectionChange.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Send a valid OpenCode connection change.' }, 400, noStore)
        return c.json({ connection: await store.change(parsed.data, c.req.raw.signal) }, 200, noStore)
    })
    return routes
}
