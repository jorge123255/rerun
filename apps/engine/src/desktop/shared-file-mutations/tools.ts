import { realpath } from 'node:fs/promises'
import { tool, type ToolExecutionOptions, type ToolSet } from 'ai'
import { sharedEditArgumentsSchema, sharedMutationCallSchema, sharedMutationResultSchema, sharedSearchArgumentsSchema, sharedWriteArgumentsSchema, type SharedMutationResult } from '@rerun/contracts'
import { readAgentConfig } from '../../agents/loader.js'
import { env } from '../../config/env.js'
import { dataDir } from '../../config/paths.js'
import type { RunContext } from '../../runtime/context.js'
import { assertDesktopAgentNotDeleted, beginDesktopAgentWork } from '../agent-lifecycle.js'
import { resolveEngineSharedDirectory } from '../shared-workspace-files.js'
import { abortable } from '../web-fetch/transport.js'
import { searchSharedDocuments, SharedMutationError } from './fs.js'
import { sharedReadGranted, sharedWriteGranted, type SharedGrantConfig } from './grants.js'

// Desktop shared_write, shared_edit, and shared_search.
// Writes go to the app publisher so a lost acknowledgement cannot write twice.
// Search only reads the running engine's shared directory.

const TURNED_OFF = 'This tool is turned off for this coworker.'
const UNBOUND = 'Shared file workspace authority is unbound.'

export type SharedWorkspaceGate = { workspaceId: number; assertCurrent(signal: AbortSignal): Promise<void> }
export type SharedWorkspacePort = () => Promise<SharedWorkspaceGate>

let workspacePort: SharedWorkspacePort | null = null
export function bindSharedMutationWorkspace(port: SharedWorkspacePort | null) { workspacePort = port }

