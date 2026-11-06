export class DesktopCoworkerShareDatabaseError extends Error {
    readonly code: 'unavailable' | 'invalid' | 'conflict' | 'bounds' | 'stale' | 'partial' | 'uncertain'

    constructor(code: DesktopCoworkerShareDatabaseError['code'], message: string) {
        super(message)
        this.name = 'DesktopCoworkerShareDatabaseError'
        this.code = code
    }
}
