import { FOREMAN_AGENT_ID } from '@rerun/contracts'
import { desktopDocumentAttachmentsApi } from '@/lib/desktop/server/document-attachments/api'
import { desktopDocumentAttachmentService } from '@/lib/desktop/server/document-attachments/binding'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

function handle(request: Request) {
    return desktopRoute(request, async runtime =>
        desktopDocumentAttachmentsApi(await desktopDocumentAttachmentService(runtime, 'foreman'))(request, FOREMAN_AGENT_ID))
}

export { handle as GET, handle as POST }
