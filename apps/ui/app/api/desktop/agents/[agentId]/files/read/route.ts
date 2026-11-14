import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { workspaceAttachmentPreviewResponse } from '@/lib/desktop/server/workspace-attachment-preview'
import { CoworkerFileConflict, readCoworkerFile } from '@/lib/desktop/server/coworker-files'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

export function GET(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => {
        const { agentId } = await params
        const query = new URL(request.url).searchParams
        const attachment = query.get('view') === 'attachment'
        if (attachment && (query.getAll('path').length !== 1 || query.getAll('view').length !== 1)) {
            throw new DesktopHttpError(400, 'Choose a text attachment.')
        }
        const path = query.get('path') ?? ''
        if (attachment) {
            const file = await readCoworkerFile(runtime, agentId, path, 'attach')
            return workspaceAttachmentPreviewResponse(file.path, file.content)
        }
        try {
            const preview = await readCoworkerFile(runtime, agentId, path)
            return Response.json(preview, { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
            if (error instanceof CoworkerFileConflict) {
                return Response.json({ error: error.message, conflict: true, current: error.current, ...(error.recovery && { recovery: error.recovery }) }, { status: 409, headers: { 'cache-control': 'no-store' } })
            }
            throw error
        }
    })
}
