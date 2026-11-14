import type { DesktopProviderUsage } from '@rerun/contracts'
import { listAgentIdsOnDisk } from '../../agents/loader.js'
import { aggregateUsageByProvider } from '../../db/repos/runs.js'

const DAY_MS = 24 * 60 * 60_000

/** Totals every coworker's finished replies by provider, for the last day and the last seven. */
export async function readDesktopProviderUsage(now = Date.now(), ports = { agents: listAgentIdsOnDisk, usage: aggregateUsageByProvider }): Promise<DesktopProviderUsage> {
    const since = { day: new Date(now - DAY_MS).toISOString(), week: new Date(now - 7 * DAY_MS).toISOString() }
    const providers: DesktopProviderUsage['providers'] = {}
    const add = (window: 'day' | 'week', rows: Awaited<ReturnType<typeof aggregateUsageByProvider>>) => {
        for (const row of rows) {
            if (!row.provider) continue
            const entry = providers[row.provider] ??= { day: { replies: 0, tokens: 0 }, week: { replies: 0, tokens: 0 } }
            entry[window].replies += Number(row.runCount) || 0
            entry[window].tokens += Math.max(0, Math.round(Number(row.totalTokens) || 0))
        }
    }
    for (const agentId of await ports.agents()) {
        // One coworker whose records cannot be read does not hide the others.
        const [day, week] = await Promise.all([ports.usage(agentId, since.day), ports.usage(agentId, since.week)]).catch(() => [[], []])
        add('day', day)
        add('week', week)
    }
    return { since, providers }
}
