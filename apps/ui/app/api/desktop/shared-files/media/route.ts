import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readSharedBytes } from '@/lib/desktop/server/shared-file-previews/read-shared-bytes'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const query = new URL(request.url).searchParams
        const path = query.get('path') ?? ''
        const identity = query.get('identity')
        const download = query.get('download') === '1'
        const name = path.split('/').filter(Boolean).at(-1) ?? ''
        const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
        const kind = download ? 'download' : extension === 'pdf' ? 'pdf' : ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension) ? 'image'
            : ['wav', 'mp3', 'm4a', 'ogg', 'flac'].includes(extension) ? 'audio' : ['mp4', 'webm', 'mov', 'm4v'].includes(extension) ? 'video' : null
        if (!kind) throw new DesktopHttpError(415, 'No preview is available for this file type. Use Save As to keep the original file.')
        const file = await readSharedBytes(runtime, path, kind, { signal: request.signal })
        if (identity !== null && identity !== file.identity) throw new DesktopHttpError(409, 'This shared file changed. Open it again before saving.')
        return new Response(new Uint8Array(file.bytes), { headers: {
            'content-type': file.contentType,
            'content-length': String(file.bytes.byteLength),
            'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
            'x-rerun-shared-sha256': file.identity,
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
            'cross-origin-resource-policy': 'same-origin',
            'cache-control': 'no-store',
        } })
    })
}
