'use client'

import type { useDesktopDocumentAttachments } from '@/lib/desktop/document-attachments/useDesktopDocumentAttachments'
import { DesktopDocumentChips } from './DesktopDocumentChips'
import { DesktopDocumentPicker } from './DesktopDocumentPicker'

export function DesktopDocumentAttachmentControls({ controller, disabled = false, picker = false }: { controller: ReturnType<typeof useDesktopDocumentAttachments>; disabled?: boolean; picker?: boolean }) {
    return <div className="min-w-0 max-w-full">
        <DesktopDocumentChips attachments={controller.attachments} onRetry={controller.retry} onRemove={controller.remove} disabled={disabled || !controller.loaded || controller.busy > 0} />
        <div className="flex items-center gap-2">
            {picker && <DesktopDocumentPicker disabled={disabled || !controller.loaded} onFiles={controller.add} />}
            {controller.error && <p role="alert" className="min-w-0 text-xs text-destructive">{controller.error}</p>}
        </div>
    </div>
}
