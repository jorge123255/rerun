import 'server-only'
import { desktopWorkspaceFrozen } from './workspace-admission'
import { timingSafeEqual } from 'node:crypto'
import { readDesktopRuntime, type DesktopRuntime } from './runtime'

export const DESKTOP_SESSION_COOKIE = 'rerun-desktop-session'

export class DesktopHttpError extends Error {
    constructor(readonly status: number, message: string) {
        super(message)
        this.name = 'DesktopHttpError'
    }
}

function sameSecret(actual: string, expected: string): boolean {
    const left = Buffer.from(actual)
    const right = Buffer.from(expected)
    return left.length === right.length && timingSafeEqual(left, right)
}

function sessionCookie(header: string | null): string {
    for (const part of (header ?? '').split(';')) {
        const [name, ...value] = part.trim().split('=')
        if (name === DESKTOP_SESSION_COOKIE) return value.join('=')
    }
    return ''
}

export async function authenticateDesktopRequest(request: Request): Promise<DesktopRuntime> {
    const runtime = await readDesktopRuntime()
    const app = new URL(runtime.app.origin)
    if (request.headers.get('host') !== app.host || request.headers.get('sec-fetch-site') === 'cross-site') {
        throw new DesktopHttpError(403, 'Forbidden')
    }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && request.headers.get('origin') !== runtime.app.origin) {
        throw new DesktopHttpError(403, 'Forbidden')
    }
    if (!sameSecret(sessionCookie(request.headers.get('cookie')), runtime.app.sessionToken)) {
        throw new DesktopHttpError(401, 'Unauthorized')
    }
    if (desktopWorkspaceFrozen(runtime) && ['POST','PUT','PATCH','DELETE'].includes(request.method)) {
        const path = new URL(request.url).pathname
        const draft = /\/agents\/[^/]+\/draft$/.test(path) || /^\/api\/desktop\/brain\/(?:pages(?:\/|$)|ui-state$)/.test(path) || path === '/api/desktop/recent-coworkers' || path === '/api/desktop/foreman' || path === '/api/desktop/foreman/voice' || path === '/api/desktop/foreman/company'
        // The renderer flushes its pending board view after admissions freeze, before services stop.
        const boardView = request.method === 'PUT' && path === `/api/desktop/workspaces/${runtime.workspaceId}/board-camera`
        if (!draft && !boardView && path !== '/api/desktop/foreman/intake') throw new DesktopHttpError(409, 'This workspace is switching. Wait for it to finish.')
    }
    return runtime
}

export async function authenticateDesktopEngineRequest(request: Request): Promise<DesktopRuntime> {
    const runtime = await readDesktopRuntime()
    if (request.headers.get('host') !== new URL(runtime.app.origin).host) throw new DesktopHttpError(403, 'Forbidden')
    const header = request.headers.get('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token || !sameSecret(token, runtime.engine.apiKey)) throw new DesktopHttpError(401, 'Unauthorized')
    return runtime
}
