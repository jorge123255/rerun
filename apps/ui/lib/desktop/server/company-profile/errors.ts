export class DesktopCompanyProfileError extends Error {
    constructor(readonly code: 'conflict' | 'stale' | 'not_found' | 'closed' | 'storage', message: string) {
        super(message)
        this.name = 'DesktopCompanyProfileError'
    }
}
