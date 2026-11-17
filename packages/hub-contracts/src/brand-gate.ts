// The UI kit is public, the code behind it is open source anyway. Only the labs stay behind one
// shared token rather than an account: they are work in progress, and the things that read them, an
// agent, a `curl`, the screenshot service, only ever carry a URL.
//
// The token travels as `?key=` and is then kept in a cookie on the parent domain, so unlocking on
// rerun.build also unlocks app.rerun.build.

export const BRAND_GATE_COOKIE = 'rerun-kit'
export const BRAND_GATE_PARAM = 'key'
export const BRAND_GATE_MAX_AGE = 365 * 24 * 60 * 60

export const LANDING_GATED_PATHS = ['/preview'] as const
export const APP_GATED_PATHS = ['/render/lab'] as const

export function isGatedPath(pathname: string, paths: readonly string[]): boolean {
    return paths.some(path => pathname === path || pathname.startsWith(`${path}/`))
}

// `grant` is a first visit carrying the token, and differs from `open` only in that the response
// has to remember it.
export type BrandGateVerdict = 'open' | 'grant' | 'deny'

export function brandGateVerdict(input: {
    secret: string | undefined
    param: string | null | undefined
    cookie: string | undefined
    production: boolean
}): BrandGateVerdict {
    // A dev server never asks for the token: these pages are worked on all day, and a local
    // screenshot run that silently 404s would be paid for in lost hours.
    if (!input.production) return 'open'
    // No token configured on a deployed host is a misconfiguration, and the safe reading of it is
    // that the pages stay closed rather than quietly published.
    if (!input.secret) return 'deny'
    if (input.param && input.param === input.secret) return 'grant'
    return input.cookie === input.secret ? 'open' : 'deny'
}
