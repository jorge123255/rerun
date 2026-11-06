import 'server-only'
import { z } from 'zod'
import { desktopCoworkerShareExportInputSchema, desktopCoworkerShareImportInputSchema, desktopCoworkerShareRevokeInputSchema, desktopCoworkerShareSourceSchema, type DesktopCoworkerShareSource } from '../../../../../../packages/contracts/src/desktop-coworker-share'
import { DesktopHttpError } from '../auth'
import type { DesktopCoworkerShareService } from './service'

export function createDesktopCoworkerShareApi(service: DesktopCoworkerShareService, source: (workspaceId: number, agentId: string, signal?: AbortSignal) => Promise<DesktopCoworkerShareSource>) {
    return {
        async GET(request: Request): Promise<Response> {
            const url = new URL(request.url)
            const snapshotId = z.string().regex(/^[a-f0-9]{32}$/).parse(url.searchParams.get('snapshotId'))
            if (url.searchParams.get('preview') === '1') return Response.json({ manifest: await service.preview(snapshotId) }, { headers: { 'Cache-Control': 'no-store' } })
            const archive = await service.download(snapshotId)
            return new Response(archive.bytes, { headers: { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="coworker-${snapshotId.slice(0, 8)}.tar.gz"`, 'Content-Length': String(archive.bytes.length), 'Cache-Control': 'no-store' } })
        },
        async POST(request: Request): Promise<Response> {
            const text = await request.text()
            if (Buffer.byteLength(text, 'utf8') > 100_000) throw new DesktopHttpError(413, 'Share request is too large.')
            let body: { action?: unknown }
            try { body = JSON.parse(text) } catch { throw new DesktopHttpError(400, 'Share request must be JSON.') }
            if (!body || typeof body !== 'object') throw new DesktopHttpError(400, 'Invalid share request')
            if (body.action === 'plan') {
                const input = z.object({ workspaceId: z.number().int().positive(), agentId: z.string().min(1).max(160) }).strict().parse(body)
                return Response.json({ plan: service.plan(await source(input.workspaceId, input.agentId, request.signal) }, { headers: { 'Cache-Control': 'no-store' } })
            }
            if (body.action === 'export') {
                const input = desktopCoworkerShareExportInputSchema.parse(body)
                return Response.json(await service.export(input, await source(input.workspaceId, input.agentId, request.signal)), { headers: { 'Cache-Control': 'no-store' } })
            }
            if (body.action === 'import') {
                const input = desktopCoworkerShareImportInputSchema.parse(body)
                return Response.json(await service.import(input), { headers: { 'Cache-Control': 'no-store' } })
            }
            if (body.action === 'revoke') {
                const input = desktopCoworkerShareRevokeInputSchema.parse(body)
                return Response.json(await service.revoke(input), { headers: { 'Cache-Control': 'no-store' } })
            }
            throw new DesktopHttpError(400, 'Unknown share action')
        },
    }
}
