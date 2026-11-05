export class TemplateRequestError extends Error {
    readonly status: 400 | 404 | 409 | 413 | 503
    constructor(status: 400 | 404 | 409 | 413 | 503, message: string) {
        super(message)
        this.name = 'TemplateRequestError'
        this.status = status
    }
}
