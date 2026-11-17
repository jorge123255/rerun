// Whether the visitor has a real session on app.rerun.build, told to the landing and to nobody
// else. The Supabase auth cookie is host-only on the app and must stay that way: widening its
// domain would hand the refresh token to every sibling subdomain, docs.rerun.build included, which
// is hosted by a third party. So the app writes this flag beside it on the parent domain, with
// nothing in it but the fact that someone is signed in.
//
// It carries no secret and is deliberately readable by JavaScript: the landing is prerendered, so
// its header CTA can only be swapped by a script running before the first paint.

export const SESSION_HINT_COOKIE = 'rerun-session'

export const SESSION_HINT_VALUE = '1'

// A month of not opening the app and the hint decays on its own. The session itself lives far
// longer, and the cost of a hint that outlives it is one click landing on /auth.
export const SESSION_HINT_MAX_AGE = 30 * 24 * 60 * 60

// Set on <html> before the first paint by the landing's bootstrap script.
export const SESSION_HINT_ATTRIBUTE = 'data-session'

export const SESSION_HINT_SIGNED_IN = 'in'

export function parseSessionHintCookie(raw: string | undefined | null): boolean {
    return raw === SESSION_HINT_VALUE
}

export function readSessionHint(): boolean {
    if (typeof document === 'undefined') return false
    const match = document.cookie.match(new RegExp(`(?:^|; )${SESSION_HINT_COOKIE}=([^;]*)`))
    return parseSessionHintCookie(match ? decodeURIComponent(match[1]) : undefined)
}

// A cookie scoped to the parent domain is only removed by a write carrying that same domain and
// path, which is why this cannot be a plain delete.
export function clearSessionHintCookie() {
    const parts = [`${SESSION_HINT_COOKIE}=`, 'path=/', 'max-age=0', 'SameSite=Lax']
    if (location.hostname.endsWith('rerun.build')) parts.push('domain=.rerun.build')
    if (location.protocol === 'https:') parts.push('Secure')
    document.cookie = parts.join('; ')
}
