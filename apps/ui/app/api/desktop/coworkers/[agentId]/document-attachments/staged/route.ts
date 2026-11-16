import { desktopDocumentStagedUploadApi } from '@/lib/desktop/server/document-attachments/api'
import { desktopDocumentAttachmentService } from '@/lib/desktop/server/document-attachments/binding'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

/** One file above the document limit, streamed into the coworker's Files. Same sign-in, origin and
 * conversation checks as the route above it; this path is outside the proxy, which would otherwise
 * hold the whole body in memory and cut it at 10 MB. */
export async function POST(request: Request, context: { params: Promise<{ agentId: string }> }) {
    return desktopRoute(request, async runtime => desktopDocumentStagedUploadApi(await desktopDocumentAttachmentService(runtime))(request, (await context.params).agentId))
}
