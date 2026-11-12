import { randomUUID } from 'node:crypto'
import { BeforeQuitDrafts } from './before-quit.mjs'

export function createBoardWindows({ startupUrl, isDesktopPage }) {
    const entries = new Map()
    const live = entry => entry && !entry.window.isDestroyed() && !entry.contents.isDestroyed()

    function get(window) {
        if (!window || window.isDestroyed()) return null
        const entry = entries.get(window.webContents)
        return live(entry) ? entry : null
    }

    function invalidate(entry) {
        entry.epoch = randomUUID()
        entry.drafts.reset()
    }

    function ready(entry, runtime) {
        return !!runtime && live(entry) && entry.runtime === runtime && isDesktopPage(entry.contents.mainFrame?.url)
    }

    function trusted(event, runtime) {
        const entry = entries.get(event.sender)
        if (live(entry) && event.senderFrame && event.senderFrame === entry.contents.mainFrame
            && (ready(entry, runtime) || (entry.primary && event.senderFrame.url === startupUrl))) return entry
        throw new Error('Untrusted desktop request')
    }

    async function flush(entry, runtime, requireReady = false) {
        if (!ready(entry, runtime)) return !entry.runtime
        if (!entry.drafts.ready) return !requireReady
        return entry.drafts.request(value => entry.contents.send('desktop:before-quit', value))
    }

    return {
        register(window, { primary }) {
            const contents = window.webContents
            const entry = { window, contents, primary, drafts: new BeforeQuitDrafts(), epoch: randomUUID(), runtime: null }
            entries.set(contents, entry)
            contents.once('destroyed', () => {
                entries.delete(contents)
                invalidate(entry)
            })
            return entry
        },
        get, ready, trusted, invalidate, flush,
        list: () => [...entries.values()].filter(live),
        async flushAll(runtime, requireReady = false) {
            const current = [...entries.values()].filter(entry => live(entry) && entry.runtime === runtime)
            const outcomes = await Promise.all(current.map(entry => flush(entry, runtime, requireReady)))
            return outcomes.every(saved => saved)
        },
    }
}
