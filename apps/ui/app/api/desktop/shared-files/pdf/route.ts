import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { desktopPdfRenderOptions, renderDesktopPdf } from '@/lib/desktop/server/pdf-render'
import { readSharedBytes } from '@/lib/desktop/server/shared-file-previews/read-shared-bytes'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const query = new URL(request.url).searchParams
        const { page, scale } = desktopPdfRenderOptions(Number(query.get('page') ?? 1), Number(query.get('scale') ?? 1))
        const pdf = await readSharedBytes(runtime, query.get('path') ?? '', 'pdf', { signal: request.signal })
        const identity = query.get('identity')
        if (identity !== null && identity !== pdf.identity) throw new DesktopHttpError(409, 'This shared PDF changed. Open it again before previewing.')
        const raster = await renderDesktopPdf(pdf.bytes, { page, scale, signal: request.signal })
        return new Response(new Uint8Array(raster.png), { headers: {
            'content-type': 'image/png',
            'content-length': String(raster.png.byteLength),
            'x-pdf-page': String(raster.page),
            'x-pdf-pages': String(raster.pageCount),
            'x-pdf-width': String(raster.width),
            'x-pdf-height': String(raster.height),
            'x-pdf-page-width': String(raster.pageWidth),
            'x-pdf-page-height': String(raster.pageHeight),
            'x-pdf-sha256': pdf.identity,
            'x-rerun-shared-sha256': pdf.identity,
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
            'cross-origin-resource-policy': 'same-origin',
            'cache-control': 'no-store',
        } })
    })
}