function isAbort(error: unknown): boolean {
    return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

async function currentConfig(ctx: RunContext, signal: AbortSignal): Promise<SharedGrantConfig | null> {
    signal.throwIfAborted()
    ctx.abortSignal?.throwIfAborted()
    assertDesktopAgentNotDeleted(ctx.agent.id)
    const config = await readAgentConfig(ctx.agent.id).catch(() => null)
    signal.throwIfAborted()
    return config
}

async function gate(signal: AbortSignal): Promise<SharedWorkspaceGate> {
    if (!workspacePort) throw new Error(UNBOUND)
    const current = await workspacePort()
    signal.throwIfAborted()
    await current.assertCurrent(signal)
    if (!Number.isInteger(current.workspaceId) || current.workspaceId < 1) throw new Error('That workspace is not the open workspace.')
    return current
}

function formatSearch(result: { hits: { path: string; line: number; text: string }[]; truncated: boolean; omitted: { path: string; reason: string }[] }): string {
    if (result.hits.length === 0 && result.omitted.length === 0) return 'No matches.'
    const lines = result.hits.map(hit => `${hit.path}:${hit.line}: ${hit.text}`)
    if (result.truncated) lines.push(`(truncated at ${result.hits.length} results)`)
    for (const skip of result.omitted) lines.push(`(omitted ${skip.reason}: ${skip.path})`)
    return lines.join('\n')
}

export function desktopSharedMutationTools(ctx: RunContext): ToolSet {
    const config = ctx.agent.config as SharedGrantConfig
    const read = sharedReadGranted(config)
    const write = sharedWriteGranted(config)
    if (!read && !write) return {}
    const signalOf = (options: ToolExecutionOptions) => AbortSignal.any([
        ...(options.abortSignal ? [options.abortSignal] : []),
        ...(ctx.abortSignal ? [ctx.abortSignal] : []),
        AbortSignal.timeout(30_000),
    ])
    const tools: ToolSet = {}
    if (read) {
        tools.shared_search = tool({
            description: 'Search shared .txt and .md file contents with a regular expression. Returns matching lines as path:line: content. Skips node_modules and .git. Every coworker with Read shared files searches this same folder. This does not search a coworker’s private Files and it does not write.',
            inputSchema: sharedSearchArgumentsSchema,
            execute: async (input, options) => {
                const signal = signalOf(options)
                const release = beginDesktopAgentWork(ctx.agent.id)
                try {
                    if (!sharedReadGranted(await currentConfig(ctx, signal))) throw new Error(TURNED_OFF)
                    const current = await gate(signal)
                    const shared = await resolveEngineSharedDirectory(await realpath(dataDir()), signal)
                    await current.assertCurrent(signal)
                    const found = await searchSharedDocuments(shared, input, {
                        signal,
                        beforeCommit: async () => {
                            if (!sharedReadGranted(await currentConfig(ctx, signal))) throw new Error(TURNED_OFF)
                            await current.assertCurrent(signal)
                        },
                    })
                    if (!sharedReadGranted(await currentConfig(ctx, signal))) throw new Error(TURNED_OFF)
                    await current.assertCurrent(signal)
                    return formatSearch(found)
                } catch (error) {
                    if (isAbort(error)) throw error
                    if (error instanceof SharedMutationError) throw new Error(error.message)
                    throw error
                } finally { release() }
            },
        })
    }
    if (write) {
        const publish = async (toolName: 'shared_write' | 'shared_edit', arguments_: Record<string, unknown>, options: ToolExecutionOptions): Promise<string> => {
            if (!ctx.runId || !ctx.sessionId || !options.toolCallId) throw new Error('Shared file editing requires an active run.')
            const signal = signalOf(options)
            const release = beginDesktopAgentWork(ctx.agent.id)
            try {
                if (!sharedWriteGranted(await currentConfig(ctx, signal))) throw new Error(TURNED_OFF)
                const current = await gate(signal)
                const hub = env()
                const url = new URL(hub.RERUN_HUB_BASE_URL ?? '')
                if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password || !hub.RERUN_API_KEY) {
                    throw new Error('Shared file publication is unavailable.')
                }
                const call = sharedMutationCallSchema.parse({
                    workspaceId: current.workspaceId,
                    engineAgentId: ctx.agent.id,
                    sessionId: ctx.sessionId,
                    runId: ctx.runId,
                    toolCallId: options.toolCallId,
                    tool: toolName,
                    arguments: arguments_,
                })
                const body = JSON.stringify(call)
                if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('Shared file input exceeds limit.')
                await current.assertCurrent(signal)
                const response = await abortable(fetch(`${url.origin}/api/desktop/engine/shared-file-mutations`, {
                    method: 'POST', headers: { Authorization: `Bearer ${hub.RERUN_API_KEY}`, 'Content-Type': 'application/json' }, body, signal, redirect: 'error', credentials: 'omit',
                }), signal)
                const reader = response.body?.getReader()
                if (!reader) throw new Error('Publication acknowledgement unavailable. Inspect Shared files before retrying.')
                const chunks: Uint8Array[] = []
                let size = 0
                const cancel = () => { void reader.cancel().catch(() => {}) }
                signal.addEventListener('abort', cancel, { once: true })
                try {
                    for (;;) {
                        signal.throwIfAborted()
                        const part = await abortable(reader.read(), signal)
                        if (part.done) break
                        size += part.value.byteLength
                        if (size > 16_384) throw new Error('Publication acknowledgement exceeds limit.')
                        chunks.push(part.value)
                    }
                } finally { signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => {}) }
                const result = sharedMutationResultSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))) as SharedMutationResult
                if (!sharedWriteGranted(await currentConfig(ctx, signal))) throw new Error(TURNED_OFF)
                await current.assertCurrent(signal)
                if (!response.ok || result.status === 'uncertain' || result.status === 'refused') throw new Error(result.message)
                return JSON.stringify(result)
            } finally { release() }
        }
        tools.shared_write = tool({
            description: 'Create a UTF-8 .txt or .md file in the workspace shared folder, creating parent folders inside that folder as needed. Existing names are never replaced. This does not write a coworker’s private Files. Read shared files does not grant this tool.',
            inputSchema: sharedWriteArgumentsSchema,
            execute: (args, options) => publish('shared_write', args, options),
        })
        tools.shared_edit = tool({
            description: 'Edit a shared .txt or .md file by replacing an exact string. Pass expectedBytes and expectedSha256 of the current file. A mismatch keeps the file and reports the conflict. By default oldString must match exactly once. This does not edit a coworker’s private Files.',
            inputSchema: sharedEditArgumentsSchema,
            execute: (args, options) => publish('shared_edit', args, options),
        })
    }
    return tools
}
