import { sameHub } from './connected-hub-policy.mjs'

const crashRecoveryInterval = 60_000

export function createHubRecovery({ window, origin, offlinePage, available, check, invalidate, now = () => performance.now() }) {
    const contents = window.webContents
    const host = new URL(origin).host
    let target = origin + '/'
    let issue = null
    let rendering = null
    let retry = null
    let closed = false
    let lastCrash = -Infinity

    const alive = () => available() && !closed && !window.isDestroyed()
    const state = () => issue && { host, ...issue }
    const onOfflinePage = () => !window.isDestroyed() && !!issue && contents.mainFrame?.url === offlinePage.href

    function showOffline(address, reason) {
        if (!alive() || !sameHub(address, origin)) return Promise.resolve(false)
        target = address
        issue = { reason }
        invalidate()
        if (!rendering) {
            rendering = window.loadURL(offlinePage.href).then(() => true, () => false)
                .finally(() => { rendering = null })
        }
        return rendering
    }

    async function load(address) {
        if (!alive() || !sameHub(address, origin)) return false
        try { await window.loadURL(address) }
        catch { if (!rendering && !onOfflinePage()) return false }
        if (rendering) await rendering
        return alive() && (onOfflinePage() || (!issue && sameHub(contents.mainFrame?.url, origin)))
    }

    contents.on('did-fail-load', (_event, code, _description, address, mainFrame) => {
        // Aborted includes downloads and a navigation replaced by a newer one.
        if (mainFrame && code !== -3 && sameHub(address, origin)) void showOffline(address, 'offline')
    })
    contents.on('did-navigate', (_event, address, code) => {
        if (!sameHub(address, origin)) return
        if (code >= 502 && code <= 504) {
            void showOffline(address, 'unavailable')
            return
        }
        target = address
        issue = null
    })
    contents.on('did-navigate-in-page', (_event, address, mainFrame) => {
        if (mainFrame && !issue && sameHub(address, origin)) target = address
    })
    contents.on('render-process-gone', (_event, details) => {
        if (!alive()) return
        if (details.reason === 'clean-exit') { invalidate(); return }
        const at = now()
        const repeated = at - lastCrash < crashRecoveryInterval
        lastCrash = at
        if (repeated) {
            if (!issue) void showOffline(target, 'renderer-crashed')
            else invalidate()
            return
        }
        invalidate()
        // Recreate the recovery page if that was what the renderer was showing.
        // Otherwise reload the last committed same-server route in the existing session.
        if (issue) void window.loadURL(offlinePage.href).catch(() => {})
        else void load(target)
    })
    window.once('closed', () => {
        closed = true
        retry?.controller.abort()
    })

    return {
        state, onOfflinePage, showOffline,
        target: () => target,
        navigate(address) {
            retry?.controller.abort()
            return load(address)
        },
        retry() {
            if (!alive() || !onOfflinePage()) return Promise.resolve(null)
            if (retry) return retry.promise
            const controller = new AbortController()
            const promise = (async () => {
                const result = await check(controller.signal)
                if (!alive() || controller.signal.aborted || !onOfflinePage()) return null
                if (result.ok) await load(target)
                else if (result.reason !== 'unreachable') {
                    issue = { reason: result.reason, ...(result.minimum ? { minimum: result.minimum } : {}) }
                } else if (issue.reason !== 'unavailable') issue = { reason: 'offline' }
                return state()
            })().finally(() => { retry = null })
            retry = { controller, promise }
            return promise
        },
    }
}
