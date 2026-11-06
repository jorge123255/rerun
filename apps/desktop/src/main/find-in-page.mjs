const MAX_QUERY = 200
const ACTIONS = new Set(['start', 'next', 'previous', 'stop'])

export function parseDesktopFindInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null
    const action = input.action
    if (!ACTIONS.has(action)) return null
    if (action === 'stop') return { action: 'stop' }
    if (typeof input.query !== 'string' || input.query.length > MAX_QUERY || input.query.includes('\0')) return null
    return { action, query: input.query }
}

// Search only the sender's page. The query never becomes a command, URL, or path.
export function handleFindInPage(contents, input) {
    const command = parseDesktopFindInput(input)
    if (!contents || contents.isDestroyed?.() || !command) return { ok: false, reason: 'unavailable' }
    if (command.action === 'stop' || !command.query.trim()) {
        contents.stopFindInPage('clearSelection')
        return { ok: true, stopped: command.action === 'stop', matches: 0, activeMatchOrdinal: 0 }
    }
    return new Promise(resolve => {
        let settled = false
        let timer
        let requestId = 0
        const finish = value => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            contents.removeListener?.('found-in-page', onFound)
            resolve(value)
        }
        function onFound(_event, result) {
            if (!result || result.requestId !== requestId || result.finalUpdate !== true) return
            finish({ ok: true, matches: result.matches ?? 0, activeMatchOrdinal: result.activeMatchOrdinal ?? 0 })
        }
        contents.on('found-in-page', onFound)
        requestId = contents.findInPage(command.query, { forward: command.action !== 'previous', findNext: command.action !== 'start' })
        timer = setTimeout(() => finish({ ok: false, reason: 'unavailable' }), 2000)
    })
}
