import { desktopUploadDismissSchema, desktopUploadReserveSchema, desktopUploadScopeSchema } from '@/lib/desktop/composer-upload-attempts'
import { awaitDesktopUpload } from '@/lib/desktop/composer-upload'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { dismissDesktopComposerUpload, readDesktopComposerUploads, reserveDesktopComposerUpload } from '@/lib/desktop/server/composer-uploads'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }
const headers = { 'cache-control': 'no-store' }
async function body(request: Request) {
    const reader = request.body?.getReader()
    if (!reader) throw new DesktopHttpError(400, 'Choose an upload attempt.')
    const chunks: Uint8Array[] = []; let size = 0
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10000)])
    try {
        for (;;) {
            signal.throwIfAborted()
            const next = await awaitDesktopUpload(reader.read(), signal)
            if (next.done) break
            size += next.value.byteLength
            if (size > 2048) throw new DesktopHttpError(413, 'Upload status is too large.')
            chunks.push(next.value)
        }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new DesktopHttpError(400, 'Choose a valid upload attempt.') }
    } finally { void reader.cancel().catch(() => {}) }
}
export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const scope = desktopUploadScopeSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
        if (!scope.success) throw new DesktopHttpError(400, 'Choose a conversation tab.')
        return Response.json(await readDesktopComposerUploads(await openDesktopDatabase(runtime.dataRoot), (await params).agentId, scope.data.tabUid, request.signal), { headers })
    })
}
export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const input = desktopUploadReserveSchema.safeParse(await body(request))
        if (!input.success) throw new DesktopHttpError(400, 'Choose a valid text upload and conversation tab.')
        const { tabUid, ...attempt } = input.data
        return Response.json(await reserveDesktopComposerUpload(await openDesktopDatabase(runtime.dataRoot), (await params).agentId, tabUid, attempt, request.signal), { headers })
    })
}
export function DELETE(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const input = desktopUploadDismissSchema.safeParse(await body(request))
        if (!input.success) throw new DesktopHttpError(400, 'Choose the exact upload status to dismiss.')
        return Response.json(await dismissDesktopComposerUpload(await openDesktopDatabase(runtime.dataRoot), (await params).agentId, input.data.tabUid, input.data.id, request.signal), { headers })
    })
}
