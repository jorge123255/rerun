import { createHash } from 'node:crypto'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { extractDesktopPdfText } from '@/lib/desktop/server/pdf-text'
import { readSharedBytes } from '@/lib/desktop/server/shared-file-previews/read-shared-bytes'
import { DESKTOP_PDF_TEXT_MAX_RESPONSE } from '@/lib/desktop/pdf-text'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const query = new URL(request.url).searchParams
        const expectedHash = query.get('sha256')
        if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new DesktopHttpError(400, 'Open the PDF page before reading its text.')
        const pdf = await readSharedBytes(runtime, query.get('path') ?? '', 'pdf', { signal: request.signal })
        if (createHash('sha256').update(pdf.bytes).digest('hex') !== expectedHash) throw new DesktopHttpError(409, 'This shared PDF changed after the displayed page was read. Reopen it to search the current document.')
        const extract = await extractDesktopPdfText(pdf.bytes, { signal: request.signal })
        const encoded = Buffer.from(JSON.stringify({ identity: pdf.identity, path: pdf.path, pageCount: extract.pageCount, truncated: extract.truncated, reason: extract.reason, pages: extract.pages }))
        if (encoded.byteLength > DESKTOP_PDF_TEXT_MAX_RESPONSE || encoded.includes(0)) throw new DesktopHttpError(413, 'PDF text is too large to search.')
        return new Response(new Uint8Array(encoded), { headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(encoded.byteLength),
            'x-pdf-sha256': expectedHash,
            'x-rerun-shared-sha256': pdf.identity,
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
            'cross-origin-resource-policy': 'same-origin',
            'cache-control': 'no-store',
        } })
    })
}
