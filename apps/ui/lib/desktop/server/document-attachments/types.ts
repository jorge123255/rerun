import type { DesktopDocumentAdmission, DesktopDocumentAttachment, DesktopDocumentRenderedImage, DesktopDocumentScope, DesktopDocumentSelection } from '@rerun/contracts'

export type DesktopDocumentAttachmentRecord = { attachment: DesktopDocumentAttachment; fingerprint: string; deletion?: boolean }
export type DesktopDocumentAdmissionRecord = { scope: DesktopDocumentScope; selection: DesktopDocumentSelection; fingerprint: string; admission: DesktopDocumentAdmission }
export interface DesktopDocumentStore {
    reserve(record: DesktopDocumentAttachmentRecord): Promise<{ record: DesktopDocumentAttachmentRecord; created: boolean }>
    read(scope: DesktopDocumentScope, attachmentId: string): Promise<DesktopDocumentAttachmentRecord | null>
    list(scope: DesktopDocumentScope): Promise<DesktopDocumentAttachmentRecord[]>
    save(record: DesktopDocumentAttachmentRecord, expectedRevision: string): Promise<void>
    detach(scope: DesktopDocumentScope, attachmentId: string, expectedRevision: string): Promise<void>
    reserveDiscard(scope: DesktopDocumentScope, attachmentId: string, expectedRevision: string): Promise<void>
    discard(scope: DesktopDocumentScope, attachmentId: string): Promise<void>
    readAdmission(scope: DesktopDocumentScope, admissionId: string): Promise<DesktopDocumentAdmissionRecord | null>
    admit(record: DesktopDocumentAdmissionRecord, expected: DesktopDocumentAttachmentRecord[]): Promise<DesktopDocumentAdmissionRecord>
    consume(scope: DesktopDocumentScope, admissionId: string): Promise<void>
    cancelUpload(scope: DesktopDocumentScope, attachmentId: string): Promise<void>
}
export interface DesktopDocumentBlobStore {
    put(scope: DesktopDocumentScope, attachment: DesktopDocumentAttachment, bytes: Uint8Array, signal: AbortSignal, rendered?: Uint8Array): Promise<void>
    read(scope: DesktopDocumentScope, attachment: DesktopDocumentAttachment, signal: AbortSignal): Promise<Uint8Array>
    readRenderedImage(scope: DesktopDocumentScope, attachment: DesktopDocumentAttachment, image: DesktopDocumentRenderedImage, signal: AbortSignal): Promise<Uint8Array>
    delete(scope: DesktopDocumentScope, attachment: DesktopDocumentAttachment, signal: AbortSignal): Promise<void>
}
export type DesktopDocumentAuthorities = {
    store: DesktopDocumentStore
    blobs: DesktopDocumentBlobStore
    owner: (scope: DesktopDocumentScope, signal: AbortSignal) => Promise<void>
    readOwner?: (scope: DesktopDocumentScope, attachmentId: string, signal: AbortSignal) => Promise<void>
    readScopes?: (scope: DesktopDocumentScope, signal: AbortSignal) => Promise<DesktopDocumentScope[]>
    references: (scope: DesktopDocumentScope, attachmentId: string) => Promise<boolean>
    extractPdfText?: (bytes: Uint8Array, signal: AbortSignal) => Promise<string>
    transcriptionAvailable?: (attachment: DesktopDocumentAttachment) => Promise<boolean>
    transcribeAudio?: (input: { bytes: Uint8Array; mimeType: string; name: string; signal: AbortSignal }) => Promise<string>
}
