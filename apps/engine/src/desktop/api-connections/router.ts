import { Hono } from 'hono'
import { ZodError } from 'zod'
import {
    desktopApiConnectionIdSchema,
    desktopApiCreateInputSchema,
    desktopApiCredentialInputSchema,
    desktopApiModelsInputSchema,
    desktopApiRemoveInputSchema,
    desktopApiRenameInputSchema,
    desktopApiSelectInputSchema,
} from '@rerun/contracts'
import { HttpError } from '../../lib/errors.js'
import { desktopApp } from '../policy.js'
import { DesktopApiConnectionRefusal } from './service.js'
import { createDesktopApiConnectionRuntime } from './runtime.js'
import { pendingDesktopApiConnectionRuns, stopAndDrainDesktopApiConnectionRuns } from './run-authority.js'

function workspaceId(): number {
    const id = Number(process.env.RERUN_DESKTOP_WORKSPACE_ID)
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(503, 'API connections are unavailable until this Mac workspace is identified.')
    return id
}

async function service() {
    const id = workspaceId()
    return createDesktopApiConnectionRuntime({
        workspaceId: id,
        pendingRuns: pendingDesktopApiConnectionRuns,
        stopAndDrain: stopAndDrainDesktopApiConnectionRuns,
    })
}

function sameWorkspace(requested: number) {
    if (requested !== workspaceId()) throw new HttpError(409, 'This connection belongs to another workspace.')
}

export function createDesktopApiConnectionRouter(): Hono {
    const app = new Hono()
    app.use('*', async (c, next) => {
        if (!desktopApp()) return c.json({ error: 'Not found' }, 404)
        c.header('Cache-Control', 'no-store')
        await next()
    })
    app.onError((error, c) => {
        const status = error instanceof HttpError ? error.status : error instanceof ZodError ? 400 : error instanceof DesktopApiConnectionRefusal ? 409 : 503
        const message = error instanceof HttpError || error instanceof DesktopApiConnectionRefusal ? error.message : error instanceof ZodError ? 'Invalid connection request.' : 'The connection service is unavailable.'
        return c.json({ error: message }, status as 400)
    })
    app.get('/catalog', async c => {
        const requested = Number(c.req.query('workspaceId'))
        sameWorkspace(requested)
        return c.json(await (await service()).list(requested))
    })
    app.get('/removal', async c => {
        const requested = Number(c.req.query('workspaceId'))
        sameWorkspace(requested)
        const id = desktopApiConnectionIdSchema.parse(c.req.query('connectionId'))
        return c.json(await (await service()).removalPlan(requested, id))
    })
    app.post('/:kind', async c => {
        const kind = c.req.param('kind')
        const body = await c.req.json()
        const current = await service()
        if (kind === 'create') {
            const input = desktopApiCreateInputSchema.parse(body)
            sameWorkspace(input.workspaceId)
            return c.json(await current.create(input, c.req.raw.signal))
        }
        if (kind === 'rename') {
            const input = desktopApiRenameInputSchema.parse(body)
            sameWorkspace(input.workspaceId)
            return c.json(await current.rename(input, c.req.raw.signal))
        }
        if (kind === 'models') {
            const input = desktopApiModelsInputSchema.parse(body)
            sameWorkspace(input.workspaceId)
            return c.json(await current.models(input, c.req.raw.signal))
        }
        if (kind === 'credential') {
            const input = desktopApiCredentialInputSchema.parse(body)
            sameWorkspace(input.workspaceId)
            return c.json(await current.credential(input, c.req.raw.signal))
        }
        if (kind === 'select') {
            const input = desktopApiSelectInputSchema.parse(body)
            sameWorkspace(input.workspaceId)
            return c.json(await current.select(input, c.req.raw.signal))
        }
        if (kind === 'remove') {
            const input = desktopApiRemoveInputSchema.parse(body)
            sameWorkspace(input.workspaceId)
            return c.json(await current.remove(input, c.req.raw.signal))
        }
        throw new HttpError(404, 'Unknown connection operation.')
    })
    return app
}
