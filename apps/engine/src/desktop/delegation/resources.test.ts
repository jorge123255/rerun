import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { prepareSkillHelperFixture } from '../skill-publication.test-support.js'
import type { Allocation } from './protocol.js'

const paths = vi.hoisted(() => ({ directory: '' }))
vi.mock('../../config/paths.js', () => ({ agentsDir: () => paths.directory, agentDir: (id: string) => `${paths.directory}/${id}` }))
import { allocateDelegationDirectory, assertDelegationManifest, cleanupDelegationDirectory, initializeDelegationDirectory, inspectDelegationDirectory } from './resources.js'

let folder: string
let helper: Awaited<ReturnType<typeof prepareSkillHelperFixture>>
const previousHelper = process.env.RERUN_DESKTOP_RENAME_HELPER
beforeAll(async () => { helper = await prepareSkillHelperFixture(); process.env.RERUN_DESKTOP_RENAME_HELPER = helper.path }, 30_000)
beforeEach(async () => { folder = await realpath(await mkdtemp(join(tmpdir(), 'rerun-delegation-resources-'))); paths.directory = join(folder, 'agents'); await mkdir(paths.directory) })
afterEach(async () => { await rm(folder, { recursive: true, force: true }) })
afterAll(async () => { if (previousHelper === undefined) delete process.env.RERUN_DESKTOP_RENAME_HELPER; else process.env.RERUN_DESKTOP_RENAME_HELPER = previousHelper; await helper.close() })
const signal = () => new AbortController().signal
const current = async () => {}
function allocation(): Allocation {
    return { token: randomUUID(), identity: randomUUID(), revision: randomUUID(), epoch: 'fixture-epoch', source: { parentAgentId: 'original-coworker', parentSessionId: 'original-chat', parentRunId: 'original-run', toolCallId: 'call' }, taskId: randomUUID(), childAgentId: `delegate-${randomUUID()}`, rootIdentity: null, sessionId: null, runId: null, phase: 'reserved', manifest: null }
}
async function initialized() {
    const row = allocation()
    row.rootIdentity = await allocateDelegationDirectory(row, current); row.manifest = []
    await initializeDelegationDirectory(row, { name: 'Isolated task' }, current, async manifest => { row.manifest = structuredClone(manifest) })
    row.phase = 'drained'; row.cleanupStarted = true
    return row
}
const original = (row: Allocation) => join(paths.directory, row.childAgentId)
const retired = (row: Allocation) => join(paths.directory, `.delegation-retired-${row.token}`)

test('records every exclusive creation and cleans only that private directory', async () => {
    const row = await initialized()
    expect(row.manifest?.map(entry => entry.path)).toEqual(['config.json', 'data', 'memory', 'skills', 'SOUL.md', 'workspace'].sort((a, b) => a.localeCompare(b)))
    const sibling = join(paths.directory, 'original-coworker'); await mkdir(sibling); await writeFile(join(sibling, 'SOUL.md'), 'keep original instructions')
    await cleanupDelegationDirectory(row, signal())
    expect(await readdir(paths.directory)).toEqual(['original-coworker'])
    expect(await readFile(join(sibling, 'SOUL.md'), 'utf8')).toBe('keep original instructions')
    await expect(cleanupDelegationDirectory(row, signal())).resolves.toBeUndefined()
})

test('restart resumes exact retired files after partial deletion, preserving a new original name', async () => {
    const row = await initialized()
    await rename(original(row), retired(row))
    await unlink(join(retired(row), 'config.json')); await rmdir(join(retired(row), 'workspace'))
    await mkdir(original(row)); await writeFile(join(original(row), 'user.txt'), 'new unrelated folder')
    await cleanupDelegationDirectory(structuredClone(row), signal())
    await expect(lstat(retired(row))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(original(row), 'user.txt'), 'utf8')).toBe('new unrelated folder')
})

test('changed files and injected entries are preserved after an interrupted cleanup', async () => {
    const row = await initialized()
    await rename(original(row), retired(row)); await unlink(join(retired(row), 'config.json'))
    await writeFile(join(retired(row), 'config.json'), 'replacement')
    await expect(cleanupDelegationDirectory(row, signal())).rejects.toThrow('preserved')
    expect(await readFile(join(retired(row), 'config.json'), 'utf8')).toBe('replacement')
    await writeFile(join(retired(row), 'user.txt'), 'not a runtime output')
    await expect(cleanupDelegationDirectory(row, signal())).rejects.toThrow('preserved')
    expect(await readFile(join(retired(row), 'user.txt'), 'utf8')).toBe('not a runtime output')
})

test('a replaced root and missing files before retirement are never treated as completed cleanup', async () => {
    const row = await initialized()
    await unlink(join(original(row), 'config.json'))
    await expect(cleanupDelegationDirectory(row, signal())).rejects.toThrow('preserved')
    await rename(original(row), join(paths.directory, 'saved-original'))
    await mkdir(original(row)); await writeFile(join(original(row), 'config.json'), 'keep replacement')
    await expect(cleanupDelegationDirectory(row, signal())).rejects.toThrow('preserved')
    expect(await readFile(join(original(row), 'config.json'), 'utf8')).toBe('keep replacement')
})

test('a create acknowledgement failure cannot turn later unknown files into owned runtime files', async () => {
    const row = allocation()
    row.rootIdentity = await allocateDelegationDirectory(row, current); row.manifest = []
    await expect(initializeDelegationDirectory(row, {}, current, async () => { throw new Error('lost receipt') })).rejects.toThrow('lost receipt')
    const actual = await inspectDelegationDirectory(row)
    expect(actual.map(entry => entry.path)).toEqual(['workspace'])
    expect(() => assertDelegationManifest(row, actual, { runtimeFiles: false })).toThrow('preserved')
    expect(() => assertDelegationManifest({ ...row, manifest: null }, actual, { runtimeFiles: true })).toThrow('preserved')
})

test('admits only runtime DB changes and transient journal removal after the run drains', async () => {
    const row = await initialized()
    const db = join(original(row), 'data/system.db'); const wal = `${db}-wal`
    await writeFile(db, 'db version 1'); await writeFile(wal, 'transient')
    const started = await inspectDelegationDirectory(row)
    expect(() => assertDelegationManifest(row, started, { runtimeFiles: true })).not.toThrow()
    row.manifest = started
    await writeFile(db, 'db version 2'); await unlink(wal)
    const drained = await inspectDelegationDirectory(row)
    expect(() => assertDelegationManifest(row, drained, { runtimeFiles: true })).not.toThrow()
    await writeFile(join(original(row), 'SOUL.md'), 'unexpected changed instructions')
    const changed = await inspectDelegationDirectory(row)
    expect(() => assertDelegationManifest(row, changed, { runtimeFiles: true })).toThrow('preserved')
    expect(() => assertDelegationManifest(row, [...drained, { ...drained[0]!, path: '../../other-agent/config.json' }], { runtimeFiles: true })).toThrow('preserved')
})

test('inspection refuses symlinked private children without reading their target', async () => {
    const row = await initialized(), destination = join(folder, 'unrelated')
    await mkdir(destination); await writeFile(join(destination, 'system.db'), 'secret sibling bytes')
    await rmdir(join(original(row), 'data')); await symlink(destination, join(original(row), 'data'))
    await expect(inspectDelegationDirectory(row)).rejects.toThrow('preserved')
    expect(await readFile(join(destination, 'system.db'), 'utf8')).toBe('secret sibling bytes')
})
