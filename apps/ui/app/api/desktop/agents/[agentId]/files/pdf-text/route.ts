import { readCoworkerPdf } from '@/lib/desktop/server/coworker-files'
import { desktopRoute } from '@/lib/desktop/server/http'
import { extractDesktopPdfText } from '@/lib/desktop/server/pdf-text'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { assertCoworkerNotDeleting } from '@/lib/desktop/server/coworker-delete'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { findDesktopAgent } from '@/lib/desktop/server/store'
import { withRosterWrite } from '@/lib/desktop/server/roster-writes'
import { DESKTOP_PDF_TEXT_MAX_RESPONSE } from '@/lib/desktop/pdf-text'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

/** Positioned text for the PDF already on screen. The browser receives JSON, never PDF bytes.
 * Importing coworker-files binds the same shared folder recovery and claims as the page route. */
export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const url = new URL(request.url)
        const keys = [...url.searchParams.keys()]
        if (keys.some(key => key !== 'path' && key !== 'identity') || url.searchParams.getAll('path').length !== 1) {
            throw new DesktopHttpError(400, 'Choose a PDF file to preview.')
        }
        if (url.searchParams.getAll('identity').length > 1) throw new DesktopHttpError(400, 'Send the PDF to preview.')
        if (request.signal.aborted) throw new DesktopHttpError(499, 'PDF text was closed.')
        const db = await openDesktopDatabase(runtime.dataRoot)
        const owner = await findDesktopAgent(db, agentId)
        if (!owner) throw new DesktopHttpError(404, 'Coworker not found')
        const identity = url.searchParams.get('identity')
        const pdf = await readCoworkerPdf(runtime, agentId, url.searchParams.get('path') ?? '', identity === null ? undefined : identity, request.signal)
        const extract = await extractDesktopPdfText(pdf.bytes, { signal: request.signal })
        await withRosterWrite(async () => {
            if (request.signal.aborted) throw new DesktopHttpError(499, 'PDF text was closed.')
            await assertCoworkerNotDeleting(db, agentId)
            const current = await findDesktopAgent(db, agentId)
            if (!current || current.engineAgentId !== owner.engineAgentId) throw new DesktopHttpError(404, 'Coworker not found')
        })
        const encoded = Buffer.from(JSON.stringify({
            identity: pdf.identity, path: pdf.path, pageCount: extract.pageCount,
            truncated: extract.truncated, reason: extract.reason, pages: extract.pages,
        }))
        if (encoded.byteLength > DESKTOP_PDF_TEXT_MAX_RESPONSE || encoded.includes(0)) {
            throw new DesktopHttpError(413, 'PDF text is too large to search.')
        }
        return new Response(new Uint8Array(encoded), { headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(encoded.byteLength),
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
            'cross-origin-resource-policy': 'same-origin',
            'cache-control': 'no-store',
        } })
    })
}
