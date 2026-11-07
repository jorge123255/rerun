import { expect, test } from 'vitest'
import { FOREMAN_AGENT_FILE_COPY, foremanAgentFileGrantOn, foremanAgentVisiblePath } from './contract.js'
import { foremanAgentFileEditArguments, foremanAgentFileWriteArguments } from './publish.js'
import { resolveCoworkerTarget } from './policy.js'
import { foremanAgentFileTools, type ForemanAgentFilePorts } from './tools.js'
import type { RunContext } from '../../runtime/context.js'

const rows = [
    { id: 'notes', name: 'Notes' },
    { id: 'notes-2', name: 'Notes' },
    { id: 'solo', name: 'Solo' },
    { id: 'helper', name: 'Helper delegate' },
    { id: 'foreman', name: 'Foreman' },
]

function context(grants: Record<string, boolean> = {}, id = 'foreman'): RunContext {
    return {
        agent: { id, config: { kind: id === 'foreman' ? 'foreman' : 'user', enabled: true, tools: { desktopToolGrants: grants } } },
        sessionId: 'session',
        runId: 'run',
        abortSignal: new AbortController().signal,
    } as unknown as RunContext
}

function ports(over: Partial<ForemanAgentFilePorts> = {}): ForemanAgentFilePorts & { published: unknown[]; reads: number } {
    const published: unknown[] = []
    const state = {
        published,
        reads: 0,
        config: async () => ({ kind: 'foreman', enabled: true, tools: { desktopToolGrants: { foremanAgentFilesRead: true, foremanAgentFilesWrite: true } } }),
        run: async () => ({ id: 'run', agentId: 'foreman', sessionId: 'session', status: 'running' }),
        coworkers: async () => rows,
        readText: async () => { state.reads += 1; return 'visible note' },
        list: async () => ({ entries: [{ name: 'note.md', directory: false }], truncated: false }),
        search: async () => 'note.md:1:visible note',
        publish: async (body: unknown) => { published.push(body); return { status: 'saved' as const, path: 'note.md', message: 'saved' } },
        ...over,
    }
    return state
}

const call = { toolCallId: 'call-1', messages: [] }

test('read and write grants are separate and default off', () => {
    expect(foremanAgentFileGrantOn(undefined, 'foremanAgentFilesRead')).toBe(false)
    expect(foremanAgentFileGrantOn({ desktopToolGrants: { foremanAgentFilesRead: false } }, 'foremanAgentFilesRead')).toBe(false)
    expect(Object.keys(foremanAgentFileTools(context()))).toEqual([])
    expect(Object.keys(foremanAgentFileTools(context({ foremanAgentFilesRead: true })))).toEqual(['agent_files_read', 'agent_files_list', 'agent_files_search'])
    expect(Object.keys(foremanAgentFileTools(context({ foremanAgentFilesWrite: true })))).toEqual(['agent_files_write', 'agent_files_edit'])
    expect(Object.keys(foremanAgentFileTools(context({ foremanAgentFilesRead: true }, 'agent-7')))).toEqual([])
    const managed = context({ foremanAgentFilesRead: true, foremanAgentFilesWrite: true })
    expect(Object.keys(foremanAgentFileTools({ ...managed, agent: { ...managed.agent, id: 'agent-7' } }))).toEqual([])
    expect(Object.keys(foremanAgentFileTools({ ...managed, agent: { ...managed.agent, config: { ...managed.agent.config, kind: 'user' } } }))).toEqual([])
})

test('descriptions disclose historical workspace documents', () => {
    const tools = foremanAgentFileTools(context({ foremanAgentFilesRead: true, foremanAgentFilesWrite: true }))
    expect(tools.agent_files_read?.description).toContain(FOREMAN_AGENT_FILE_COPY.historical)
    expect(tools.agent_files_write?.description).toContain('nothing is saved')
    expect(tools.agent_files_write?.description?.toLowerCase()).not.toContain('api key')
})

test('untrusted targets and hidden or internal paths are refusals', () => {
    expect(resolveCoworkerTarget('solo', rows)).toBe('solo')
    expect(() => resolveCoworkerTarget('Notes', rows)).toThrow(FOREMAN_AGENT_FILE_COPY.ambiguous)
    expect(() => resolveCoworkerTarget('missing', rows)).toThrow(FOREMAN_AGENT_FILE_COPY.workspace)
    expect(() => resolveCoworkerTarget('helper', rows)).toThrow(FOREMAN_AGENT_FILE_COPY.workspace)
    expect(() => resolveCoworkerTarget('Helper delegate', rows)).toThrow(FOREMAN_AGENT_FILE_COPY.workspace)
    expect(() => resolveCoworkerTarget('foreman', rows)).toThrow(FOREMAN_AGENT_FILE_COPY.workspace)
    expect(() => resolveCoworkerTarget('../solo', rows)).toThrow(FOREMAN_AGENT_FILE_COPY.workspace)
    expect(foremanAgentVisiblePath('notes/today.md')).toBe('notes/today.md')
    for (const path of ['../today.md', '/etc/passwd', '.secret.md', '.rerun/pages/cache.txt', 'notes/.rerun-skill.md', 'notes/.rerun-backup.md', 'node_modules/pkg.md']) {
        expect(() => foremanAgentVisiblePath(path)).toThrow(FOREMAN_AGENT_FILE_COPY.path)
    }
    expect(() => foremanAgentVisiblePath('picture.png', 'text')).toThrow(FOREMAN_AGENT_FILE_COPY.nonTextWrite)
})

