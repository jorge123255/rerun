import { tool, type ToolSet } from 'ai'
import { FOREMAN_AGENT_ID } from '@rerun/contracts'
import { FOREMAN_AGENT_FILE_COPY, foremanAgentFileEditInput, foremanAgentFileGrantOn, foremanAgentFileListInput, foremanAgentFileReadInput, foremanAgentFileSearchInput, foremanAgentFileWriteInput, type ForemanAgentFileGrantId } from './contract.js'
import { readAgentConfig } from '../../agents/loader.js'
import { desktopDeletionActive } from '../agent-lifecycle.js'
import { listAgentIndex } from '../../db/repos/agents.js'
import { getRun } from '../../db/repos/runs.js'
import type { RunContext } from '../../runtime/context.js'
import { listCoworkerVisible, readCoworkerVisibleText, searchCoworkerVisibleText } from './read.js'
import { foremanAgentFileEditArguments, foremanAgentFileWriteArguments, publishForemanAgentFile, type ForemanAgentFilePublication } from './publish.js'
import { deny, ForemanAgentFileError, resolveCoworkerTarget } from './policy.js'

export type ForemanAgentFilePorts = {
    config: () => Promise<{ kind?: string; enabled?: boolean; tools?: { desktopToolGrants?: Record<string, boolean | undefined> } } | null>
    run: () => Promise<{ id: string; agentId: string; sessionId: string; status: string } | null>
    coworkers: () => Promise<{ id: string; name: string }[]>
    readText: (coworkerId: string, path: string, signal: AbortSignal) => Promise<string>
    list: (coworkerId: string, path: string, signal: AbortSignal) => Promise<{ entries: { name: string; directory: boolean }[]; truncated: boolean }>
    search: (coworkerId: string, path: string, pattern: string, maxResults: number, signal: AbortSignal) => Promise<string>
    publish: (body: ForemanAgentFilePublication, signal: AbortSignal) => Promise<{ status: 'saved' | 'unchanged'; path?: string; message: string }>
}

function productionPorts(ctx: RunContext): ForemanAgentFilePorts {
    return {
        config: async () => readAgentConfig(FOREMAN_AGENT_ID).catch(() => null),
        run: async () => {
            if (!ctx.runId) return null
            const run = await getRun(FOREMAN_AGENT_ID, ctx.runId).catch(() => null)
            return run ? { id: run.id, agentId: run.agentId, sessionId: run.sessionId, status: run.status } : null
        },
        coworkers: () => listAgentIndex().then(rows => rows.map(row => ({ id: row.id, name: row.name }))),
        readText: (id, path, signal) => desktopDeletionActive(id) ? deny(FOREMAN_AGENT_FILE_COPY.workspace) : readCoworkerVisibleText(id, path, signal),
        list: (id, path, signal) => desktopDeletionActive(id) ? deny(FOREMAN_AGENT_FILE_COPY.workspace) : listCoworkerVisible(id, path, signal),
        search: (id, path, pattern, maxResults, signal) => desktopDeletionActive(id) ? deny(FOREMAN_AGENT_FILE_COPY.workspace) : searchCoworkerVisibleText(id, path, pattern, maxResults, signal),
        publish: publishForemanAgentFile,
    }
}

async function admitted(ctx: RunContext, ports: ForemanAgentFilePorts, grant: ForemanAgentFileGrantId, signal: AbortSignal) {
    if (!ctx.abortSignal) deny(FOREMAN_AGENT_FILE_COPY.admission)
    signal.throwIfAborted()
    if (ctx.agent.id !== FOREMAN_AGENT_ID || ctx.agent.config.kind !== 'foreman' || !ctx.agent.config.enabled || !ctx.runId || !ctx.sessionId) deny(FOREMAN_AGENT_FILE_COPY.admission)
    const config = await ports.config()
    if (!config || config.kind !== 'foreman' || config.enabled === false || !foremanAgentFileGrantOn(config.tools, grant)) deny(FOREMAN_AGENT_FILE_COPY.off)
    const run = await ports.run()
    if (!run || run.id !== ctx.runId || run.agentId !== FOREMAN_AGENT_ID || run.sessionId !== ctx.sessionId || run.status !== 'running') deny(FOREMAN_AGENT_FILE_COPY.admission)
    signal.throwIfAborted()
}

async function coworker(ports: ForemanAgentFilePorts, name: string) {
    return resolveCoworkerTarget(name, await ports.coworkers())
}

function fail(error: unknown): never {
    if (error instanceof ForemanAgentFileError) throw new Error(error.message)
    if (error instanceof Error && (Object.values(FOREMAN_AGENT_FILE_COPY) as readonly string[]).includes(error.message)) throw new Error(error.message)
    throw new Error(FOREMAN_AGENT_FILE_COPY.unavailable)
}

