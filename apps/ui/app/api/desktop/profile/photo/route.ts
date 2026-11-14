import { z } from 'zod'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { DESKTOP_IMAGE_MAX_BYTES, inspectDesktopImageBytes } from '@/lib/desktop/server/image-bytes'
import { normalizeDesktopIconRaster } from '@/lib/desktop/server/icon-raster'
import { readDesktopProfilePhoto, updateDesktopProfilePhoto } from '@/lib/desktop/server/local-profile'
import { readDesktopRequestBytes } from '@/lib/desktop/server/request-json'
import { assertDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'

const photoKind = new Map<string, 'png' | 'jpeg' | 'webp'>([['image/png', 'png'], ['image/jpeg', 'jpeg'], ['image/webp', 'webp']])
const identity = z.uuid()

export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const id = identity.safeParse(new URL(request.url).searchParams.get('id'))
        if (!id.success) throw new DesktopHttpError(404, 'Local profile photo not found.')
        const bytes = await readDesktopProfilePhoto(runtime, id.data)
        return new Response(bytes, { headers: {
            'content-type': 'image/webp', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
        } })
    })
}

export function PUT(request: Request) {
    return desktopRoute(request, async runtime => {
        assertDesktopWorkspaceAdmission(runtime)
        const mime = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
        const kind = photoKind.get(mime ?? '')
        if (!kind) throw new DesktopHttpError(415, 'Choose a PNG, JPEG, or WebP photo.')
        const bytes = await readDesktopRequestBytes(request, DESKTOP_IMAGE_MAX_BYTES)
        try { inspectDesktopImageBytes(kind, bytes) }
        catch { throw new DesktopHttpError(415, 'Choose a supported static photo.') }
        const raster = await normalizeDesktopIconRaster(bytes)
        const profile = await updateDesktopProfilePhoto(runtime, raster, request.signal)
        return Response.json(profile, { headers: { 'cache-control': 'no-store' } })
    })
}

export function DELETE(request: Request) {
    return desktopRoute(request, async runtime =>
        Response.json(await updateDesktopProfilePhoto(runtime, null, request.signal), { headers: { 'cache-control': 'no-store' } }))
}
