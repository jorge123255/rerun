import { createClient } from '@libsql/client'
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { captureScopedPrivateDatabase } from './scoped.ts'

let directory = '', file = ''
beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(),'private-capture-worker-')))
    const data = join(directory,'agents','engine-a','data')
    await mkdir(data,{ recursive: true }); file = join(data,'agent.db')
    const client = createClient({ url: `file:${file}` })
    await client.execute('CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT)')
    await client.execute("INSERT INTO notes VALUES (1,'Canonical private content')")
    client.close()
})
afterEach(async () => { await rm(directory,{ recursive: true,force: true }) })
const capture = (extra: Partial<Parameters<typeof captureScopedPrivateDatabase>[0]> = {}) => captureScopedPrivateDatabase({ engineRoot: directory,engineAgentId: 'engine-a',workspaceId: 7,agentId: 'local-a',requestId: 'capture',assertCurrent: async () => {},...extra })

test('the real read-only worker returns only logical private rows and leaves raw files unchanged', async () => {
    await writeFile(join(directory,'shared.db'),'SHARED_SENTINEL')
    await writeFile(join(directory,'agents','engine-a','data','system.db'),'SYSTEM_SENTINEL')
    const before = await readFile(file), result = await capture()
    expect(result.tables[0]!.rows).toEqual([{ id: 1,title: 'Canonical private content' }])
    expect(JSON.stringify(result)).not.toMatch(/SHARED_SENTINEL|SYSTEM_SENTINEL|SQLite format/)
    expect(await readFile(file)).toEqual(before)
    expect((await capture({ requestId: 'new-read-after-restart' })).digest).toBe(result.digest)
})

test('missing storage is an error and never creates an empty private database', async () => {
    await rm(file)
    await expect(capture()).rejects.toThrow()
    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
})

test.each(['hard','symbolic'] as const)('refuses a %s alias before spawning a reader', async kind => {
    const original = join(directory,'original.db')
    const bytes = await readFile(file); await writeFile(original,bytes); await rm(file)
    if (kind === 'hard') await link(original,file); else await symlink(original,file)
    const onWorkerSpawn = vi.fn()
    await expect(capture({ onWorkerSpawn })).rejects.toThrow()
    expect(onWorkerSpawn).not.toHaveBeenCalled()
})

test('Stop after spawn kills/reaps the exact read before rejection; no result is published', async () => {
    const controller = new AbortController(), onWorkerSpawn = vi.fn(() => queueMicrotask(() => controller.abort()))
    await expect(capture({ signal: controller.signal,onWorkerSpawn })).rejects.toThrow(/cancel/i)
    expect(onWorkerSpawn).toHaveBeenCalledTimes(1)
    expect((await capture({ requestId: 'explicit-new-read' })).tables).toHaveLength(1)
})

test('an owner revision lost during the read rejects the late worker response', async () => {
    let checks = 0
    await expect(capture({ assertCurrent: async () => { if (++checks >= 3) throw new Error('Coworker replaced') } })).rejects.toThrow('Coworker replaced')
})
