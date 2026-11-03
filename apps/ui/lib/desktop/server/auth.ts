import 'server-only'
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
    return runtime
}
