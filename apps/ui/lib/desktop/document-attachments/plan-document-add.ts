import {
    DESKTOP_DOCUMENT_MAX_BYTES,
    DESKTOP_DOCUMENT_MAX_FILES,
    DESKTOP_DOCUMENT_TOTAL_MAX_BYTES,
} from '@rerun/contracts'

export type DesktopDocumentAddRejectReason =
    | 'empty'
    | 'too-large'
    | 'capacity-files'
    | 'capacity-bytes'
    | 'retain-full'
    | 'unavailable'

export type DesktopDocumentAddOutcome =
    | {
        status: 'attached'
        name: string
        byteLength: number
        attachmentId: string
        position: number
    }
    | {
        status: 'rejected'
        name: string
        byteLength: number
        reason: DesktopDocumentAddRejectReason
        message: string
    }

export type DesktopDocumentAddResult = {
    /** Ordered per-file outcomes matching input order. */
    outcomes: DesktopDocumentAddOutcome[]
    /** Ids successfully retained, in attach order. */
    attachedIds: string[]
    /** UI summary: null when every file attached; otherwise lists rejects (and “Nothing was attached.” when none succeeded). */
    error: string | null
}

export type PlanDesktopDocumentAddInput = {
    files: readonly File[]
    attachedCount: number
    attachedBytes: number
    /** Whether one more file can enter the retain buffer given files already accepted in this plan. */
    canRetainOne: (file: File, accepting: readonly File[]) => boolean
    maxFiles?: number
    maxBytesPerFile?: number
    maxTotalBytes?: number
    available?: boolean
}

function rejectMessage(file: File, reason: DesktopDocumentAddRejectReason): string {
    switch (reason) {
        case 'empty':
            return `${file.name} is empty.`
        case 'too-large':
            return `${file.name} is larger than 16 MB.`
        case 'capacity-files':
            return `Attachments can be up to ${DESKTOP_DOCUMENT_MAX_FILES} documents.`
        case 'capacity-bytes':
            return 'Attachments can be up to 48 MB across ten files.'
        case 'retain-full':
            return 'Save or remove pending attachments before adding more.'
        case 'unavailable':
            return 'Documents are not available on this chat yet.'
    }
}

/**
 * Ordered per-file eligibility for document attach. Empty/oversized siblings do not
 * block later eligible files. Capacity is evaluated against running accepted totals.
 */
export function planDesktopDocumentAdd(input: PlanDesktopDocumentAddInput): {
    accepts: File[]
    rejects: { file: File; reason: DesktopDocumentAddRejectReason; message: string }[]
} {
    const maxFiles = input.maxFiles ?? DESKTOP_DOCUMENT_MAX_FILES
    const maxBytesPerFile = input.maxBytesPerFile ?? DESKTOP_DOCUMENT_MAX_BYTES
    const maxTotalBytes = input.maxTotalBytes ?? DESKTOP_DOCUMENT_TOTAL_MAX_BYTES
    const accepts: File[] = []
    const rejects: { file: File; reason: DesktopDocumentAddRejectReason; message: string }[] = []
    if (input.available === false) {
        for (const file of input.files) {
            rejects.push({ file, reason: 'unavailable', message: rejectMessage(file, 'unavailable') })
        }
        return { accepts, rejects }
    }
    let count = input.attachedCount
    let bytes = input.attachedBytes
    for (const file of input.files) {
        if (!file.size) {
            rejects.push({ file, reason: 'empty', message: rejectMessage(file, 'empty') })
            continue
        }
        if (file.size > maxBytesPerFile) {
            rejects.push({ file, reason: 'too-large', message: rejectMessage(file, 'too-large') })
            continue
        }
        if (count + 1 > maxFiles) {
            rejects.push({ file, reason: 'capacity-files', message: rejectMessage(file, 'capacity-files') })
            continue
        }
        if (bytes + file.size > maxTotalBytes) {
            rejects.push({ file, reason: 'capacity-bytes', message: rejectMessage(file, 'capacity-bytes') })
            continue
        }
        if (!input.canRetainOne(file, accepts)) {
            rejects.push({ file, reason: 'retain-full', message: rejectMessage(file, 'retain-full') })
            continue
        }
        accepts.push(file)
        count += 1
        bytes += file.size
    }
    return { accepts, rejects }
}

export function summarizeDesktopDocumentAddError(outcomes: readonly DesktopDocumentAddOutcome[]): string | null {
    const rejected = outcomes.filter((row): row is Extract<DesktopDocumentAddOutcome, { status: 'rejected' }> => row.status === 'rejected')
    if (!rejected.length) return null
    const attached = outcomes.some(row => row.status === 'attached')
    const detail = rejected.map(row => row.message).join(' ')
    if (!attached) return `${detail} Nothing was attached.`
    return detail
}
