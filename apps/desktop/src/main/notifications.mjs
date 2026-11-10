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
export function createDesktopNotifications({ Notification, onClick, timeoutMs = 5000, now = Date.now }) {
    const active = new Map()
    let closed = false
    let retryAfter = 0
    function notify(value) {
        const payload = notificationPayload(value)
        if (!payload || closed || !Notification.isSupported()) return Promise.resolve({ status: 'unavailable' })
        if (active.has(payload.key)) return active.get(payload.key).result
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
        try { notice = new Notification({ title: payload.title, subtitle: payload.subtitle, body: payload.body, silent: true }) }
        catch { retryAfter = now() + 30_000; return Promise.resolve({ status: 'failed', diagnostic: 'construction-failed' }) }
        let settle
        const result = new Promise(resolve => { settle = resolve })
        const entry = { notice, result, settled: false }
        active.set(payload.key, entry)
        const finish = (status, diagnostic) => {
            if (entry.settled) return
            entry.settled = true
            clearTimeout(timer)
            settle({ status, ...(diagnostic ? { diagnostic } : {}) })
        }
        const timer = setTimeout(() => finish('unknown', 'observation-timeout'), timeoutMs)
        timer.unref?.()
        notice.once('show', () => finish('accepted'))
        // Electron's error string is deliberately ignored: it has no stable permission code
        // and may contain notification copy or other private native details.
        notice.once('failed', () => {
            if (active.get(payload.key) !== entry) return
            retryAfter = now() + 30_000
            finish('failed', 'native-failed')
            active.delete(payload.key)
        })
        notice.once('close', () => {
            finish('unknown', 'closed-before-acceptance')
            if (active.get(payload.key) === entry) active.delete(payload.key)
        })
        notice.once('click', () => {
            if (closed || active.get(payload.key) !== entry) return
            const { title, subtitle, body, silent, ...target } = payload
            onClick(target)
        })
        try { notice.show() } catch { finish('unknown', 'show-threw') }
        return result
    }
    return { notify, close() { closed = true; for (const { notice } of active.values()) notice.close(); active.clear() } }
}
