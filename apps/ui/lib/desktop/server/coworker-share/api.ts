import 'server-only'
import { z } from 'zod'
import { desktopCoworkerShareExportInputSchema, desktopCoworkerShareImportInputSchema, desktopCoworkerShareReviewInputSchema, desktopCoworkerShareRevokeInputSchema, desktopCoworkerShareSourceSchema, type DesktopCoworkerShareSource } from '../../../../../../packages/contracts/src/desktop-coworker-share'
import { DesktopHttpError } from '../auth'
import type { DesktopCoworkerShareService } from './service'
import { readDesktopJson } from '../request-json'

export function createDesktopCoworkerShareApi(service: DesktopCoworkerShareService, source: (workspaceId: number, agentId: string, signal?: AbortSignal) => Promise<DesktopCoworkerShareSource>, attempts?: (input: unknown) => Promise<unknown>) {
    return {
        async GET(request: Request): Promise<Response> {
            const url = new URL(request.url)
            if (url.searchParams.has('attempts')) {
                if (!attempts) throw new DesktopHttpError(503,'Durable share recovery is unavailable.')
                return Response.json(await attempts({ mode: 'list',kind: url.searchParams.get('attempts'),...(url.searchParams.get('forSnapshot') ? { snapshotId: url.searchParams.get('forSnapshot') } : {}),workspaceWide: url.searchParams.get('workspaceWide') === '1' }),{ headers: { 'Cache-Control': 'no-store' } })
            }
            const snapshotId = z.string().regex(/^[a-f0-9]{32}$/).parse(url.searchParams.get('snapshotId'))
            if (url.searchParams.get('preview') === '1') return Response.json({ manifest: await service.preview(snapshotId) }, { headers: { 'Cache-Control': 'no-store' } })
            const archive = await service.download(snapshotId)
            return new Response(Uint8Array.from(archive.bytes), { headers: { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="coworker-${snapshotId.slice(0, 8)}.tar.gz"`, 'Content-Length': String(archive.bytes.length), 'Cache-Control': 'no-store' } })
        },
        async POST(request: Request): Promise<Response> {
            const body = await readDesktopJson(request,100_000) as { action?: unknown }
            if (!body || typeof body !== 'object') throw new DesktopHttpError(400, 'Invalid share request')
            const { action, ...payload } = body
            if (action === 'attempts') {
                if (!attempts) throw new DesktopHttpError(503,'Durable share recovery is unavailable.')
                return Response.json(await attempts(payload),{ headers: { 'Cache-Control': 'no-store' } })
            }
            if (body.action === 'plan') {
                const input = z.object({ workspaceId: z.number().int().positive(), agentId: z.string().min(1).max(160) }).strict().parse(payload)
                return Response.json({ plan: service.plan(await source(input.workspaceId,input.agentId,request.signal)) }, { headers: { 'Cache-Control': 'no-store' } })
            }
            if (body.action === 'review') {
                const input = desktopCoworkerShareReviewInputSchema.parse(payload)
                return Response.json(await service.review(input,() => source(input.workspaceId,input.agentId,request.signal)), { headers: { 'Cache-Control': 'no-store' } })
            }
            if (body.action === 'export') {
                const input = desktopCoworkerShareExportInputSchema.parse(payload)
                return Response.json(await service.export(input,() => source(input.workspaceId,input.agentId,request.signal)), { headers: { 'Cache-Control': 'no-store' } })
            }
            if (body.action === 'import') {
                const input = desktopCoworkerShareImportInputSchema.parse(payload)
                return Response.json(await service.import(input), { headers: { 'Cache-Control': 'no-store' } })
            }
            if (body.action === 'revoke') {
                const input = desktopCoworkerShareRevokeInputSchema.parse(payload)
                return Response.json(await service.revoke(input), { headers: { 'Cache-Control': 'no-store' } })
            }
            throw new DesktopHttpError(400, 'Unknown share action')
        },
    }
}
