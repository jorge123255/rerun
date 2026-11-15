import type { ContextOccupancy } from '@rerun/contracts'
import type { ClaudeCodeSettings, Query } from 'ai-sdk-provider-claude-code'
import { planLimitWindowsFromClaude, recordPlanLimits, type ClaudePlanUsage } from '../connections/plan-limits.js'
import { desktopApp } from '../desktop/policy.js'

const CONTEXT_USAGE_TIMEOUT_MS = 3000

export type ClaudeContextCapture = {
    read: () => ContextOccupancy | undefined
    settings: Pick<ClaudeCodeSettings, 'hooks' | 'onQueryCreated'>
}

type PlanUsageReader = (options: { skipBehaviors: boolean }) => Promise<ClaudePlanUsage>

// The SDK ships the plan usage read under a name that announces it will be renamed. Looked up by
// key rather than called as a method, so the CLI bump that moves it costs a gauge and not a run.
function planUsageReaderOf(query: Query): PlanUsageReader | undefined {
    const reader = (query as unknown as Record<string, unknown>).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    return typeof reader === 'function' ? (reader as PlanUsageReader).bind(query) : undefined
}

async function withinTimeout<T>(task: Promise<T>): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined
    try {
        return await Promise.race([
            task,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('claude usage read timed out')), CONTEXT_USAGE_TIMEOUT_MS)
            }),
        ])
    } catch {
        return undefined
    } finally {
        clearTimeout(timer)
    }
}

// The context window occupancy only exists while the CLI subprocess is alive:
// `getContextUsage()` is a control-protocol round-trip that rejects once the
// query has finished, so it must run inside a Stop hook. The hook's return
// blocks the CLI's end of turn, hence the hard timeout. The plan limits of the
// subscription are read on the same occasion, for the same reason.
export function claudeContextCapture(connectionId?: string): ClaudeContextCapture {
    let query: Query | undefined
    let snapshot: ContextOccupancy | undefined

    const captureOccupancy = async (live: Query): Promise<void> => {
        const usage = await withinTimeout(live.getContextUsage())
        if (typeof usage?.totalTokens === 'number' && typeof usage.maxTokens === 'number' && usage.maxTokens > 0) {
            snapshot = { usedTokens: usage.totalTokens, maxTokens: usage.maxTokens }
        }
    }

    const capturePlanLimits = async (live: Query): Promise<void> => {
        // In the Mac app this request makes Claude's own tool ask Anthropic's usage service after
        // every reply. The owner decided on November 14, 2026 that the app never asks it: the plan's
        // limits come only from the rate-limit message the runner sends while it answers.
        if (desktopApp()) return
        const readPlanUsage = connectionId ? planUsageReaderOf(live) : undefined
        if (!connectionId || !readPlanUsage) return
        // Wrapped in a function so a reader that throws synchronously lands in the same catch.
        const usage = await withinTimeout((async () => readPlanUsage({ skipBehaviors: true }))())
        recordPlanLimits(connectionId, planLimitWindowsFromClaude(usage))
    }

    const stopHook = async (): Promise<{ continue: boolean }> => {
        if (query) await Promise.all([captureOccupancy(query), capturePlanLimits(query)])
        return { continue: true }
    }

    return {
        read: () => snapshot,
        settings: {
            onQueryCreated: q => {
                query = q
            },
            hooks: { Stop: [{ hooks: [stopHook] }] },
        },
    }
}
