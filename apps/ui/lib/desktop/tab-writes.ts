// The next coworker mount waits for its preceding writes, including closing or selecting a tab
// immediately before leaving the board. The server revision also protects independent windows.
const writes = new Map<string, Promise<void>>()

export function pendingTabWrite(agentId: string) {
    return writes.get(agentId)
}

export function queueTabWrite(agentId: string, write: () => Promise<void>) {
    const pending = (writes.get(agentId) ?? Promise.resolve()).then(write)
    const settled = pending.then(() => undefined, () => undefined)
    writes.set(agentId, settled)
    void settled.then(() => { if (writes.get(agentId) === settled) writes.delete(agentId) })
}
