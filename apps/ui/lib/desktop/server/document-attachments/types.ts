import type { DesktopDocumentAttachment, DesktopDocumentScope } from '../../../../../../packages/contracts/src/desktop-document-attachments.ts'

export type DesktopDocumentAttachmentRecord = {
    attachment: DesktopDocumentAttachment
    fingerprint: string
}

export interface DesktopDocumentStore {
    reserve(record: DesktopDocumentAttachmentRecord): Promise<{ record: DesktopDocumentAttachmentRecord; created: boolean }>
    read(scope: DesktopDocumentScope, attachmentId: string): Promise<DesktopDocumentAttachmentRecord | null>
    list(scope: DesktopDocumentScope): Promise<DesktopDocumentAttachmentRecord[]>
    save(record: DesktopDocumentAttachmentRecord, expectedRevision: string): Promise<void>
    discard(scope: DesktopDocumentScope, attachmentId: string): Promise<void>
    bytesUsed(scope: DesktopDocumentScope): Promise<number>
}

export interface DesktopDocumentBlobStore {
    put(scope: DesktopDocumentScope, attachment: DesktopDocumentAttachment, bytes: Uint8Array, signal: AbortSignal): Promise<void>
    read(scope: DesktopDocumentScope, attachment: DesktopDocumentAttachment, signal: AbortSignal): Promise<Uint8Array>
    delete(scope: DesktopDocumentScope, attachment: DesktopDocumentAttachment, signal: AbortSignal): Promise<void>
}

export type DesktopDocumentOwnerAuthority = (scope: DesktopDocumentScope, signal: AbortSignal) => Promise<void>
export type DesktopDocumentReferenceAuthority = (scope: DesktopDocumentScope, attachmentId: string) => Promise<boolean>
export type DesktopDocumentPdfTextPort = (bytes: Uint8Array, signal: AbortSignal) => Promise<string>
export type DesktopDocumentAudioTranscriptionPort = (input: { bytes: Uint8Array; mimeType: string; signal: AbortSignal }) => Promise<string>
export type DesktopDocumentStagedFilePort = (scope: DesktopDocumentScope, attachment: DesktopDocumentAttachment, bytes: Uint8Array, signal: AbortSignal) => Promise<string>

export type DesktopDocumentAuthorities = {
    store: DesktopDocumentStore
    blobs: DesktopDocumentBlobStore
    owner: DesktopDocumentOwnerAuthority
    references: DesktopDocumentReferenceAuthority
    extractPdfText?: DesktopDocumentPdfTextPort
    transcribeAudio?: DesktopDocumentAudioTranscriptionPort
    stagedFileSupported: (kind: DesktopDocumentAttachment['kind'], mimeType: string) => boolean
    stageFile?: DesktopDocumentStagedFilePort
}
