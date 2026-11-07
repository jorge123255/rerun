export type FilesImportStatus = 'queued' | 'uploading' | 'finishing' | 'done' | 'error'

export type FilesImportCode =
    | 'unsafe_path'
    | 'reserved'
    | 'executable'
    | 'too_large'
    | 'clash'
    | 'outside'
    | 'other_user'
    | 'http'
    | 'dropped'
    | 'unconfirmed'
    | 'aborted'
    | 'unavailable'

/** One queued file. `saved` is true only after a confirmed workspace link. */
export type FilesImportItem = {
    id: string
    name: string
    dir: string
    path: string
    size: number
    status: FilesImportStatus
    loaded: number
    progress: number
    etaMs: number | null
    error: string | null
    saved: boolean
    code: FilesImportCode | null
}

export type FilesImportEntry = {
    name: string
    subDir: string
    size: number
    read: () => Promise<Uint8Array>
}

export type FilesImportWriteRequest = {
    path: string
    name: string
    dir: string
    bytes: Uint8Array
    signal: AbortSignal
    onProgress: (loaded: number, total: number) => void
}

/** Returned only when the publisher confirmed the link. */
export type FilesImportSaved = { saved: true; path: string }

export type FilesImportWriter = (request: FilesImportWriteRequest) => Promise<FilesImportSaved>

export type FilesImportBatchReceipt = {
    items: FilesImportItem[]
    savedCount: number
    failedCount: number
    active: boolean
}

export class FilesImportWriteError extends Error {
    readonly kind: 'http' | 'dropped' | 'unconfirmed' | 'aborted'

    constructor(
        message: string,
        readonly code: FilesImportCode,
        readonly status: number | null = null,
    ) {
        super(message)
        this.name = 'FilesImportWriteError'
        this.kind = code === 'unconfirmed' ? 'unconfirmed' : code === 'aborted' ? 'aborted' : code === 'dropped' ? 'dropped' : 'http'
    }
}

const FAILURE_CODES = new Set<FilesImportCode>([
    'unsafe_path', 'reserved', 'executable', 'too_large', 'clash', 'outside', 'other_user', 'http', 'dropped', 'unconfirmed', 'aborted', 'unavailable',
])

export function filesImportFailureCode(error: unknown): FilesImportCode {
    if (typeof error === 'object' && error !== null && 'code' in error && FAILURE_CODES.has((error as { code: FilesImportCode }).code)) {
        return (error as { code: FilesImportCode }).code
    }
    if (error instanceof Error && error.name === 'AbortError') return 'aborted'
    return 'dropped'
}

export function filesImportRetriesAutomatically(code: FilesImportCode): boolean {
    return code === 'dropped'
}
