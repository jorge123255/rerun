// Holds one native click until the current renderer of the same workspace runtime asks for it.
// Permission, display-sharing suppression and clicks from a previous process are not decided here.
import { notificationClickTarget } from './notifications.mjs'

const MAX_HELD = 8
const MAX_DELIVERED = 32
const MAX_DIAGNOSTICS = 32

function scopeOf(scope) {
    if (!scope || !Number.isSafeInteger(scope.workspaceId) || scope.workspaceId < 1) return null
    if (typeof scope.launchNonce !== 'string' || !/^[a-f0-9-]{36}$/i.test(scope.launchNonce)) return null
    return { workspaceId: scope.workspaceId, launchNonce: scope.launchNonce }
}

// The click comes from a notice owned by this process. Only its workspace is carried across a
// switch. The target renderer still validates the exact conversation against its own live data.
export async function routeDesktopNotificationClick(value, submittedScope, { currentScope, switchWorkspace, deliver }) {
    const target = notificationClickTarget(value)
    const submitted = scopeOf(submittedScope)
    let current = scopeOf(currentScope())
    if (!target || !submitted || !current) return false
    if (current.workspaceId !== submitted.workspaceId) {
        const result = await switchWorkspace(submitted.workspaceId)
        if (!result?.ok) return false
        current = scopeOf(currentScope())
        if (current?.workspaceId !== submitted.workspaceId) return false
    }
    deliver(target, current)
    return true
}

export function createNotificationClickHandoff() {
    let held = []
    let delivered = []
    const diagnostics = []
    let stopped = false
    const note = entry => {
        diagnostics.push(entry)
        if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.shift()
    }
    const remember = item => {
        delivered.push({ bound: item.bound, key: item.target.key })
        if (delivered.length > MAX_DELIVERED) delivered.shift()
    }
    const drop = (reason, target, scope) => note({
        outcome: 'dropped', reason, ...(target?.key ? { key: target.key } : {}),
        ...(scope ? { workspaceId: scope.workspaceId } : {}), ...(target?.sessionId ? { sessionId: target.sessionId } : {}),
    })
    function retain(scope) {
        const current = scopeOf(scope)
        if (!current || stopped) return
        const bound = `${current.workspaceId}\0${current.launchNonce}`
        held = held.filter(item => {
            if (item.bound === bound) return true
            drop(item.scope.workspaceId === current.workspaceId ? 'stale-runtime' : 'stale-workspace', item.target, item.scope)
            delivered = delivered.filter(entry => entry.bound !== item.bound)
            return false
        })
    }
    return {
        accept(value, scope) {
            const target = notificationClickTarget(value)
            if (stopped) { drop('quitting', target, scopeOf(scope)); return 'dropped' }
            if (!target) { drop('malformed'); return 'dropped' }
            const current = scopeOf(scope)
            if (!current) { drop('runtime-unavailable', target); return 'dropped' }
            const bound = `${current.workspaceId}\0${current.launchNonce}`
            if (delivered.some(entry => entry.bound === bound && entry.key === target.key) || held.some(item => item.bound === bound && item.target.key === target.key)) {
                drop('duplicate', target, current)
                return 'dropped'
            }
            if (held.length >= MAX_HELD) {
                const stale = held.findIndex(item => item.bound !== bound)
                const index = stale === -1 ? 0 : stale
                const [removed] = held.splice(index, 1)
                drop('queue-bound', removed.target, removed.scope)
            }
            held.push({ bound, scope: current, target })
            note({ outcome: 'held', key: target.key, workspaceId: current.workspaceId, sessionId: target.sessionId })
            return 'held'
        },
        // deliver returns true only after the authorized current renderer accepts the existing click route.
        flush(scope, deliver) {
            if (stopped || typeof deliver !== 'function') return []
            retain(scope)
            const current = scopeOf(scope)
            if (!current) return []
            const bound = `${current.workspaceId}\0${current.launchNonce}`
            const sent = []
            const rest = []
            for (const item of held) {
                if (item.bound !== bound) { rest.push(item); continue }
                let accepted = false
                try { accepted = deliver({ ...item.target }) === true } catch { accepted = false }
                if (!accepted) { rest.push(item); continue }
                remember(item)
                note({ outcome: 'delivered', key: item.target.key, workspaceId: item.scope.workspaceId, sessionId: item.target.sessionId })
                sent.push(item.target)
            }
            held = rest
            return sent
        },
        retain,
        stop() {
            stopped = true
            for (const item of held) drop('quitting', item.target, item.scope)
            held = []
        },
        snapshot() {
            return {
                held: held.map(item => ({ key: item.target.key, workspaceId: item.scope.workspaceId, sessionId: item.target.sessionId, launchNonce: item.scope.launchNonce })),
                diagnostics: diagnostics.map(entry => ({ ...entry })),
            }
        },
    }
}
