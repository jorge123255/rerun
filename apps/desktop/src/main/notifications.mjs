// A deliberately narrow main-process notification boundary; renderer permissions stay denied.
const kinds = new Set(['done', 'error', 'question', 'approval', 'takeover', 'service', 'secret'])
const text = (value, max, required = false) => typeof value === 'string' && value.length <= max && (!required || value.length > 0) && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)
export function notificationPayload(value) {
    if (!value || typeof value !== 'object' || !kinds.has(value.kind) || !text(value.key, 600, true)
        || !text(value.agentId, 128, true) || !text(value.sessionId, 128, true) || !text(value.title, 256, true)) return null
    for (const key of ['groupId', 'terminalId', 'requestId']) if (value[key] != null && !text(value[key], 600, true)) return null
    if (value.subtitle != null && !text(value.subtitle, 256) || value.body != null && !text(value.body, 2048)) return null
    return { key: value.key, kind: value.kind, agentId: value.agentId, sessionId: value.sessionId,
        ...Object.fromEntries(['groupId', 'terminalId', 'requestId'].filter(key => value[key] != null).map(key => [key, value[key]])),
        title: value.title, subtitle: value.subtitle ?? '', body: value.body ?? '', silent: true }
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
        if (active.size >= 128) return Promise.resolve({ status: 'unavailable' })
        let notice
        try { notice = new Notification({ title: payload.title, subtitle: payload.subtitle, body: payload.body, silent: true }) }
        catch { retryAfter = now() + 30_000; return Promise.resolve({ status: 'failed' }) }
        let settle
        const result = new Promise(resolve => { settle = resolve })
        const entry = { notice, result }
        active.set(payload.key, entry)
        const timer = setTimeout(() => settle({ status: 'unknown' }), timeoutMs)
        timer.unref?.()
        const finish = status => { clearTimeout(timer); settle({ status }) }
        notice.once('show', () => finish('shown'))
        notice.once('failed', () => { retryAfter = now() + 30_000; finish('failed'); active.delete(payload.key) })
        notice.once('close', () => { finish('unknown'); active.delete(payload.key) })
        notice.once('click', () => {
            if (closed) return
            const { title, subtitle, body, silent, ...target } = payload
            onClick(target)
        })
        try { notice.show() } catch { finish('unknown') }
        return result
    }
    return { notify, close() { closed = true; for (const { notice } of active.values()) notice.close(); active.clear() } }
}
