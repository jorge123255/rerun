import { mkdtempSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { RunContext } from '../runtime/context.js'
import { prepareSkillHelperFixture } from './skill-publication.test-support.js'

const configs = vi.hoisted(() => new Map<string, { enabled?: boolean; tools?: { shared?: boolean; desktopToolGrants?: Record<string, boolean> } }>())
vi.mock('../agents/loader.js', () => ({ readAgentConfig: async (id: string) => configs.get(id) ?? null }))

const created = mkdtempSync(join(tmpdir(), 'rerun-shared-tools-'))
process.env.RERUN_DATA_DIR = created
process.env.RERUN_DESKTOP_APP = '1'

const { desktopSharedFileTools } = await import('./shared-file-tools.js')
const { importSharedText, resolveEngineSharedDirectory } = await import('./shared-workspace-files.js')

const granted = { enabled: true, tools: { shared: true, desktopToolGrants: { sharedFilesRead: true } } }
const call = { toolCallId: 'shared-test', messages: [] }
const context = (id: string, config = configs.get(id), signal?: AbortSignal) => ({ agent: { id, config }, abortSignal: signal }) as RunContext

let helper: Awaited<ReturnType<typeof prepareSkillHelperFixture>>
const priorHelper = process.env.RERUN_DESKTOP_RENAME_HELPER
beforeAll(async () => { helper = await prepareSkillHelperFixture(); process.env.RERUN_DESKTOP_RENAME_HELPER = helper.path })
afterAll(async () => {
    if (priorHelper === undefined) delete process.env.RERUN_DESKTOP_RENAME_HELPER; else process.env.RERUN_DESKTOP_RENAME_HELPER = priorHelper
    await helper?.close()
    await rm(created, { recursive: true, force: true })
})

it('registers only shared_read and shared_list, and both coworkers read the same imported file', async () => {
    configs.set('alpha', structuredClone(granted))
    configs.set('bravo', structuredClone(granted))
    const engine = await realpath(created)
    const shared = await resolveEngineSharedDirectory(engine)
    await importSharedText(shared, '', 'note.txt', new TextEncoder().encode('from both'))
    const alpha = desktopSharedFileTools(context('alpha'))
    const bravo = desktopSharedFileTools(context('bravo'))
    expect(Object.keys(alpha).sort()).toEqual(['shared_list', 'shared_read'])
    expect(Object.keys(bravo).sort()).toEqual(['shared_list', 'shared_read'])
    expect('shared_write' in alpha).toBe(false)
    const read = async (tools: typeof alpha) => tools.shared_read!.execute!({ path: 'note.txt', offset: 0, root: '/tmp', engineId: 'no', scope: 'private' }, call)
    const receipt = `[Shared file receipt: ${JSON.stringify({ path: 'note.txt', expectedBytes: 9, expectedSha256: createHash('sha256').update('from both').digest('hex') })}]\n\nfrom both`
    expect(await read(alpha)).toBe(receipt)
    expect(await read(bravo)).toBe(receipt)
    expect(await alpha.shared_list!.execute!({ path: '.', root: '/tmp' }, call)).toContain('note.txt')
    const privateDir = join(engine, 'agents', 'alpha', 'workspace')
    await mkdir(privateDir, { recursive: true })
    await writeFile(join(privateDir, 'secret.txt'), 'private-only')
    await expect(alpha.shared_read!.execute!({ path: '../agents/alpha/workspace/secret.txt', offset: 0 }, call)).rejects.toThrow('outside the shared folder')
    expect(String(await alpha.shared_list!.execute!({ path: '.' }, call))).not.toContain('secret')
})

it('omits the tools without the grant and rechecks it before returning text', async () => {
    expect(Object.keys(desktopSharedFileTools(context('alpha', { enabled: true, tools: { shared: true } })))).toEqual([])
    expect(Object.keys(desktopSharedFileTools(context('alpha', { enabled: false, tools: granted.tools })))).toEqual([])
    const config = structuredClone(granted)
    configs.set('alpha', config)
    const tools = desktopSharedFileTools(context('alpha', config))
    config.tools!.desktopToolGrants!.sharedFilesRead = false
    await expect(tools.shared_read!.execute!({ path: 'note.txt', offset: 0 }, call)).rejects.toThrow('turned off')
    await expect(tools.shared_read!.execute!({ path: 'note.txt', offset: 0 }, { ...call, abortSignal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
})

it('uses the live run cancellation even when the tool call does not provide a signal', async () => {
    const config = structuredClone(granted)
    configs.set('cancelled', config)
    const controller = new AbortController()
    const tools = desktopSharedFileTools(context('cancelled', config, controller.signal))
    controller.abort()
    await expect(tools.shared_read!.execute!({ path: 'note.txt', offset: 0 }, call)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(tools.shared_list!.execute!({ path: '.' }, call)).rejects.toMatchObject({ name: 'AbortError' })
})
