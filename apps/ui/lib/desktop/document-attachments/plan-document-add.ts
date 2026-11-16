import {
    DESKTOP_DOCUMENT_MAX_BYTES,
    DESKTOP_DOCUMENT_MAX_FILES,
    DESKTOP_DOCUMENT_STAGED_TOTAL_MAX_BYTES,
    DESKTOP_DOCUMENT_TOTAL_MAX_BYTES,
    FOREMAN_AGENT_ID,
    desktopDocumentMaxBytesForName,
    type DesktopDocumentScope,
} from '@rerun/contracts'

/** Whether this conversation's files can be saved into a coworker's Files, which is what lets a
 * file be larger than a document. Chief of Staff and a question's upload have no such place. */
export function desktopDocumentScopeHasFiles(scope: DesktopDocumentScope): boolean {
    return scope.agentId !== FOREMAN_AGENT_ID && !scope.questionId && !/^question:[a-f0-9]{64}$/.test(scope.tabUid)
}
/** A large file is streamed and gets longer to arrive than a document sent in one request. */
export const desktopDocumentTimeoutMs = (file: { size: number }) => file.size > DESKTOP_DOCUMENT_MAX_BYTES ? 120_000 : 25_000

const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`

export type DesktopDocumentAddRejectReason =
    | 'empty'
    | 'too-large'
    | 'capacity-files'
    | 'capacity-bytes'
    | 'capacity-large-bytes'
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
    /** The share of `attachedBytes` that is files above the document limit, which have their own total. */
    attachedLargeBytes?: number
    /** Whether files can be saved into a coworker's Files here: only then may some kinds exceed the document limit. */
    stagedFiles?: boolean
    /** Whether one more file can enter the retain buffer given files already accepted in this plan. */
    canRetainOne: (file: File, accepting: readonly File[]) => boolean
    maxFiles?: number
    maxBytesPerFile?: number
    maxTotalBytes?: number
    available?: boolean
}

function rejectMessage(file: File, reason: DesktopDocumentAddRejectReason, limit = DESKTOP_DOCUMENT_MAX_BYTES, stagedFiles = false): string {
    switch (reason) {
        case 'empty':
            return `${file.name} is empty.`
        case 'too-large':
            // Name the limit that applies to this file, and the other one where both exist.
            return limit > DESKTOP_DOCUMENT_MAX_BYTES
                ? `${file.name} is ${megabytes(file.size)}. Files saved to this coworker’s Files can be up to ${megabytes(limit)}.`
                : stagedFiles
                    ? `${file.name} is ${megabytes(file.size)}. This kind of file can be up to ${megabytes(limit)}; only files saved to this coworker’s Files (Office files, archives, video) can be larger.`
                    : `${file.name} is larger than ${megabytes(limit)}.`
        case 'capacity-files':
            return `Attachments can be up to ${DESKTOP_DOCUMENT_MAX_FILES} documents.`
        case 'capacity-bytes':
            return 'Attachments can be up to 48 MB across ten files.'
        case 'capacity-large-bytes':
            return `Files larger than 16 MB can be up to ${megabytes(DESKTOP_DOCUMENT_STAGED_TOTAL_MAX_BYTES)} in total in one message.`
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
    const stagedFiles = input.stagedFiles === true
    const limitFor = (file: File) => input.maxBytesPerFile ?? desktopDocumentMaxBytesForName(file.name, stagedFiles)
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
    let largeBytes = input.attachedLargeBytes ?? 0
    let bytes = input.attachedBytes - largeBytes
    for (const file of input.files) {
        if (!file.size) {
            rejects.push({ file, reason: 'empty', message: rejectMessage(file, 'empty') })
            continue
        }
        if (file.size > limitFor(file)) {
            rejects.push({ file, reason: 'too-large', message: rejectMessage(file, 'too-large', limitFor(file), stagedFiles) })
            continue
        }
        const large = file.size > DESKTOP_DOCUMENT_MAX_BYTES
        if (count + 1 > maxFiles) {
            rejects.push({ file, reason: 'capacity-files', message: rejectMessage(file, 'capacity-files') })
            continue
        }
        if (!large && bytes + file.size > maxTotalBytes) {
            rejects.push({ file, reason: 'capacity-bytes', message: rejectMessage(file, 'capacity-bytes') })
            continue
        }
        if (large && largeBytes + file.size > DESKTOP_DOCUMENT_STAGED_TOTAL_MAX_BYTES) {
            rejects.push({ file, reason: 'capacity-large-bytes', message: rejectMessage(file, 'capacity-large-bytes') })
            continue
        }
        if (!input.canRetainOne(file, accepts)) {
            rejects.push({ file, reason: 'retain-full', message: rejectMessage(file, 'retain-full') })
            continue
        }
        accepts.push(file)
        count += 1
        if (large) largeBytes += file.size
        else bytes += file.size
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
