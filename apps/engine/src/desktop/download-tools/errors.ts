import { DOWNLOAD_LIMIT_TEXT } from './limits.js'

export class DownloadPermissionError extends Error {
    constructor(message = 'Download permission is not bound.') {
        super(message)
        this.name = 'DownloadPermissionError'
    }
}

export class DownloadTooLargeError extends Error {
    readonly bytes: number
    constructor(bytes: number) {
        super(`Download too large (${bytes} bytes, limit ${DOWNLOAD_LIMIT_TEXT})`)
        this.name = 'DownloadTooLargeError'
        this.bytes = bytes
    }
}
