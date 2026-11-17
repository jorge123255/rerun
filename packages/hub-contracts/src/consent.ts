// Whether a visitor objects to the analytics stack (PostHog plus the `rr_*` funnel cookies). The
// model is opt-out: the stack runs until it is refused, and the banner is still shown to everyone
// the EEA and the UK owe one so the refusal is one click away.
//
// No IP geolocation anywhere: the landing is prerendered and reading a header would turn it
// dynamic. The audience is guessed in the browser from its time zone, and the decision is
// remembered in a cookie on the parent domain so it survives the hop to app.rerun.build.

export const CONSENT_COOKIE = 'rerun-consent'

// Six months, the lifetime the CNIL recommends for a consent decision.
export const CONSENT_COOKIE_MAX_AGE = 180 * 24 * 60 * 60

// Set on <html> before the first paint, so the scripts running after it know whether they are
// allowed to write anything.
export const CONSENT_ATTRIBUTE = 'data-consent'

// Every stored decision carries this version. Bumping it the day a purpose is added re-asks
// instead of inheriting a consent that never covered it.
export const CONSENT_VERSION = 'v1'

export type ConsentDecision = 'granted' | 'denied'

// `exempt` is a visitor outside the EEA and the UK, who is never shown the banner. `pending` is a
// visitor who is owed one and has not answered yet.
export type ConsentStatus = ConsentDecision | 'pending' | 'exempt'

// An explicit list, never a `Europe/` prefix test: the prefix would catch Moscow, Istanbul and
// Kyiv, and would miss the Atlantic islands, the French overseas departments and Cyprus. EU 27 +
// Iceland, Liechtenstein and Norway + the UK and its Crown dependencies. `Europe/Zurich` is out,
// the Swiss FADP asks for no prior consent. When in doubt a zone goes in: the cost of a banner
// shown to someone who did not need it is nil.
export const EEA_UK_TIME_ZONES = [
    'Africa/Ceuta',
    'America/Cayenne',
    'America/Guadeloupe',
    'America/Martinique',
    'Arctic/Longyearbyen',
    'Asia/Famagusta',
    'Asia/Nicosia',
    'Atlantic/Azores',
    'Atlantic/Canary',
    'Atlantic/Faroe',
    'Atlantic/Madeira',
    'Atlantic/Reykjavik',
    'Europe/Amsterdam',
    'Europe/Andorra',
    'Europe/Athens',
    'Europe/Berlin',
    'Europe/Bratislava',
    'Europe/Brussels',
    'Europe/Bucharest',
    'Europe/Budapest',
    'Europe/Busingen',
    'Europe/Copenhagen',
    'Europe/Dublin',
    'Europe/Gibraltar',
    'Europe/Guernsey',
    'Europe/Helsinki',
    'Europe/Isle_of_Man',
    'Europe/Jersey',
    'Europe/Lisbon',
    'Europe/Ljubljana',
    'Europe/London',
    'Europe/Luxembourg',
    'Europe/Madrid',
    'Europe/Malta',
    'Europe/Mariehamn',
    'Europe/Monaco',
    'Europe/Nicosia',
    'Europe/Oslo',
    'Europe/Paris',
    'Europe/Podgorica',
    'Europe/Prague',
    'Europe/Riga',
    'Europe/Rome',
    'Europe/San_Marino',
    'Europe/Sofia',
    'Europe/Stockholm',
    'Europe/Tallinn',
    'Europe/Vaduz',
    'Europe/Vatican',
    'Europe/Vienna',
    'Europe/Vilnius',
    'Europe/Warsaw',
    'Europe/Zagreb',
]

// Fails closed: a browser that hides or breaks `Intl` is treated as owed a banner.
export function consentRequiredForTimeZone(timeZone?: string | null): boolean {
    return timeZone ? EEA_UK_TIME_ZONES.includes(timeZone) : true
}

// Takes the decoded cookie value, so the server can read the decision from a request without
// touching `document`.
export function parseConsentCookie(raw: string | undefined | null): ConsentDecision | undefined {
    if (!raw) return undefined
    const [version, decision] = raw.split(':')
    if (version !== CONSENT_VERSION) return undefined
    return decision === 'granted' || decision === 'denied' ? decision : undefined
}

export function readConsentCookie(): ConsentDecision | undefined {
    if (typeof document === 'undefined') return undefined
    const match = document.cookie.match(new RegExp(`(?:^|; )${CONSENT_COOKIE}=([^;]*)`))
    return parseConsentCookie(match ? decodeURIComponent(match[1]) : undefined)
}

// The timestamp is the proof the decision is asked for by article 7(1) GDPR. Same option set as
// the bootstrap script, without which this would write a second cookie beside its one instead of
// overwriting it.
export function writeConsentCookie(decision: ConsentDecision) {
    const parts = [
        `${CONSENT_COOKIE}=${CONSENT_VERSION}:${decision}:${Date.now()}`,
        'path=/',
        `max-age=${CONSENT_COOKIE_MAX_AGE}`,
        'SameSite=Lax',
    ]
    if (location.hostname.endsWith('rerun.build')) parts.push('domain=.rerun.build')
    if (location.protocol === 'https:') parts.push('Secure')
    document.cookie = parts.join('; ')
}

// Browser-only, and never during a render: the landing is prerendered and served from a CDN, so a
// banner decided at render time would end up in the static HTML of every visitor.
export function detectConsentStatus(): ConsentStatus {
    if (typeof document === 'undefined') return 'pending'
    const decision = readConsentCookie()
    if (decision) return decision
    try {
        return consentRequiredForTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ? 'pending' : 'exempt'
    } catch {
        return 'pending'
    }
}

// `pending` counts as allowed: a visitor who is owed a banner is measured while it is on screen,
// and only an explicit refusal closes the gate.
export function analyticsAllowed(status: ConsentStatus): boolean {
    return status !== 'denied'
}
