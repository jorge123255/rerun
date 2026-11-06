'use client'

import type { DesktopDocumentScope } from '../../../../../packages/contracts/src/desktop-document-attachments.ts'
import { useDesktopDocumentAttachments } from '@/lib/desktop/document-attachments/useDesktopDocumentAttachments'
import { DesktopDocumentChips } from './DesktopDocumentChips'
import { DesktopDocumentPicker } from './DesktopDocumentPicker'

export function DesktopDocumentAttachmentControls({ agentId, tabUid, sessionId, disabled = false }: DesktopDocumentScope & { disabled?: boolean }) {
    const controller = useDesktopDocumentAttachments({ agentId, tabUid, sessionId })
    return <div className="min-w-0 max-w-full">
        <DesktopDocumentChips attachments={controller.attachments} onRetry={controller.retry} onRemove={controller.remove} />
        <div className="flex items-center gap-2">
            <DesktopDocumentPicker disabled={disabled} onFiles={controller.add} />
            {controller.error && <p role="alert" className="min-w-0 text-xs text-destructive">{controller.error}</p>}
        </div>
    </div>
}
