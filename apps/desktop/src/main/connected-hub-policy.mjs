import { createHash } from 'node:crypto'

export const HUB_SCHEME = 'rerun-desktop-dev'
export const HUB_API_VERSION = 1
const loopback = new Set(['localhost', '127.0.0.1', '[::1]'])
const semver = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z.-]{1,64}))?$/
const token = /^[A-Za-z0-9_-]{16,128}$/

export function normalizeHubOrigin(address) {
    if (typeof address !== 'string' || address.length > 2048 || /[\x00-\x1f\x7f\\]/.test(address)) return null
    const input = address.trim()
    if (!input || input.startsWith('/')) return null
    const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(input)
    if (!hasScheme && /^[a-z][a-z\d+.-]*:/i.test(input) && !/^[^/?#]+:\d+(?:[/?#]|$)/.test(input)) return null
    try {
        const url = new URL(hasScheme ? input : `https://${input}`)
        if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback.has(url.hostname)))) return null
        return url.origin
    } catch { return null }
}

export function hubPartition(origin) {
    return 'persist:rerun-connected-hub-' + createHash('sha256').update(origin).digest('hex')
}

export function sameHub(url, origin) {
    try {
        const candidate = new URL(url)
        return (candidate.protocol === 'https:' || candidate.protocol === 'http:')
            && candidate.origin === origin && !candidate.username && !candidate.password
    } catch { return false }
}

export async function readHubJson(response) {
    const reader = response.body?.getReader()
    if (!reader) return null
    const chunks = []
    let size = 0
    try {
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > 4096) return null
            chunks.push(value)
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch { return null }
    finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}

// Match the upstream shell's major/minor/patch ordering. A release satisfies its prerelease floor.
function supportsVersion(version, floor) {
    for (const index of [1, 2, 3]) {
        if (Number(version[index]) !== Number(floor[index])) return Number(version[index]) > Number(floor[index])
    }
    return version[4] === undefined || (floor[4] !== undefined && version[4] >= floor[4])
}

export async function checkHub(origin, version, fetcher, signal = AbortSignal.timeout(8000)) {
    try {
        const response = await fetcher(origin + '/api/desktop/config', {
            signal, redirect: 'error', credentials: 'omit', headers: { Accept: 'application/json' },
        })
        if (!response.ok) {
            void response.body?.cancel().catch(() => {})
            return { ok: false, reason: response.status >= 500 ? 'unreachable' : 'not-rerun' }
        }
        const config = await readHubJson(response)
        signal.throwIfAborted()
        if (config?.app !== 'rerun' || !Number.isSafeInteger(config.apiVersion) || typeof config.minShellVersion !== 'string') {
            return { ok: false, reason: 'not-rerun' }
        }
        if (config.apiVersion !== HUB_API_VERSION) return { ok: false, reason: 'unsupported' }
        const installed = semver.exec(version), floor = semver.exec(config.minShellVersion)
        if (!installed || !floor) return { ok: false, reason: 'unsupported' }
        if (!supportsVersion(installed, floor)) return { ok: false, reason: 'too-old', minimum: config.minShellVersion }
        return { ok: true }
    } catch { return { ok: false, reason: 'unreachable' } }
}

export function parseHubLink(input) {
    if (typeof input !== 'string' || input.length > 3000 || /[\x00-\x1f\x7f\\]/.test(input)) return null
    try {
        const url = new URL(input)
        if (url.protocol !== HUB_SCHEME + ':' || url.username || url.password || url.hash) return null
        if (url.host === 'auth' && url.pathname === '/callback') {
            const [code] = url.searchParams.getAll('code'), [state] = url.searchParams.getAll('state')
            if (url.searchParams.size === 2 && token.test(code ?? '') && token.test(state ?? '')) return { kind: 'auth', code, state }
        }
        if (url.host === 'open' && (url.pathname === '' || url.pathname === '/')) {
            const path = url.searchParams.get('path') ?? ''
            if (url.searchParams.size === 1 && /^\/(?![\/\\])[\x21-\x7e]{0,1999}$/.test(path) && !path.includes('\\')) return { kind: 'open', path }
        }
    } catch {}
    return null
}
