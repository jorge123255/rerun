import { readCoworkerPdf } from '@/lib/desktop/server/coworker-files'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

/** Bytes of one existing PDF in this coworker's workspace.
 * The whole file is returned. There is no byte range: the Files preview keeps a blob URL so a
 * JSON error can be shown before the iframe. The original Files preview iframes a raw file URL.
 * The response CSP below applies to a navigation to this URL. It is not the iframe document policy.
 * The preview iframe sets that policy itself. Importing coworker-files binds shared folder recovery and claims. */
export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const url = new URL(request.url)
        const identity = url.searchParams.get('identity')
        const pdf = await readCoworkerPdf(runtime, agentId, url.searchParams.get('path') ?? '', identity === null ? undefined : identity)
        return new Response(new Uint8Array(pdf.bytes), { headers: {
            'content-type': pdf.contentType,
            'content-length': String(pdf.bytes.byteLength),
            'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(pdf.name)}`,
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
            'cross-origin-resource-policy': 'same-origin',
            'cache-control': 'no-store',
        } })
    })
}
