import type { AgentConfig } from '../agents/types.js'
import { readAgentConfig } from '../agents/loader.js'
import { withAgentLock } from '../agents/lock.js'

const reviews = new Set<{ id: string; stop: AbortController }>()

const enabled = (config: AgentConfig) => config.tools.memory && config.selfImprovement.enabled && config.selfImprovement.autoMemory

// In-flight reviews belong to one uninterrupted period of learning. Turning learning
// back on starts a new period without reviving work that was pending when it was disabled.
export function noteLearningChange(id: string, before: AgentConfig, after: AgentConfig) {
    if (enabled(before) && !enabled(after)) {
        for (const review of reviews) if (review.id === id) review.stop.abort()
    }
}

export async function withDesktopLearning(id: string, review: (signal: AbortSignal) => Promise<void>) {
    const job = await withAgentLock(id, async () => {
        if (!enabled(await readAgentConfig(id))) return null
        const job = { id, stop: new AbortController() }
        reviews.add(job)
        return job
    })
    if (!job) return
    try { await review(job.stop.signal) }
    catch (error) { if (!job.stop.signal.aborted) throw error }
    finally { reviews.delete(job) }
}

export function applyDesktopLearning(id: string, signal: AbortSignal, write: () => Promise<void>) {
    return withAgentLock(id, async () => {
        if (!signal.aborted && enabled(await readAgentConfig(id))) await write()
    })
}
