import type { Client } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from './database'
import { foremanWorkspaceReadRuntimeMatches, readForemanWorkspaceSnapshot } from './foreman-workspace-reads'
import { createDesktopAgent } from './store'
import { readDesktopBoardState } from './spaces'

let root = ''
let db: Client | undefined

afterEach(async () => {
    if (root) await closeDesktopDatabase(root).catch(() => {})
    if (root) await rm(root, { recursive: true, force: true })
    root = ''
    db = undefined
})

it('refuses a workspace grant unless the runtime id and launch nonce still match', async () => {
    const runtime = { workspaceId: 1, launchNonce: 'nonce-a', dataRoot: '/unused' }
    expect(await foremanWorkspaceReadRuntimeMatches('1', async () => { throw new Error('missing') })).toBe(false)
    expect(await foremanWorkspaceReadRuntimeMatches('2', async () => runtime)).toBe(false)
    let nonceReads = 0
    expect(await foremanWorkspaceReadRuntimeMatches('1', async () => { nonceReads += 1; return { ...runtime, launchNonce: nonceReads === 1 ? 'nonce-a' : 'nonce-b' } })).toBe(false)
    let reads = 0
    expect(await foremanWorkspaceReadRuntimeMatches('1', async () => { reads += 1; return reads === 1 ? runtime : { ...runtime, workspaceId: 9 } })).toBe(false)
    expect(await foremanWorkspaceReadRuntimeMatches('1', async () => runtime)).toBe(true)
})

it('reads boxes and coworkers through the board snapshot and the same rows after reopen', async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-foreman-workspace-reads-'))
    db = await openDesktopDatabase(root)
    const board = await readDesktopBoardState(db)
    const agent = await createDesktopAgent(db, { engineAgentId: 'engine-ada', name: 'Ada', description: 'Writes', spaceId: board.spaces[0]!.id })
    const runtime = { workspaceId: 4, launchNonce: 'nonce-a', dataRoot: root }
    const open = async () => db!
    const denied = await readForemanWorkspaceSnapshot('1', { runtime: async () => runtime, open })
    expect(denied).toEqual({ kind: 'other-workspace' })
    const first = await readForemanWorkspaceSnapshot('4', { runtime: async () => runtime, open })
    expect(first).toMatchObject({
        kind: 'ready',
        workspaceId: '4',
        catalogWorkspaceId: '1',
        boxes: [{ id: board.spaces[0]!.id, name: board.spaces[0]!.name }],
        foreignIds: [],
    })
    if (first.kind !== 'ready') throw new Error('expected a ready snapshot')
    expect(first.roster).toEqual([{ id: agent.id, workspaceId: '4', name: 'Ada', handle: null, description: 'Writes', spaceId: board.spaces[0]!.id, enabled: true, deleting: false }])
    expect(JSON.stringify(first)).not.toContain('engine-ada')
    await closeDesktopDatabase(root)
    db = await openDesktopDatabase(root)
    const reopened = await readForemanWorkspaceSnapshot('4', { runtime: async () => runtime, open: async () => db! })
    expect(reopened).toEqual(first)
})
