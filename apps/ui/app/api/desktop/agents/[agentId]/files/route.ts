import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { IMPORT_BYTES, importCoworkerFile, listCoworkerFiles } from '@/lib/desktop/server/coworker-files'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const query = new URL(request.url).searchParams
        const listing = await listCoworkerFiles(runtime, agentId, query.get('path') ?? '', query.get('hidden') === '1')
        return Response.json(listing, { headers: { 'cache-control': 'no-store' } })
    })
}

/** Import one local .txt/.md file into the coworker's current folder (AgentPanelFiles upload, first pass). */
export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const form = await request.formData().catch(() => null)
        const file = form?.get('file')
        const folder = form?.get('path')
        if (!(file instanceof File) || form!.getAll('file').length !== 1) throw new DesktopHttpError(400, 'Choose one file to import.')
        if (file.size > IMPORT_BYTES) throw new DesktopHttpError(413, 'Files can be up to 1 MB.')
        const result = await importCoworkerFile(runtime, agentId, typeof folder === 'string' ? folder : '', file.name, new Uint8Array(await file.arrayBuffer()))
        return Response.json(result, { status: 201, headers: { 'cache-control': 'no-store' } })
    })
}
