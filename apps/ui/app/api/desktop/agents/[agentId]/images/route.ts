import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { DESKTOP_IMAGE_MAX_BYTES } from '@/lib/desktop/server/image-bytes'
import { importDesktopComposerImage } from '@/lib/desktop/server/composer-image-files'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

/** Import one local PNG/JPEG/WebP into the coworker's workspace and pin its bytes for sending. */
export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const form = await request.formData().catch(() => null)
        const file = form?.get('file')
        const folder = form?.get('path')
        if (!(file instanceof File) || form!.getAll('file').length !== 1) throw new DesktopHttpError(400, 'Choose one image to import.')
        if (file.size > DESKTOP_IMAGE_MAX_BYTES) throw new DesktopHttpError(413, 'Images can be up to 8 MB.')
        const result = await importDesktopComposerImage(runtime, agentId, typeof folder === 'string' ? folder : '', file.name, new Uint8Array(await file.arrayBuffer()))
        return Response.json(result, { status: 201, headers: { 'cache-control': 'no-store' } })
    })
}
