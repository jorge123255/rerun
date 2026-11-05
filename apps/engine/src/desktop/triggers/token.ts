import { timingSafeEqual, randomBytes } from 'node:crypto'

export function newDesktopTriggerToken(): string {
    return randomBytes(24).toString('base64url')
}

export function tokenMatches(given: string, expected: string): boolean {
    const a = Buffer.from(given, 'utf8')
    const b = Buffer.from(expected, 'utf8')
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}
