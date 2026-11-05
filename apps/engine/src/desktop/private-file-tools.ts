import { tool, type ToolSet, type ToolExecutionOptions } from 'ai'
import { z } from 'zod'
import { env } from '../config/env.js'
import type { RunContext } from '../runtime/context.js'
import { beginDesktopAgentWork } from './agent-lifecycle.js'
import { hasDesktopToolGrant, requireDesktopToolGrant } from './tool-grants.js'
import { abortable } from './web-fetch/transport.js'

const path = z.string().min(1).max(4096)
const inputs = {
    fs_write: z.object({ path, content: z.string().max(262_144) }).strict(),
    fs_edit: z.object({ path, oldString: z.string().min(1).max(262_144), newString: z.string().max(262_144), replaceAll: z.boolean().optional() }).strict(),
}
const descriptions = {
    fs_write: 'Create a UTF-8 .txt or .md file through the Rerun app in this coworker\'s existing private Files directory. This app-managed action is separate from native shell filesystem access. Existing files are never replaced.',
    fs_edit: 'Edit a private Files document through the Rerun app by replacing an exact string. This app-managed action is separate from native shell filesystem access. By default oldString must match exactly once.',
}
const resultSchema = z.object({ status: z.enum(['saved', 'unchanged', 'unknown', 'refused']), path: z.string().optional(), message: z.string() })

export function desktopPrivateFileTools(ctx: RunContext): ToolSet {
    if (!hasDesktopToolGrant(ctx.agent.config, 'privateFileWrite')) return {}
    const execute = async (name: 'fs_write' | 'fs_edit', arguments_: Record<string, unknown>, options: ToolExecutionOptions) => {
            if (!ctx.runId || !ctx.abortSignal || !options.toolCallId) throw new Error('Private file editing requires an active, cancellable run.')
            const signal = AbortSignal.any([ctx.abortSignal, ...(options.abortSignal ? [options.abortSignal] : []), AbortSignal.timeout(35_000)])
            const release = beginDesktopAgentWork(ctx.agent.id)
            try {
                await abortable(requireDesktopToolGrant({ ...ctx, abortSignal: signal }, 'privateFileWrite'), signal)
                const config = env(), url = new URL(config.RERUN_HUB_BASE_URL ?? '')
                if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password || !config.RERUN_API_KEY)
                    throw new Error('Private file publication is unavailable.')
                const body = JSON.stringify({ engineAgentId: ctx.agent.id, sessionId: ctx.sessionId, runId: ctx.runId, toolCallId: options.toolCallId, tool: name, arguments: arguments_ })
                if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('Private file input exceeds limit.')
                const response = await abortable(fetch(`${url.origin}/api/desktop/engine/private-file-tools`, {
                    method: 'POST', headers: { Authorization: `Bearer ${config.RERUN_API_KEY}`, 'Content-Type': 'application/json' }, body, signal, redirect: 'error', credentials: 'omit',
                }), signal)
                const reader = response.body?.getReader()
                if (!reader) throw new Error('Publication acknowledgement unavailable. Inspect Files before retrying.')
                const chunks: Uint8Array[] = []; let size = 0
                const cancel = () => { void reader.cancel().catch(() => {}) }
                signal.addEventListener('abort', cancel, { once: true })
                try {
                    for (;;) {
                        signal.throwIfAborted()
                        const part = await abortable(reader.read(), signal)
                        signal.throwIfAborted()
                        if (part.done) break
                        size += part.value.byteLength
                        if (size > 16_384) throw new Error('Publication acknowledgement exceeds limit.')
                        chunks.push(part.value)
                    }
                    const result = resultSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
                    await abortable(requireDesktopToolGrant({ ...ctx, abortSignal: signal }, 'privateFileWrite'), signal)
                    if (!response.ok || result.status === 'unknown' || result.status === 'refused') throw new Error(result.message)
                    return JSON.stringify(result)
                } finally { signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => {}) }
            } finally { release() }
    }
    return {
        fs_write: tool({ description: descriptions.fs_write, inputSchema: inputs.fs_write, execute: (args, options) => execute('fs_write', args, options) }),
        fs_edit: tool({ description: descriptions.fs_edit, inputSchema: inputs.fs_edit, execute: (args, options) => execute('fs_edit', args, options) }),
    }
}
