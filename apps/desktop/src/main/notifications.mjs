// A deliberately narrow main-process notification boundary; renderer permissions stay denied.
const kinds = new Set(['done', 'error', 'info', 'question', 'approval', 'takeover', 'service', 'secret', 'mcp', 'tool-install'])
const text = (value, max, required = false) => typeof value === 'string' && value.length <= max && (!required || value.length > 0) && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)
export function notificationClickTarget(value) {
    if (!value || typeof value !== 'object' || !kinds.has(value.kind) || !text(value.key, 600, true)
        || !text(value.agentId, 128, true) || !text(value.sessionId, 128, true)) return null
    for (const key of ['groupId', 'terminalId', 'requestId']) if (value[key] != null && !text(value[key], 600, true)) return null
    return { key: value.key, kind: value.kind, agentId: value.agentId, sessionId: value.sessionId,
        ...Object.fromEntries(['groupId', 'terminalId', 'requestId'].filter(key => value[key] != null).map(key => [key, value[key]])) }
}
export function notificationPayload(value) {
    const target = notificationClickTarget(value)
    if (!target || !text(value.title, 256, true)) return null
    if (value.subtitle != null && !text(value.subtitle, 256) || value.body != null && !text(value.body, 2048)) return null
    return { ...target, title: value.title, subtitle: value.subtitle ?? '', body: value.body ?? '', silent: true }
}
export function createNativeNotifications({ Notification, timeoutMs = 5000, now = Date.now }) {
    const active = new Map()
    let closed = false
    let retryAfter = 0
    function notify(key, options, onClick, scope) {
        if (closed || !Notification.isSupported()) return Promise.resolve({ status: 'unavailable' })
        if (active.has(key)) return active.get(key).result
        // A refused OS delivery must not generate another native request every UI poll.
        // The durable event remains unconsumed and can be retried after this short cooldown.
        if (now() < retryAfter) return Promise.resolve({ status: 'unavailable' })
        if (active.size >= 128) {
            // Retain recent click targets and pending results, but never fill the bridge
            // forever with old notices for which the OS omitted a close event.
            const evicted = [...active].find(([, entry]) => entry.settled)
            if (!evicted) return Promise.resolve({ status: 'unavailable' })
            const [key, entry] = evicted
            active.delete(key)
            try { entry.notice.close() } catch { /* The native notice may already be gone. */ }
        }
        let notice
        try { notice = new Notification(options) }
        catch { retryAfter = now() + 30_000; return Promise.resolve({ status: 'failed', diagnostic: 'construction-failed' }) }
        let settle
        const result = new Promise(resolve => { settle = resolve })
        const entry = { notice, result, settled: false, scope }
        active.set(key, entry)
        const finish = (status, diagnostic) => {
            if (entry.settled) return
            entry.settled = true
            clearTimeout(timer)
            settle({ status, ...(diagnostic ? { diagnostic } : {}) })
        }
        const timer = setTimeout(() => finish('unknown', 'observation-timeout'), timeoutMs)
        entry.finish = finish
        timer.unref?.()
        notice.once('show', () => finish('accepted'))
        // Electron's error string is deliberately ignored: it has no stable permission code
        // and may contain notification copy or other private native details.
        notice.once('failed', () => {
            if (active.get(key) !== entry) return
            retryAfter = now() + 30_000
            finish('failed', 'native-failed')
            active.delete(key)
        })
        notice.once('close', () => {
            finish('unknown', 'closed-before-acceptance')
            if (active.get(key) === entry) active.delete(key)
        })
        notice.once('click', () => {
            if (closed || active.get(key) !== entry) return
            onClick()
        })
        try { notice.show() } catch { finish('unknown', 'show-threw') }
        return result
    }
    function discard(scope) {
        for (const [key, entry] of active) {
            if (entry.scope !== scope) continue
            active.delete(key)
            entry.finish('unknown', 'closed-before-acceptance')
            try { entry.notice.close() } catch { /* Already closed by the OS. */ }
        }
    }
    return { notify, discard, close() {
        closed = true
        for (const scope of new Set([...active.values()].map(entry => entry.scope))) discard(scope)
    } }
}

export function createDesktopNotifications({ onClick, ...dependencies }) {
    const native = createNativeNotifications(dependencies)
    return {
        notify(value, scope) {
            const payload = notificationPayload(value)
            if (!payload) return Promise.resolve({ status: 'unavailable' })
            const { title, subtitle, body, silent, ...target } = payload
            const key = scope ? JSON.stringify([scope.workspaceId, scope.launchNonce, target.key]) : target.key
            return native.notify(key, { title, subtitle, body, silent }, () => onClick(target, scope))
        },
        close: native.close,
    }
}

export function hubNotificationPayload(value) {
    if (!value || !text(value.id, 200, true) || !text(value.title, 200, true)
        || (value.body != null && !text(value.body, 1000))) return null
    return { id: value.id, title: value.title, body: value.body ?? '', silent: value.silent !== false }
}
