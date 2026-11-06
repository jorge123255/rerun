import 'server-only'

import { DesktopHttpError } from '../auth'
import type { DesktopDocumentAttachmentService } from './service'

const state = globalThis as typeof globalThis & { desktopDocumentAttachmentService?: DesktopDocumentAttachmentService }

export function bindDesktopDocumentAttachments(service: DesktopDocumentAttachmentService): void {
    if (state.desktopDocumentAttachmentService) throw new Error('Document attachment authority is already bound')
    state.desktopDocumentAttachmentService = service
}

export function desktopDocumentAttachmentService(): DesktopDocumentAttachmentService {
    if (!state.desktopDocumentAttachmentService) throw new DesktopHttpError(503, 'Document attachments are not configured on this Mac.')
    return state.desktopDocumentAttachmentService
}
