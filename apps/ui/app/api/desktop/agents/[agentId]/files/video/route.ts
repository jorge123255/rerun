import { readCoworkerVideo } from '@/lib/desktop/server/coworker-files'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

/** Bytes of one existing MP4 in this coworker's workspace.
 * The whole file is returned. There is no byte range: Files previews and chat result cards keep
 * a blob URL so a JSON error can be shown before playback, and seeking stays inside that blob. */
export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const url = new URL(request.url)
        const identity = url.searchParams.get('identity')
        const video = await readCoworkerVideo(runtime, agentId, url.searchParams.get('path') ?? '', identity === null ? undefined : identity)
        return new Response(new Uint8Array(video.bytes), { headers: {
            'content-type': video.contentType,
            'content-length': String(video.bytes.byteLength),
            'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(video.name)}`,
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
            'cross-origin-resource-policy': 'same-origin',
            'cache-control': 'no-store',
        } })
    })
}