test('a denied coworker is an error and does not read', async () => {
    const used = ports()
    const tools = foremanAgentFileTools(context({ foremanAgentFilesRead: true }), used)
    await expect(tools.agent_files_read!.execute!({ coworker: 'missing', path: 'note.md' }, call)).rejects.toThrow(FOREMAN_AGENT_FILE_COPY.workspace)
    expect(used.reads).toBe(0)
    await expect(tools.agent_files_list!.execute!({ coworker: 'Notes', path: '.' }, call)).rejects.toThrow(FOREMAN_AGENT_FILE_COPY.ambiguous)
    expect(used.reads).toBe(0)
})

test('a revoked grant or stopped run does not read or publish', async () => {
    const revoked = ports({ config: async () => ({ kind: 'foreman', enabled: true, tools: { desktopToolGrants: {} } }) })
    const tools = foremanAgentFileTools(context({ foremanAgentFilesRead: true, foremanAgentFilesWrite: true }), revoked)
    await expect(tools.agent_files_read!.execute!({ coworker: 'Solo', path: 'note.md' }, call)).rejects.toThrow(FOREMAN_AGENT_FILE_COPY.off)
    await expect(tools.agent_files_write!.execute!({ coworker: 'Solo', path: 'note.md', content: 'hello' }, call)).rejects.toThrow(FOREMAN_AGENT_FILE_COPY.off)
    expect(revoked.reads).toBe(0)
    expect(revoked.published).toEqual([])
    const stopped = ports({ run: async () => ({ id: 'run', agentId: 'foreman', sessionId: 'session', status: 'cancelled' }) })
    const live = foremanAgentFileTools(context({ foremanAgentFilesRead: true }), stopped)
    await expect(live.agent_files_search!.execute!({ coworker: 'Solo', pattern: 'hello' }, call)).rejects.toThrow(FOREMAN_AGENT_FILE_COPY.admission)
})

test('non-text writes are refused before publication and an unknown save is not retried', async () => {
    expect(() => foremanAgentFileWriteArguments('picture.png', 'hello')).toThrow(FOREMAN_AGENT_FILE_COPY.nonTextWrite)
    expect(() => foremanAgentFileWriteArguments('note.md', 'bad\u0000text')).toThrow(FOREMAN_AGENT_FILE_COPY.nonTextWrite)
    expect(() => foremanAgentFileEditArguments('.secret.md', 'old', 'new')).toThrow(FOREMAN_AGENT_FILE_COPY.path)
    const used = ports()
    const tools = foremanAgentFileTools(context({ foremanAgentFilesWrite: true }), used)
    await expect(tools.agent_files_write!.execute!({ coworker: 'Solo', path: 'picture.png', content: 'hello' }, call)).rejects.toThrow(FOREMAN_AGENT_FILE_COPY.nonTextWrite)
    expect(used.published).toEqual([])
    used.publish = async () => { used.published.push('attempt'); throw new Error(FOREMAN_AGENT_FILE_COPY.unknown) }
    await expect(tools.agent_files_write!.execute!({ coworker: 'Solo', path: 'note.md', content: 'hello' }, call)).rejects.toThrow(FOREMAN_AGENT_FILE_COPY.unknown)
    expect(used.published).toEqual(['attempt'])
})

test('a publication body identifies the target and call without a secret', async () => {
    const used = ports()
    const tools = foremanAgentFileTools(context({ foremanAgentFilesWrite: true }), used)
    const saved = await tools.agent_files_write!.execute!({ coworker: 'Solo', path: 'note.md', content: 'hello' }, call)
    expect(saved).toContain('saved')
    expect(used.published).toEqual([{
        engineAgentId: 'solo', sessionId: 'session', runId: 'run', toolCallId: 'call-1', tool: 'fs_write', arguments: { path: 'note.md', content: 'hello' },
    }])
    expect(JSON.stringify(used.published)).not.toMatch(/bearer|apiKey|authorization/i)
    const edited = await tools.agent_files_edit!.execute!({ coworker: 'solo', path: 'note.md', oldString: 'hello', newString: 'goodbye' }, { ...call, toolCallId: 'call-2' })
    expect(edited).toContain('saved')
    expect(used.published[1]).toMatchObject({ engineAgentId: 'solo', tool: 'fs_edit', toolCallId: 'call-2' })
})

test('resolved unknown/refused publications never become successful tool output', async () => {
    const used = ports({ publish: async () => ({ status: 'unknown', message: 'No acknowledgement.' }) })
    const tools = foremanAgentFileTools(context({ foremanAgentFilesWrite: true }), used)
    await expect(tools.agent_files_write!.execute!({ coworker: 'solo', path: 'note.md', content: 'hello' }, call)).rejects.toThrow(FOREMAN_AGENT_FILE_COPY.unknown)
    used.publish = async () => ({ status: 'refused', message: FOREMAN_AGENT_FILE_COPY.nonTextWrite })
    await expect(tools.agent_files_write!.execute!({ coworker: 'solo', path: 'note.md', content: 'hello' }, call)).rejects.toThrow(FOREMAN_AGENT_FILE_COPY.nonTextWrite)
})

test('revocation while a read resolves discards the result', async () => {
    let granted = true
    const used = ports({ config: async () => ({ kind: 'foreman', enabled: true, tools: { desktopToolGrants: { foremanAgentFilesRead: granted } } }), readText: async () => { granted = false; return 'discarded' } })
    const tools = foremanAgentFileTools(context({ foremanAgentFilesRead: true }), used)
    await expect(tools.agent_files_read!.execute!({ coworker: 'solo', path: 'note.md' }, call)).rejects.toThrow(FOREMAN_AGENT_FILE_COPY.off)
})
