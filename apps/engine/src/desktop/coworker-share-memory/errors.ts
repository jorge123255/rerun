export class DesktopCoworkerShareMemoryError extends Error {
    readonly code: 'unavailable' | 'invalid' | 'conflict' | 'bounds' | 'stale'

    constructor(code: DesktopCoworkerShareMemoryError['code'], message: string) {
        super(message)
        this.name = 'DesktopCoworkerShareMemoryError'
        this.code = code
    }
}
