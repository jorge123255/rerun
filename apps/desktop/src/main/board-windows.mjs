import { randomUUID } from 'node:crypto'
import { approveDesktopDraftDrain, BeforeQuitDrafts } from './before-quit.mjs'

export function cascadeWindowBounds(window, screen) {
    const { x, y, width, height } = window.getBounds()
    const { workArea } = screen.getDisplayMatching({ x, y, width, height })
    return {
        x: Math.max(workArea.x, Math.min(x + 28, workArea.x + workArea.width - width)),
        y: Math.max(workArea.y, Math.min(y + 28, workArea.y + workArea.height - height)),
        width, height,
    }
}

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

    async function reload(entry, runtime, confirmDiscard, resume) {
        if (!ready(entry, runtime)) return false
        const { epoch, contents } = entry
        const frame = contents.mainFrame
        const address = frame.url
        const current = () => ready(entry, runtime) && entry.epoch === epoch
            && contents.mainFrame === frame && frame.url === address
        try {
            if (await approveDesktopDraftDrain(() => flush(entry, runtime, true), confirmDiscard, current)) {
                await entry.window.loadURL(address)
                return true
            }
        } catch { /* A failed navigation must release the original renderer if it still owns the window. */ }
        if (ready(entry, runtime) && entry.epoch === epoch) resume()
        return false
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
        get, ready, trusted, invalidate, flush, reload,
        list: () => [...entries.values()].filter(live),
        async flushAll(runtime, requireReady = false) {
            const current = [...entries.values()].filter(entry => live(entry) && entry.runtime === runtime)
            const outcomes = await Promise.all(current.map(entry => flush(entry, runtime, requireReady)))
            return outcomes.every(saved => saved)
        },
    }
}
