import { readCoworkerImage } from '@/lib/desktop/server/coworker-files'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

/** Authenticated bytes of one existing raster, used by Files and this coworker's result cards. */
export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const url = new URL(request.url)
        const identity = url.searchParams.get('identity')
        const image = await readCoworkerImage(runtime, agentId, url.searchParams.get('path') ?? '', identity === null ? undefined : identity)
        return new Response(new Uint8Array(image.bytes), { headers: {
            'content-type': image.contentType,
            'content-length': String(image.bytes.byteLength),
            'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(image.name)}`,
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
            'cross-origin-resource-policy': 'same-origin',
            'cache-control': 'no-store',
        } })
    })
}
