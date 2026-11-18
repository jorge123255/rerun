import { createClient } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { DesktopRuntime } from '../runtime'
import { readDesktopRuntime } from '../runtime'
import { setDesktopWorkspaceFrozen } from '../workspace-admission'
import { DESKTOP_FOREMAN_CHAT_SCHEMA } from './chat-store'
import { authorizeForemanSharedVault } from './shared-vault'

vi.mock('../runtime', async original => ({...await original<typeof import('../runtime')>(), readDesktopRuntime: vi.fn()}))

it('requires the active workspace, managed Chief, live run and exact saved chat; cleanup survives Stop', async () => {
    const db = createClient({url: 'file::memory:'})
    const runtime = {workspaceId: 2, launchNonce: randomUUID(), dataRoot: '/isolated/workspaces/2'} as DesktopRuntime
    vi.mocked(readDesktopRuntime).mockResolvedValue(runtime)
    const identity = {engineAgentId:'foreman',sessionId:'s1',runId:'r1'}
    const binding = {workspaceId:'2',chatId:'chat-1',runId:'r1'}
    const managed = {id:'foreman',config:{kind:'foreman',enabled:true,ephemeral:false}}
    const run = {id:'r1',agentId:'foreman',sessionId:'s1',status:'running'}
    const engine = vi.fn(async (path: string) => path === '/agents/foreman' ? managed : run)
    const check = (overrides: Partial<typeof identity> = {}, release = false) =>
        authorizeForemanSharedVault(runtime, db, {...identity,...overrides}, new AbortController().signal, release, engine)
    try {
        await db.executeMultiple(DESKTOP_FOREMAN_CHAT_SCHEMA)
        await db.execute("INSERT INTO desktop_foreman_chats(chat_id,workspace_id,engine_session_id) VALUES('chat-1','2','s1')")
        await db.execute({sql:"INSERT INTO desktop_foreman_turns(request_id,chat_id,fingerprint,body,status,created_at) VALUES('r1','chat-1','f',?,'admitted','now')",args:[JSON.stringify({binding,sessionId:'s1'})]})
        expect(await check()).toBe('foreman')
        await expect(check({sessionId:'foreign'})).rejects.toThrow()
        await expect(check({engineAgentId:'ada'})).rejects.toThrow()
        managed.config.ephemeral=true
        await expect(check()).rejects.toThrow()
        managed.config.ephemeral=false
        run.status='done'
        await expect(check()).rejects.toThrow()
        run.status='running'
        vi.mocked(readDesktopRuntime).mockResolvedValueOnce({...runtime,launchNonce:randomUUID()})
        await expect(check()).rejects.toThrow()
        setDesktopWorkspaceFrozen(runtime,true)
        await expect(check()).rejects.toThrow()
        setDesktopWorkspaceFrozen(runtime,false)
        await db.execute("UPDATE desktop_foreman_turns SET status='cancelled'")
        await expect(check()).rejects.toThrow()
        expect(await check({},true)).toBe('foreman')
        await expect(check({sessionId:'sibling'},true)).rejects.toThrow()
    } finally { setDesktopWorkspaceFrozen(runtime,false); db.close() }
})
