import { readCoworkerPdf } from '@/lib/desktop/server/coworker-files'
import { desktopRoute } from '@/lib/desktop/server/http'
import { desktopPdfRenderOptions, renderDesktopPdf } from '@/lib/desktop/server/pdf-render'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { assertCoworkerNotDeleting } from '@/lib/desktop/server/coworker-delete'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { findDesktopAgent } from '@/lib/desktop/server/store'
import { withRosterWrite } from '@/lib/desktop/server/roster-writes'
import { createHash } from 'node:crypto'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

/** An inert PNG of one page of an existing owned PDF. The browser never receives PDF bytes.
 * Importing coworker-files binds shared folder recovery and claims before the confined read. */
export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const url = new URL(request.url)
        const { page, scale } = desktopPdfRenderOptions(Number(url.searchParams.get('page') ?? 1), Number(url.searchParams.get('scale') ?? 1))
        if (request.signal.aborted) throw new DesktopHttpError(499, 'PDF preview was closed.')
        const db = await openDesktopDatabase(runtime.dataRoot)
        const owner = await findDesktopAgent(db, agentId)
        if (!owner) throw new DesktopHttpError(404, 'Coworker not found')
        const identity = url.searchParams.get('identity')
        const pdf = await readCoworkerPdf(runtime, agentId, url.searchParams.get('path') ?? '', identity === null ? undefined : identity, request.signal)
        const raster = await renderDesktopPdf(pdf.bytes, { page, scale, signal: request.signal })
        await withRosterWrite(async () => {
            if (request.signal.aborted) throw new DesktopHttpError(499, 'PDF preview was closed.')
            await assertCoworkerNotDeleting(db, agentId)
            const current = await findDesktopAgent(db, agentId)
            if (!current || current.engineAgentId !== owner.engineAgentId) throw new DesktopHttpError(404, 'Coworker not found')
        })
        return new Response(new Uint8Array(raster.png), { headers: {
            'content-type': 'image/png',
            'content-length': String(raster.png.byteLength),
            'x-pdf-page': String(raster.page),
            'x-pdf-pages': String(raster.pageCount),
            'x-pdf-width': String(raster.width),
            'x-pdf-height': String(raster.height),
            'x-pdf-page-width': String(raster.pageWidth),
            'x-pdf-page-height': String(raster.pageHeight),
            'x-pdf-sha256': createHash('sha256').update(pdf.bytes).digest('hex'),
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
            'cross-origin-resource-policy': 'same-origin',
            'cache-control': 'no-store',
        } })
    })
}
