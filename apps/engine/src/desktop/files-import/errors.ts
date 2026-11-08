export type FilesImportErrorCode =
    | 'unsafe_path'
    | 'reserved'
    | 'executable'
    | 'too_large'
    | 'clash'
    | 'outside'
    | 'other_user'
    | 'unconfirmed'
    | 'aborted'
    | 'unavailable'

export class FilesImportError extends Error {
    readonly kind: 'http' | 'unconfirmed' | 'aborted'

    constructor(
        readonly status: number,
        message: string,
        readonly code: FilesImportErrorCode,
    ) {
        super(message)
        this.name = 'FilesImportError'
        this.kind = code === 'unconfirmed' ? 'unconfirmed' : code === 'aborted' ? 'aborted' : 'http'
    }
}

export const FILES_IMPORT_ESCAPE = (path: string) => `Path escapes the root: ${path}`
export const FILES_IMPORT_RESERVED = 'That path is reserved.'
export const FILES_IMPORT_EXECUTABLE = 'That file type can’t be imported.'
export const FILES_IMPORT_OUTSIDE = 'That path is outside this coworker’s workspace.'
export const FILES_IMPORT_OTHER_USER = 'This file belongs to another user. It was left unopened.'
export const FILES_IMPORT_UNCONFIRMED = 'The file import result could not be confirmed. Check Files before retrying.'
export const FILES_IMPORT_ABORTED = 'Import cancelled.'
export const FILES_IMPORT_UNAVAILABLE = 'Files import is only available on this Mac.'

export const filesImportClash = (name: string) => `This folder already has a file named “${name}”. The existing file was kept; rename yours and import it again.`
