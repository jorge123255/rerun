import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { readCoworkerFileDownload } from '@/lib/desktop/server/coworker-files'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const query = new URL(request.url).searchParams
        const paths = query.getAll('path'), versions = query.getAll('version')
        if (paths.length !== 1 || versions.length !== 1) throw new DesktopHttpError(400, 'Choose one file version to save.')
        const file = await readCoworkerFileDownload(runtime, agentId, paths[0], versions[0], request.signal)
        const name = encodeURIComponent(file.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
        return new Response(file.bytes, { headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(file.bytes.byteLength),
            'content-disposition': `attachment; filename*=UTF-8''${name}`,
            'content-security-policy': "default-src 'none'; sandbox",
            'cross-origin-resource-policy': 'same-origin',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
        } })
    })
}
