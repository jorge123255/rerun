// The next coworker mount waits for its preceding writes, including closing or selecting a tab
// immediately before leaving the board. The server revision also protects independent windows.
const writes = new Map<string, Promise<void>>()

export async function flushTabWrites() {
    while (writes.size) await Promise.all([...writes.values()])
}

export function pendingTabWrite(agentId: string) {
    return writes.get(agentId)
}

export function queueTabWrite<T>(agentId: string, write: () => Promise<T>): Promise<T> {
    const pending = (writes.get(agentId) ?? Promise.resolve()).then(write)
    const settled = pending.then(() => undefined, () => undefined)
    writes.set(agentId, settled)
    void settled.then(() => { if (writes.get(agentId) === settled) writes.delete(agentId) })
    // Callers that transfer drafts need the actual outcome, while later writes still wait on
    // a settled tail so one failed request cannot permanently stall this coworker's queue.
    return pending
}
