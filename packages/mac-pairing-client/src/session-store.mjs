import { PHONE_SESSION_KEY } from './protocol.mjs'

export function createMemoryStorage(initial = {}) {
    const values = new Map(Object.entries(initial))
    return {
        async getItem(key) {
            return values.has(key) ? values.get(key) : null
        },
        async setItem(key, value) {
            values.set(key, value)
        },
        async removeItem(key) {
            values.delete(key)
        },
        snapshot() {
            return Object.fromEntries(values)
        },
    }
}

export function createMacSessionStore(storage) {
    return {
        async read() {
            const raw = await storage.getItem(PHONE_SESSION_KEY)
            if (!raw) return null
            try {
                const parsed = JSON.parse(raw)
                if (!parsed || parsed.kind !== 'rerun-mac-phone-pairing') return null
                if (parsed.status === 'approved' && typeof parsed.credential !== 'string') return null
                if (parsed.status === 'pending' && typeof parsed.requestToken !== 'string') return null
                return parsed
            } catch {
                return null
            }
        },
        async write(session) {
            await storage.setItem(PHONE_SESSION_KEY, JSON.stringify(session))
        },
        async clear() {
            await storage.removeItem(PHONE_SESSION_KEY)
        },
    }
}
