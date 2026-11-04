import 'server-only'

// Route bundles share the supervised UI process. Serialize handle allocation and engine writes
// across its endpoints, then guard each projection write by the operation that requested it.
const queue = globalThis as typeof globalThis & { desktopRosterPending?: Promise<void> }
export function withRosterWrite<T>(action: () => Promise<T>): Promise<T> {
    const result = (queue.desktopRosterPending ?? Promise.resolve()).then(action)
    queue.desktopRosterPending = result.then(() => {}, () => {})
    return result
}
