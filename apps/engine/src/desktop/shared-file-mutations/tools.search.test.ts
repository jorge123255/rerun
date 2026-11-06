import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { RunContext } from '../../runtime/context.js'

const state = vi.hoisted(() => ({ engineRoot: '', config: { enabled: true, tools: { shared: true, desktopToolGrants: { sharedFilesRead: true } } } }))
vi.mock('../../config/paths.js', async original => ({ ...await original<typeof import('../../config/paths.js')>(), dataDir: () => state.engineRoot }))
vi.mock('../../agents/loader.js', () => ({ readAgentConfig: async () => state.config }))
vi.mock('../agent-lifecycle.js', () => ({ beginDesktopAgentWork: () => () => {}, assertDesktopAgentNotDeleted: () => {} }))
vi.mock('./regex.js', () => ({ sharedRegexLines: async (lines: string[], pattern: string, max: number) => {
    const expression = new RegExp(pattern)
    return lines.flatMap((line, index) => expression.test(line) ? [index] : []).slice(0, max)
} }))
import { bindSharedMutationWorkspace, desktopSharedMutationTools } from './tools.js'

let shared = ''
beforeEach(async () => {
    state.engineRoot = await realpath(await mkdtemp(join(tmpdir(), 'rerun-shared-search-tool-')))
    shared = join(state.engineRoot, 'shared')
    await mkdir(shared)
    bindSharedMutationWorkspace(async () => ({ workspaceId: 2, assertCurrent: async signal => { signal.throwIfAborted() } }))
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Shared search must remain observational and local') }))
})
afterEach(async () => { bindSharedMutationWorkspace(null); await rm(state.engineRoot, { recursive: true, force: true }); vi.unstubAllGlobals() })

async function search(pattern: string) {
    const context = { agent: { id: 'reader', config: state.config }, sessionId: 'session', runId: 'run', abortSignal: new AbortController().signal } as RunContext
    const tool = desktopSharedMutationTools(context).shared_search!
    return await tool.execute!({ pattern, maxResults: 20 }, { messages: [], toolCallId: 'search-call', abortSignal: new AbortController().signal })
}

test('actual shared_search distinguishes a complete negative from a negative at the real filesystem scan bound', async () => {
    await writeFile(join(shared, 'note-000.txt'), 'ordinary text')
    expect(await search('hidden-marker')).toBe('No matches.')
    await Promise.all(Array.from({ length: 200 }, (_, index) => writeFile(join(shared, `note-${String(index + 1).padStart(3, '0')}.txt`), index === 199 ? 'hidden-marker' : 'ordinary text')))
    const result = await search('hidden-marker')
    expect(result).not.toBe('No matches.')
    expect(result).toContain('search incomplete')
    expect(result).toContain('0 matches shown')
    expect(fetch).not.toHaveBeenCalled()
}, 30_000)
