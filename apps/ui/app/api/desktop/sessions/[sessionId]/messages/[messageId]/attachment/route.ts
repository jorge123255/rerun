import { desktopAttachmentPathSchema } from '@rerun/contracts'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopSavedWorkspaceAttachment, workspaceAttachmentPreviewResponse } from '@/lib/desktop/server/workspace-attachment-preview'

export const dynamic = 'force-dynamic'

export function GET(request: Request, { params }: { params: Promise<{ sessionId: string; messageId: string }> }) {
    return desktopRoute(request, async runtime => {
        const { sessionId, messageId } = await params
        const paths = new URL(request.url).searchParams.getAll('path')
        const path = desktopAttachmentPathSchema.safeParse(paths.length === 1 ? paths[0] : undefined)
        if (!path.success || !messageId || messageId.length > 200) throw new DesktopHttpError(400, 'Choose a saved text attachment.')
        const file = await readDesktopSavedWorkspaceAttachment(runtime, sessionId, messageId, path.data, request.signal)
        return workspaceAttachmentPreviewResponse(file.path, file.content)
    })
}
