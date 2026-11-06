'use client'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { ChevronLeftIcon, ChevronRightIcon } from '@/lib/icons'
import type { DesktopDocumentReference } from '@rerun/contracts'
import { DesktopDocumentAttachmentView, DesktopDocumentDownload } from './DesktopDocumentAttachmentView'

export function DesktopDocumentLightbox({ attachments, index, onIndexChange, onClose }: {
    attachments: readonly DesktopDocumentReference[]
    index: number
    onIndexChange: (index: number) => void
    onClose: () => void
}) {
    const attachment = attachments[index]
    if (!attachment) return null
    return <Dialog open onOpenChange={open => !open && onClose()}>
        <DialogContent aria-describedby={undefined} className="flex h-[80vh] flex-col gap-0 p-0 sm:max-w-4xl">
            <div className="flex shrink-0 items-center gap-2 border-b border-border py-2 pl-4 pr-12">
                <DialogTitle className="min-w-0 flex-1 truncate text-left font-mono text-xs font-normal text-muted-foreground">{attachment.name}</DialogTitle>
                {attachments.length > 1 && <>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{index + 1} / {attachments.length}</span>
                    <Button size="icon-sm" variant="ghost" onClick={() => onIndexChange((index - 1 + attachments.length) % attachments.length)} aria-label="Previous attachment"><ChevronLeftIcon className="size-4" /></Button>
                    <Button size="icon-sm" variant="ghost" onClick={() => onIndexChange((index + 1) % attachments.length)} aria-label="Next attachment"><ChevronRightIcon className="size-4" /></Button>
                </>}
                <DesktopDocumentDownload attachment={attachment} />
            </div>
            <div className="min-h-0 flex-1 overflow-hidden pb-[env(safe-area-inset-bottom)] sm:pb-0">
                <DesktopDocumentAttachmentView attachment={attachment} onBack={onClose} />
            </div>
        </DialogContent>
    </Dialog>
}
