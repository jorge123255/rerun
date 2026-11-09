import { z } from 'zod'
import type { CodexRateLimits } from '../connections/plan-limits.js'
import { CodexAuthClient } from './codex-rpc.js'

export async function readDesktopCodexRateLimits(): Promise<CodexRateLimits | null> {
    const reader = new CodexAuthClient(() => {}, () => {})
    try {
        await reader.initialize()
        const account = await reader.request('account/read', { refreshToken: false })
        if (!z.object({ account: z.object({ type: z.literal('chatgpt') }) }).safeParse(account).success) return null
        return ((await reader.request('account/rateLimits/read', {})) ?? null) as CodexRateLimits | null
    } catch {
        return null
    } finally {
        reader.close()
    }
}
