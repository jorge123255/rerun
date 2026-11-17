// Affonso, the affiliate program tracker. Its pixel and its API are served from our own domain
// instead of the vendor's: content blockers drop requests to a known tracker host, and a referral
// lost there is a payout an affiliate never sees. The prefix is `/r` rather than the vendor name so
// a blocklist has nothing to match on.

import { analyticsAllowed, detectConsentStatus } from './consent.js'

export const AFFILIATE_PROGRAM_ID = 'cmtiy5ghr0015cy8j2yvr4zrf'

// Days a click stays attributed to the affiliate who sent it. The pixel reads it off its own tag,
// not off the program, so this mirrors what the Affonso dashboard is set to.
export const AFFILIATE_COOKIE_DURATION = '30'

export const AFFILIATE_BASE_PATH = '/r'

// Where an affiliate signs up and tracks their referrals. Hosted by the vendor on our subdomain, so
// unlike the pixel it is a plain link a visitor follows and nothing a blocklist has a reason to drop.
export const AFFILIATE_PROGRAM_URL = 'https://rerun.affonso.io'

// Written by the pixel on the registrable domain, so the click that landed on rerun.build is still
// readable from app.rerun.build, where the account and the subscription are actually created.
export const AFFILIATE_REFERRAL_COOKIE = 'affonso_referral'

// The key Affonso looks for in the metadata of whatever Stripe object carries the revenue.
export const AFFILIATE_REFERRAL_METADATA_KEY = 'affonso_referral'

// The query parameters the pixel reads a referral from, in the order `pixel.js` checks them, plus
// the click id it appends to the landing URL itself. A page arriving with one of them has an
// affiliate to credit before anything else happens.
export const AFFILIATE_REFERRAL_PARAMS = ['affonso', 'atp', 'aff', 'via', 'ref', 'affonso_id'] as const

export function hasAffiliateReferral(search: string): boolean {
    const params = new URLSearchParams(search)
    return AFFILIATE_REFERRAL_PARAMS.some(name => params.has(name))
}

// The pixel resolves `psl.min.js` against its own src, so both static assets sit under this path
// and `next.config` rewrites them straight to the CDN. The API endpoints below cannot take that
// route, see `proxyAffiliateApi`.
export const AFFILIATE_PIXEL_SRC = `${AFFILIATE_BASE_PATH}/pixel.js`

const AFFILIATE_API_ENDPOINTS = {
    track: 'https://api.affonso.io/v1/track',
    signups: 'https://api.affonso.io/v1/signups',
}

export type AffiliateApiEndpoint = keyof typeof AFFILIATE_API_ENDPOINTS

// Affonso resolves the visitor's country from the calling IP. Proxied, every call would carry the
// address of our own edge, so the real one is read back from whatever the edge put in front.
const CLIENT_IP_HEADERS = ['cf-connecting-ip', 'true-client-ip', 'x-real-ip']

// What the vendor needs to identify a visit, and nothing more. Cookies are deliberately absent:
// this route now shares an origin with the Supabase session, which is ours to keep.
const FORWARDED_HEADERS = ['accept', 'accept-language', 'content-type', 'origin', 'referer', 'user-agent']

function clientIp(headers: Headers): string | null {
    for (const name of CLIENT_IP_HEADERS) {
        const value = headers.get(name)?.trim()
        if (value) return value
    }
    return headers.get('x-forwarded-for')?.split(',')[0].trim() || null
}

export async function proxyAffiliateApi(request: Request, endpoint: AffiliateApiEndpoint): Promise<Response> {
    const upstream = new URL(AFFILIATE_API_ENDPOINTS[endpoint])
    upstream.search = new URL(request.url).search

    const headers = new Headers()
    for (const name of FORWARDED_HEADERS) {
        const value = request.headers.get(name)
        if (value) headers.set(name, value)
    }
    const ip = clientIp(request.headers)
    if (ip) {
        headers.set('x-real-ip', ip)
        headers.set('x-forwarded-for', ip)
    }

    let upstreamResponse: Response
    try {
        upstreamResponse = await fetch(upstream, {
            method: request.method,
            headers,
            body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
            cache: 'no-store',
        })
    } catch {
        // A tracking call that cannot reach the vendor is not worth a 500 in the logs of every page.
        return new Response(null, { status: 502 })
    }

    const responseHeaders = new Headers({ 'cache-control': 'no-store' })
    const contentType = upstreamResponse.headers.get('content-type')
    if (contentType) responseHeaders.set('content-type', contentType)
    return new Response(upstreamResponse.body, { status: upstreamResponse.status, headers: responseHeaders })
}

type AffiliateSignup = {
    email?: string
    externalUserId?: string
    name?: string
}

declare global {
    interface Window {
        Affonso?: { signup(signup: AffiliateSignup): void }
    }
}

// The pixel loads `afterInteractive` and the sign-up it has to be told about happens right after a
// redirect, so the two race. Retried on a short interval instead of fired once at a `window.Affonso`
// that is not there yet.
const SIGNUP_RETRY_MS = 250
const SIGNUP_GIVE_UP_MS = 15_000

// A no-op for a visitor no affiliate sent: the pixel drops the call when it holds no referral.
export function reportAffiliateSignup(signup: AffiliateSignup): void {
    if (typeof window === 'undefined') return
    if (!analyticsAllowed(detectConsentStatus())) return

    const giveUpAt = Date.now() + SIGNUP_GIVE_UP_MS
    const attempt = () => {
        if (window.Affonso) return window.Affonso.signup(signup)
        if (Date.now() < giveUpAt) window.setTimeout(attempt, SIGNUP_RETRY_MS)
    }
    attempt()
}
