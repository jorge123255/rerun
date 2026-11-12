import { sameHub } from './connected-hub-policy.mjs'

export const HUB_OAUTH_RETURN = 'hub:oauth-return'

const CONNECT_PATH = '/api/oauth/mobile/start'
const TTL_MS = 10 * 60_000
const TICKET_SKEW_MS = 5 * 60_000
const claimToken = /^[A-Za-z0-9_-]{16,64}$/
const agentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const subjectPattern = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/
const ticketPart = /^[A-Za-z0-9_-]{16,1500}$/
const registrationPattern = /^[1-9][0-9]{0,15}$/

// A Connect ticket's `jti` is what the hub later echoes as `claim` (`grant.jti`).
// `status=success` with no claim, and every `status=error`, carry no ticket and no
// state, so they are never applied to a pending attempt. The page is told success
// only after this hub session's claim confirms, and the claim is left off that
// event: the parked row is single-use, and the page treats a bare success as done.
export function createHubServiceSignIn({ openBrowser, now = Date.now, channel = 'dev' }) {
    const byJti = new Map()
    const byOrigin = new Map()
    const spentClaims = new Map()

    function intact(attempt) {
        const entry = attempt.entry
        const window = entry?.window
        const contents = entry?.contents
        if (!window || !contents) return false
        if (typeof window.isDestroyed === 'function' && window.isDestroyed()) return false
        if (typeof contents.isDestroyed === 'function' && contents.isDestroyed()) return false
        if (contents.id !== attempt.webContentsId || entry.origin !== attempt.origin || entry.scope !== attempt.scope) return false
        return contents.mainFrame === attempt.frame && sameHub(attempt.frame.url, attempt.origin)
    }

    function drop(attempt) {
        if (!attempt || attempt.dropped) return
        attempt.dropped = true
        attempt.spent = true
        attempt.controller.abort()
        if (byJti.get(attempt.jti) === attempt) byJti.delete(attempt.jti)
        if (byOrigin.get(attempt.origin) === attempt) byOrigin.delete(attempt.origin)
        clearTimeout(attempt.timer)
        attempt.unwatch?.()
        attempt.unwatch = null
    }

    function report(attempt, result) {
        if (attempt.dropped || !intact(attempt)) return
        try { attempt.frame.send(HUB_OAUTH_RETURN, { registrationId: attempt.registrationId, result }) } catch { /* window already gone */ }
    }

    function watch(attempt) {
        const window = attempt.entry.window
        const contents = attempt.entry.contents
        const onClose = () => drop(attempt)
        const onNavigate = (_event, _url, inPlace, mainFrame) => {
            if (!mainFrame || inPlace) return
            drop(attempt)
        }
        window.once?.('closed', onClose)
        contents.on?.('did-start-navigation', onNavigate)
        contents.on?.('render-process-gone', onClose)
        attempt.unwatch = () => {
            window.removeListener?.('closed', onClose)
            contents.removeListener?.('did-start-navigation', onNavigate)
            contents.removeListener?.('render-process-gone', onClose)
        }
    }

    function readConnect(entry, rawUrl) {
        if (typeof rawUrl !== 'string') return undefined
        let url
        try { url = new URL(rawUrl) } catch { return undefined }
        if (url.pathname !== CONNECT_PATH) return undefined
        if (rawUrl.length > 4096 || url.username || url.password || url.hash) return null
        if (url.origin !== entry?.origin || !sameHub(url.href, entry.origin)) return null
        if (url.searchParams.size !== 1 || url.searchParams.getAll('t').length !== 1) return null
        const token = url.searchParams.get('t') ?? ''
        if (token.length > 2048) return null
        const parts = token.split('.')
        if (parts.length !== 2 || !ticketPart.test(parts[0]) || !ticketPart.test(parts[1])) return null
        let json
        try { json = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) } catch { return null }
        if (!json || typeof json !== 'object' || Array.isArray(json)) return null
        if (json.kind !== 'ticket' || json.desktop !== channel) return null
        if (typeof json.exp !== 'number' || !Number.isFinite(json.exp) || json.exp <= now() || json.exp > now() + TICKET_SKEW_MS) return null
        if (typeof json.jti !== 'string' || !claimToken.test(json.jti)
            || typeof json.agentId !== 'string' || !agentIdPattern.test(json.agentId)) return null
        if (!Number.isSafeInteger(json.workspaceId) || json.workspaceId < 1) return null
        const hasKey = Object.hasOwn(json, 'key')
        const hasServer = Object.hasOwn(json, 'server')
        if (hasKey === hasServer) return null
        const subject = hasKey ? json.key : json.server
        if (typeof subject !== 'string' || !subjectPattern.test(subject)) return null
        const agent = encodeURIComponent(json.agentId)
        const route = hasKey
            ? `/api/v1/agents/${agent}/services/${encodeURIComponent(subject)}/authorized`
            : `/api/v1/agents/${agent}/mcp/${encodeURIComponent(subject)}/authorized`
        return { href: url.href, jti: json.jti, route, workspaceId: json.workspaceId }
    }

    function bindable(entry, frame, registrationId) {
        const contents = entry?.contents
        const id = contents?.id
        return typeof registrationId === 'string' && registrationPattern.test(registrationId) && typeof frame?.send === 'function'
            && !!entry && typeof entry.origin === 'string' && typeof entry.scope === 'string' && entry.scope.length >= 8
            && Number.isSafeInteger(id) && id > 0 && typeof contents.session?.fetch === 'function'
            && intact({ entry, origin: entry.origin, scope: entry.scope, webContentsId: id, frame })
    }

    return {
        cancel(entry, registrationId, frame) {
            const attempt = byOrigin.get(entry?.origin)
            if (attempt?.entry === entry && attempt.registrationId === registrationId && attempt.frame === frame) drop(attempt)
        },
        cancelAll() {
            for (const attempt of byJti.values()) drop(attempt)
        },
        async consider(entry, rawUrl, registrationId, frame) {
            const ticket = readConnect(entry, rawUrl)
            if (ticket === undefined) return false
            if (!bindable(entry, frame, registrationId)) return true
            const started = now()
            for (const [claim, expires] of spentClaims) if (expires <= started) spentClaims.delete(claim)
            const attempt = {
                origin: entry.origin, scope: entry.scope, webContentsId: entry.contents.id, entry, registrationId, frame,
                session: entry.contents.session, started, spent: false, dropped: false, controller: new AbortController(),
            }
            if (ticket === null || byJti.has(ticket.jti) || spentClaims.has(ticket.jti)) {
                report(attempt, { status: 'error', message: 'Start a new service sign-in to continue' })
                return true
            }
            drop(byOrigin.get(entry.origin))
            Object.assign(attempt, { jti: ticket.jti, route: ticket.route, workspaceId: ticket.workspaceId,
                timer: setTimeout(() => drop(attempt), TTL_MS) })
            attempt.timer.unref?.()
            byJti.set(attempt.jti, attempt)
            byOrigin.set(attempt.origin, attempt)
            watch(attempt)
            try { await Promise.resolve(openBrowser(ticket.href)) }
            catch {
                report(attempt, { status: 'error', message: 'Could not open the browser' })
                drop(attempt)
            }
            return true
        },
        async complete(result) {
            if (!result || result.status !== 'success' || !claimToken.test(result.claim ?? '')) return
            const attempt = byJti.get(result.claim)
            if (!attempt || attempt.spent || attempt.dropped || attempt.jti !== result.claim) return
            attempt.spent = true
            if (now() - attempt.started >= TTL_MS || !intact(attempt)) { drop(attempt); return }
            spentClaims.set(attempt.jti, now() + TTL_MS)
            if (spentClaims.size > 256) spentClaims.delete(spentClaims.keys().next().value)
            try {
                const response = await attempt.session.fetch(attempt.origin + attempt.route, {
                    method: 'POST', redirect: 'error', credentials: 'include',
                    // The upstream tab pins this header for its requests. A main-process
                    // fetch must do the same or it can claim against a different workspace.
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-workspace-id': String(attempt.workspaceId) },
                    body: JSON.stringify({ claim: attempt.jti }),
                    signal: AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(15_000)]),
                })
                if (response.body) void response.body.cancel().catch(() => {})
                if (attempt.dropped || !intact(attempt)) return
                if (response.status !== 204 || response.ok !== true) {
                    report(attempt, { status: 'error', message: 'The service sign-in could not be confirmed' })
                    return
                }
                report(attempt, { status: 'success' })
            } catch {
                if (attempt.dropped || !intact(attempt)) return
                report(attempt, { status: 'error', message: 'The service sign-in could not be confirmed' })
            } finally { drop(attempt) }
        },
    }
}