export function foremanAgentFileTools(ctx: RunContext, ports: ForemanAgentFilePorts = productionPorts(ctx)): ToolSet {
    if (ctx.agent.id !== FOREMAN_AGENT_ID || ctx.agent.config.kind !== 'foreman') return {}
    const tools: ToolSet = {}
    const signal = () => {
        if (!ctx.abortSignal) deny(FOREMAN_AGENT_FILE_COPY.admission)
        return ctx.abortSignal
    }
    // A grant id missing from the desktop enum is stripped when config is loaded, so absence stays off.
    if (foremanAgentFileGrantOn(ctx.agent.config.tools, 'foremanAgentFilesRead')) {
        tools.agent_files_read = tool({
            description: `Read one visible UTF-8 file from another coworker in this workspace. ${FOREMAN_AGENT_FILE_COPY.historical} A refusal is an error.`,
            inputSchema: foremanAgentFileReadInput,
            execute: async ({ coworker: target, path }) => {
                try {
                    await admitted(ctx, ports, 'foremanAgentFilesRead', signal())
                    return await ports.readText(await coworker(ports, target), path, signal())
                } catch (error) { return fail(error) }
            },
        })
        tools.agent_files_list = tool({
            description: `List visible files and folders for another coworker in this workspace. ${FOREMAN_AGENT_FILE_COPY.historical} Hidden and internal stores are omitted. A refusal is an error.`,
            inputSchema: foremanAgentFileListInput,
            execute: async ({ coworker: target, path }) => {
                try {
                    await admitted(ctx, ports, 'foremanAgentFilesRead', signal())
                    const listed = await ports.list(await coworker(ports, target), path, signal())
                    const names = listed.entries.map(entry => entry.name + (entry.directory ? '/' : ''))
                    if (listed.truncated) names.push('(listing limit reached)')
                    return names.join('\n') || '(empty)'
                } catch (error) { return fail(error) }
            },
        })
        tools.agent_files_search = tool({
            description: `Search visible text files of another coworker in this workspace for a literal phrase. ${FOREMAN_AGENT_FILE_COPY.historical} Non-text files are skipped. A refusal is an error.`,
            inputSchema: foremanAgentFileSearchInput,
            execute: async ({ coworker: target, path, pattern, maxResults }) => {
                try {
                    await admitted(ctx, ports, 'foremanAgentFilesRead', signal())
                    return await ports.search(await coworker(ports, target), path, pattern, maxResults, signal())
                } catch (error) { return fail(error) }
            },
        })
    }
    if (foremanAgentFileGrantOn(ctx.agent.config.tools, 'foremanAgentFilesWrite')) {
        tools.agent_files_write = tool({
            description: 'Create a visible .txt or .md file for another coworker in this workspace. An existing path is not overwritten. Non-text is refused and nothing is saved. An uncertain save is not retried.',
            inputSchema: foremanAgentFileWriteInput,
            execute: async ({ coworker: target, path, content }, options) => {
                try {
                    const active = signal()
                    await admitted(ctx, ports, 'foremanAgentFilesWrite', active)
                    if (!options.toolCallId) deny(FOREMAN_AGENT_FILE_COPY.admission)
                    const id = await coworker(ports, target)
                    const arguments_ = foremanAgentFileWriteArguments(path, content)
                    const result = await ports.publish({ engineAgentId: id, sessionId: ctx.sessionId, runId: ctx.runId!, toolCallId: options.toolCallId, tool: 'fs_write', arguments: arguments_ }, active)
                    return JSON.stringify(result)
                } catch (error) { return fail(error) }
            },
        })
        tools.agent_files_edit = tool({
            description: 'Replace text in a visible .txt or .md file of another coworker in this workspace. Non-text is refused and nothing is saved. An uncertain save is not retried.',
            inputSchema: foremanAgentFileEditInput,
            execute: async ({ coworker: target, path, oldString, newString, replaceAll }, options) => {
                try {
                    const active = signal()
                    await admitted(ctx, ports, 'foremanAgentFilesWrite', active)
                    if (!options.toolCallId) deny(FOREMAN_AGENT_FILE_COPY.admission)
                    const id = await coworker(ports, target)
                    const arguments_ = foremanAgentFileEditArguments(path, oldString, newString, replaceAll)
                    const result = await ports.publish({ engineAgentId: id, sessionId: ctx.sessionId, runId: ctx.runId!, toolCallId: options.toolCallId, tool: 'fs_edit', arguments: arguments_ }, active)
                    return JSON.stringify(result)
                } catch (error) { return fail(error) }
            },
        })
    }
    return tools
}
