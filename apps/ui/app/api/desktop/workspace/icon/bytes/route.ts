import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { readDesktopWorkspaceIconBytes } from '@/lib/desktop/server/workspace-icon'

export const dynamic = 'force-dynamic'

// One committed raster by its opaque identity. Bytes are immutable and addressable only by a
// random UUID; replaced selections are deleted, so an unknown identity fails closed.
export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const identity = new URL(request.url).searchParams.get('identity') ?? ''
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity)) {
            throw new DesktopHttpError(404, 'This workspace icon no longer exists.')
        }
        const db = await openDesktopDatabase(runtime.dataRoot)
        const image = await readDesktopWorkspaceIconBytes(db, identity)
        if (!image) throw new DesktopHttpError(404, 'This workspace icon no longer exists.')
        return new Response(new Uint8Array(image.bytes), { headers: {
            'content-type': image.contentType,
            'content-length': String(image.bytes.byteLength),
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
            'cross-origin-resource-policy': 'same-origin',
            // These are private local bytes, unlike the original's public hosted logo bucket.
            // Recheck the session and current selection instead of retaining replaced rasters.
            'cache-control': 'private, no-store',
        } })
    })
}
