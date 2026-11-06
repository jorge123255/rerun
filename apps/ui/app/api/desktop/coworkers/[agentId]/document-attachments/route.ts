import { desktopDocumentAttachmentsApi } from '@/lib/desktop/server/document-attachments/api'
import { desktopDocumentAttachmentService } from '@/lib/desktop/server/document-attachments/binding'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

async function handle(request: Request, context: { params: Promise<{ agentId: string }> }) {
    return desktopRoute(request, async () => desktopDocumentAttachmentsApi(desktopDocumentAttachmentService())(request, (await context.params).agentId))
}

export { handle as GET, handle as POST }
