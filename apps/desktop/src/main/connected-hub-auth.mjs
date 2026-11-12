import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readHubJson } from './connected-hub-policy.mjs'

const ttlMs = 15 * 60_000
const failed = reason => ({ status: 'error', reason })

export function createHubAuth({ origin, fetcher, openBrowser, now = Date.now }) {
    let pending = null

    function cancel() {
        pending?.controller.abort()
        pending = null
    }

    function live() {
        if (pending && now() - pending.started > ttlMs) cancel()
        return pending
    }

    function matches(state) {
        const attempt = live()
        if (!attempt || typeof state !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(state)) return false
        return timingSafeEqual(Buffer.from(attempt.state), Buffer.from(state))
    }

    return {
        cancel, matches,
        async start(provider) {
            if (live()?.exchanging) throw new Error('Sign-in is finishing')
            cancel()
            const verifier = randomBytes(32).toString('base64url')
            const attempt = { verifier, state: randomBytes(24).toString('base64url'), started: now(), controller: new AbortController(), exchanging: false }
            pending = attempt
            const url = new URL('/auth/desktop', origin)
            url.searchParams.set('challenge', createHash('sha256').update(verifier).digest('base64url'))
            url.searchParams.set('state', attempt.state)
            url.searchParams.set('channel', 'dev')
            if (provider === 'google' || provider === 'apple') url.searchParams.set('provider', provider)
            try { await openBrowser(url.href) }
            catch { if (pending === attempt) cancel(); throw new Error('Could not open the browser') }
        },
        async redeem(raw, state) {
            const attempt = live()
            if (!attempt) return failed('expired')
            if (state !== undefined && !matches(state)) return failed('state-mismatch')
            const code = typeof raw === 'string' && raw.length <= 128 ? raw.trim() : ''
            if (!/^[A-Za-z0-9_-]{43}$/.test(code) || attempt.exchanging) return failed('invalid')
            attempt.exchanging = true
            try {
                const response = await fetcher(origin + '/api/desktop/auth/exchange', {
                    method: 'POST', redirect: 'error', credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code, verifier: attempt.verifier }),
                    signal: AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(15_000)]),
                })
                const body = await readHubJson(response)
                // A close, origin change or replacement attempt invalidates the response.
                if (live() !== attempt) return failed('expired')
                if (response.ok && body?.ok === true) {
                    cancel()
                    return { status: 'signed-in' }
                }
                return failed(body?.reason === 'expired' ? 'expired' : response.status >= 500 ? 'network' : 'invalid')
            } catch { return failed(live() === attempt ? 'network' : 'expired') }
            finally { attempt.exchanging = false }
        },
    }
}
