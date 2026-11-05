export class SkillBoundaryError extends Error {
    readonly status: number
    constructor(status: number, message: string) {
        super(message)
        this.name = 'SkillBoundaryError'
        this.status = status
    }
}
