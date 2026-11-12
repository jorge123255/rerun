import { join } from 'node:path'
import { atomicPrivateJSON, readJSON } from './workspaces/paths.mjs'
import { QUICK_ASK_SHORTCUT } from './quick-ask-window.mjs'

export async function loadQuickAskShortcut({ dataRoot, globalShortcut, open }) {
    const path = join(dataRoot, 'quick-ask.json')
    let enabled = true
    let registered = false
    let pending = Promise.resolve()
    try {
        const settings = await readJSON(path)
        enabled = settings?.version === 1 && settings.enabled === true
    } catch (error) {
        enabled = error.code === 'ENOENT'
    }
    function syncRegistration() {
        if (enabled && !registered) registered = globalShortcut.register(QUICK_ASK_SHORTCUT, open)
        if (!enabled && registered) unregister()
    }
    function unregister() {
        if (!registered) return
        globalShortcut.unregister(QUICK_ASK_SHORTCUT)
        registered = false
    }
    const state = () => ({ enabled, registered })
    syncRegistration()
    return {
        state, unregister,
        flush: () => pending,
        change(value, assertCurrent) {
            if (typeof value !== 'boolean') throw new Error('Invalid Quick Ask shortcut preference')
            const write = pending.then(async () => {
                assertCurrent()
                if (enabled !== value) {
                    await atomicPrivateJSON(path, { version: 1, enabled: value })
                    enabled = value
                }
                syncRegistration()
                return state()
            })
            pending = write.then(() => undefined, () => undefined)
            return write
        },
    }
}
