'use client'

import { Button } from '@/components/ui/button'
import { DownloadIcon, FileIcon } from '@/lib/icons'
import type { DesktopDocumentAttachment } from '../../../../../packages/contracts/src/desktop-document-attachments.ts'
import { DesktopFileAudioPreview } from '../DesktopFileAudioPreview'
import { DesktopFilePdfPreview } from '../DesktopFilePdfPreview'
import { DesktopFileVideoPreview } from '../DesktopFileVideoPreview'

export type DesktopDocumentViewerUrls = { previewUrl: string; downloadUrl: string }

export function DesktopDocumentAttachmentView({ attachment, urls, onBack }: {
    attachment: DesktopDocumentAttachment
    urls: DesktopDocumentViewerUrls
    onBack: () => void
}) {
    if (!isLocalDocumentUrl(urls.previewUrl) || !isLocalDocumentUrl(urls.downloadUrl)) return <p role="alert" className="p-3 text-xs text-destructive">This attachment reference is unavailable.</p>
    if (attachment.kind === 'pdf') return <DesktopFilePdfPreview name={attachment.name} path={attachment.attachmentId} identity={attachment.sha256} srcUrl={urls.previewUrl} onBack={onBack} chrome="body" />
    if (attachment.kind === 'audio') return <DesktopFileAudioPreview name={attachment.name} path={attachment.attachmentId} identity={attachment.sha256} srcUrl={urls.previewUrl} onBack={onBack} />
    if (attachment.kind === 'video') return <DesktopFileVideoPreview name={attachment.name} path={attachment.attachmentId} identity={attachment.sha256} srcUrl={urls.previewUrl} onBack={onBack} />
    return <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
        <FileIcon className="size-8" />
        <p className="text-xs">No preview available for this file type</p>
        <Button asChild variant="outline" size="sm"><a href={urls.downloadUrl} download={attachment.name}><DownloadIcon className="size-3.5" />Download</a></Button>
    </div>
}

function isLocalDocumentUrl(value: string): boolean {
    return value.startsWith('/api/desktop/') && !value.includes('://') && !value.includes('\\')
}
