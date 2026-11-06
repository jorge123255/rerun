import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@libsql/client'
import { expect, test, vi } from 'vitest'
import { createSharedMutationPublisher } from './publisher'
import { createSharedReceiptSqliteStore, DESKTOP_SHARED_FILE_MUTATION_SCHEMA } from './store'

test('a claimed file DB receipt survives lost ACK and reopen without redelivering the mutation', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(),'rerun-shared-reopen-')))
    const sharedRoot = join(directory,'workspaces','1','engine','shared')
    await mkdir(sharedRoot,{ recursive: true })
    const url = `file:${join(directory,'app.db')}`
    let db = createClient({ url })
    try {
        await db.executeMultiple(`PRAGMA foreign_keys=ON; CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); INSERT INTO desktop_agents VALUES('owner'); ${DESKTOP_SHARED_FILE_MUTATION_SCHEMA};`)
        const authority = { current: async () => ({ workspaceId: 1,owner: 'owner',sharedRoot,dataRoot: directory,launchNonce: 'launch',state: 'active' as const,writeGrant: true }) }
        const create = vi.fn(async () => ({ status: 'saved' as const,path: 'note.txt',message: 'Saved',committed: true }))
        const io = { create,edit: vi.fn() }
        const firstStore = createSharedReceiptSqliteStore(db)
        vi.spyOn(firstStore,'finish').mockResolvedValue(false)
        const call = { workspaceId: 1,engineAgentId: 'engine',sessionId: 'session',runId: 'run',toolCallId: 'call',tool: 'shared_write' as const,arguments: { path: 'note.txt',content: 'hello' } }
        expect(await createSharedMutationPublisher(firstStore,authority,io)(call,new AbortController().signal)).toMatchObject({ status: 'uncertain' })
        db.close(); db = createClient({ url })
        const reopened = createSharedMutationPublisher(createSharedReceiptSqliteStore(db),authority,io)
        expect(await reopened(call,new AbortController().signal)).toMatchObject({ status: 'uncertain' })
        expect(create).toHaveBeenCalledTimes(1)
        await expect(reopened({ ...call,arguments: { ...call.arguments,content: 'changed' } },new AbortController().signal)).rejects.toThrow('identity was reused')
        expect(create).toHaveBeenCalledTimes(1)
    } finally { db.close(); await rm(directory,{ recursive: true,force: true }) }
})
