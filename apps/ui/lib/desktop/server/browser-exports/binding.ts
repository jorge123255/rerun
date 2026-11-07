import 'server-only'
import { z } from 'zod'
import { authenticateDesktopEngineRequest, DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import { boundedText } from '../mcp/remote'
import { createDesktopBrowserExports } from './service'
import { ensureDesktopBrowserExportsSchema } from './schema'
import { screenExportIdentity, type ScreenExportCall } from '../../../../../engine/src/desktop/isolated-screen/transport'

const artifactSchema = z.strictObject({ kind: z.enum(['rendered-html', 'served-html', 'screenshot', 'page-metadata']), path: z.string().max(1024),
    mediaType: z.enum(['text/plain', 'image/png']), bytes: z.string().max(8 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/), width: z.number().int().optional(), height: z.number().int().optional() })
const bodySchema = z.strictObject({ operation: z.enum(['publish', 'publish-web-fetch', 'read', 'read-file']), launchNonce: z.string().min(1), call: z.unknown(), path: z.string().max(1024).optional(), artifacts: z.array(artifactSchema).max(3).optional() })
const shared = Symbol.for('rerun.desktop.browser-export-publishers.v1')
type Entry = { nonce: string; service: ReturnType<typeof createDesktopBrowserExports> }
function services() { return (globalThis as unknown as Record<symbol, Map<string, Entry>>)[shared] ??= new Map() }

export async function handleDesktopBrowserExports(request: Request): Promise<Response> {
    try {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(35_000)])
        const runtime = await authenticateDesktopEngineRequest(request)
        const body = bodySchema.parse(JSON.parse(await boundedText(new Response(request.body), signal, 11 * 1024 * 1024)))
        if (body.launchNonce !== runtime.launchNonce) throw new DesktopHttpError(409, 'Browser export launch changed.')
        const db = await openDesktopDatabase(runtime.dataRoot)
        await ensureDesktopBrowserExportsSchema(db)
        const mode = body.operation === 'publish-web-fetch' ? 'web_fetch' : 'browser'
        const serviceKey = `${runtime.dataRoot}:${mode}`
        let entry = services().get(serviceKey)
        if (!entry || entry.nonce !== runtime.launchNonce) { entry = { nonce: runtime.launchNonce, service: createDesktopBrowserExports(runtime, db, { webFetch: mode === 'web_fetch' }) }; services().set(serviceKey, entry) }
        if (body.operation === 'read-file') {
            if (!body.path || body.artifacts !== undefined) throw new DesktopHttpError(400, 'Invalid saved browser file read.')
            const id = z.string().min(1).max(200)
            const invocation = z.strictObject({ engineAgentId: id, sessionId: id, runId: id }).parse(body.call)
            return Response.json(await entry.service.readFile(invocation, body.path, signal), { headers: { 'cache-control': 'no-store' } })
        }
        if (body.path !== undefined) throw new DesktopHttpError(400, 'Invalid browser export path.')
        const call = screenExportIdentity(body.call as ScreenExportCall)
        if (body.operation === 'read') {
            if (body.artifacts !== undefined) throw new DesktopHttpError(400, 'Read does not accept new browser files.')
            return Response.json(await entry.service.read(call, signal), { headers: { 'cache-control': 'no-store' } })
        }
        if (!body.artifacts?.length) throw new DesktopHttpError(400, 'Browser exports are missing.')
        const artifacts = body.artifacts.map(item => {
            const bytes = Buffer.from(item.bytes, 'base64')
            if (bytes.toString('base64') !== item.bytes) throw new DesktopHttpError(400, 'Invalid browser file data.')
            return { ...item, bytes }
        })
        return Response.json(await entry.service.publish({ ...call, artifacts }, signal), { headers: { 'cache-control': 'no-store' } })
    } catch (error) {
        return Response.json({ status: 'refused', files: [], failure: 'unknown' }, { status: error instanceof DesktopHttpError ? error.status : 400, headers: { 'cache-control': 'no-store' } })
    }
}
