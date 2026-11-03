// The Codex thread a session can pick up again. Codex keys OpenAI's prompt cache on the thread id,
// so a session that opened a new thread on every message never read its prompt from the cache.
// Kept in memory: an engine restart costs one uncached message per session, nothing more.
type CodexThread = { threadId: string; connectionId: string; throughMessageId: string; toolAccess?: string }

const threads = new Map<string, CodexThread>()

const keyOf = (agentId: string, sessionId: string) => `${agentId}:${sessionId}`

// `throughMessageId` is the last message the thread itself produced. Anything written after it (a
// turn on another provider, a failed or cancelled run) is history the thread never saw, so the
// session starts a new thread from the full transcript instead.
export function codexThreadToResume(agentId: string, sessionId: string, connectionId: string, lastMessageId: string | undefined, toolAccess?: string): string | undefined {
    const thread = threads.get(keyOf(agentId, sessionId))
    if (!thread || thread.connectionId !== connectionId || thread.throughMessageId !== lastMessageId || thread.toolAccess !== toolAccess) return undefined
    return thread.threadId
}

export function rememberCodexThread(agentId: string, sessionId: string, thread: CodexThread): void {
    threads.set(keyOf(agentId, sessionId), thread)
}

export function forgetCodexThread(agentId: string, sessionId: string): void {
    threads.delete(keyOf(agentId, sessionId))
}

export function forgetCodexThreadsOf(connectionId: string): void {
    for (const [key, thread] of threads) if (thread.connectionId === connectionId) threads.delete(key)
}
