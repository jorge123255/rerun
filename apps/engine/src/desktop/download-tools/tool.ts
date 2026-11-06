import { tool, type ToolSet } from 'ai'
import { withAgentLock } from '../../agents/lock.js'
import { workspaceDir } from '../../config/paths.js'
import type { RunContext } from '../../runtime/context.js'
import { beginDesktopAgentWork } from '../agent-lifecycle.js'
import { desktopDownloadPermissionBound, requireBoundDownloadPermission } from './binding.js'
import { downloadInputSchema, executeDownload } from './download.js'
import { DownloadPermissionError } from './errors.js'
import { readPublicBinary } from './reader.js'

export const DOWNLOAD_TOOL_DESCRIPTION = 'Download a public HTTP(S) file into this coworker’s Files (binary-safe). The file is not executed or unpacked, and an existing name is kept.'

export function desktopDownloadTools(ctx: RunContext): ToolSet {
    // Catalog stays pending until root binds requireDesktopToolGrant(..., 'download').
    if (!desktopDownloadPermissionBound()) return {}
    return {
        download: tool({
            description: DOWNLOAD_TOOL_DESCRIPTION,
            inputSchema: downloadInputSchema,
            execute: async (input, options) => {
                const signal = ctx.abortSignal ?? options.abortSignal
                if (!signal) throw new Error('Download requires an active, cancellable run.')
                signal.throwIfAborted()
                const release = beginDesktopAgentWork(ctx.agent.id)
                try {
                    const result = await executeDownload(input, {
                        signal,
                        workspaceRoot: workspaceDir(ctx.agent.id),
                        // Production reader. Regressions pass their own reader to executeDownload and do not open sockets.
                        read: readPublicBinary,
                        assertPermission: async () => {
                            try {
                                await withAgentLock(ctx.agent.id, async () => {
                                    signal.throwIfAborted()
                                    const finishRead = beginDesktopAgentWork(ctx.agent.id)
                                    try { await requireBoundDownloadPermission({ ...ctx, abortSignal: signal }) }
                                    finally { finishRead() }
                                })
                            } catch (error) {
                                if (signal.aborted || error instanceof DownloadPermissionError) throw error
                                throw new DownloadPermissionError(error instanceof Error ? error.message : 'Download permission is not bound.')
                            }
                        },
                    })
                    if (result.text.startsWith('Downloaded ') && !result.saved) {
                        throw new Error('The download result could not be confirmed. Check Files before retrying.')
                    }
                    if (result.failed) throw new Error(result.text)
                    return result.text
                } finally { release() }
            },
        }),
    }
}
