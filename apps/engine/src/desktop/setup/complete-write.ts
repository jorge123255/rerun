import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { agentDir } from '../../config/paths.js'
import type { AgentConfig } from '../../agents/types.js'
import type { RunContext } from '../../runtime/context.js'
import { sessionClaim } from '../../runtime/run-control.js'
import { desktopDeletionActive } from '../agent-lifecycle.js'
import { pinDirectory } from '../templates/files.js'

/** Stage first, then recheck cancellation at publication, not before an asynchronous disk write. */
export async function publishSetupCompletion(ctx: RunContext, config: AgentConfig): Promise<void> {
    const pin = await pinDirectory(agentDir(ctx.agent.id))
    const temporary = join(pin.pinned, `.setup-complete-${randomUUID()}.tmp`)
    try {
        const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
        try { await file.writeFile(`${JSON.stringify(config, null, 4)}\n`); await file.sync() }
        finally { await file.close() }
        ctx.abortSignal?.throwIfAborted()
        if (!ctx.runId || !ctx.abortSignal || sessionClaim(ctx.sessionId)?.runId !== ctx.runId || desktopDeletionActive(ctx.agent.id)) throw new Error('This setup run is no longer active.')
        await rename(temporary, join(pin.pinned, 'config.json'))
    } finally {
        await rm(temporary, { force: true }).catch(() => {})
        await pin.close()
    }
}
