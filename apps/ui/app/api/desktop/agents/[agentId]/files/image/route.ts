import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { readCoworkerImage } from '@/lib/desktop/server/coworker-files'
import { readCoworkerPreviewImage } from '@/lib/desktop/server/preview-image'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

/** Authenticated bytes of one existing raster.
 * Files sends animation=1 and may receive the original animated GIF or WebP.
 * Callers that omit it, including result cards, keep the static reader. */
export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const url = new URL(request.url)
        const animation = url.searchParams.getAll('animation')
        if (animation.length > 1 || (animation.length === 1 && animation[0] !== '1')) throw new DesktopHttpError(400, 'Send the image to preview.')
        const identity = url.searchParams.get('identity')
        const path = url.searchParams.get('path') ?? ''
        const image = animation.length === 1
            ? await readCoworkerPreviewImage(runtime, agentId, path, identity === null ? undefined : identity, request.signal)
            : await readCoworkerImage(runtime, agentId, path, identity === null ? undefined : identity)
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
