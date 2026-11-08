import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { GET as getSessions } from '../agents/[agentId]/sessions/route'
import { PUT as putTabs } from '../agents/[agentId]/tabs/route'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { readDesktopHistory } from '@/lib/desktop/server/engine'
import { createDesktopAgent, createDesktopSession } from '@/lib/desktop/server/store'
import { reserveTabStart } from '@/lib/desktop/server/tab-starts'
import { createAgent, createConnection, listRuns, patchAgent, setBoxDefault } from '@/lib/engine/client'
import { disposableRunEngine } from '@/test/desktop-run-engine.mjs'
import { POST as chat } from './route'

test.runIf(process.env.RERUN_TAB_ACCEPTANCE === '1').each(['Which color is marked?', ''])('a tab recovers an accepted first turn after restart without rereading its attachment (text=%j)', async text => {
    const env = { ...process.env }
    const root = await mkdtemp(join(tmpdir(), 'rerun-tab-first-'))
    const engine = await disposableRunEngine(root)
    function request(path: string, method = 'GET', body?: object) {
        const { origin, sessionToken } = engine.runtime.app
        return new Request(origin + path, { method, headers: {
            host: new URL(origin).host, origin, cookie: 'rerun-desktop-session=' + sessionToken, 'content-type': 'application/json',
        }, body: body && JSON.stringify(body) })
    }
    const send = (body: object) => chat(request('/api/desktop/chat', 'POST', body))
    try {
        const runtime = await engine.start()
        Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root,'runtime.json') })
        const conn = { baseUrl: runtime.engine.origin, apiKey: runtime.engine.apiKey }
        const provider = await createConnection(conn, { name: 'Fixture', provider: 'openrouter', models: ['qa-local'], extraModels: [], baseUrl: engine.providerOrigin, keys: { OPENROUTER_API_KEY: 'fixture-only' } })
        await setBoxDefault(conn, { connectionId: provider.id, model: 'qa-local' })
        const config = { connectionId: provider.id, provider: 'openrouter' as const, tools: { memory: false }, selfImprovement: { enabled: false } }
        const agent = await createAgent(conn, { config: { ...config, name: 'tabbed' } })
        const other = await createAgent(conn, { config: { ...config, name: 'other' } })
        const db = await openDesktopDatabase(root)
        const coworker = await createDesktopAgent(db, { name: 'Tab worker', engineAgentId: agent.id })
        const agentId = coworker.id
        const sibling = await createDesktopAgent(db, { name: 'Other', engineAgentId: other.id })
        const earlier = await createDesktopSession(db, { agentId, engineSessionId: 'earlier', title: 'Earlier chat' })
        const context = { params: Promise.resolve({ agentId }) }
        const path = '/api/desktop/agents/' + agentId
        const earlierTab = { uid: 'earlier', id: earlier.id }
        const blank = { uid: 'new-tab', id: null }
        expect((await putTabs(request(path+'/tabs','PUT',{ baseRevision: 0, tabs: [earlierTab,blank], activeIndex: 0 }),context)).status).toBe(200)
        const workspace = join(root,'workspaces/1/engine/agents',agent.id,'workspace')
        await mkdir(workspace, { recursive: true })
        const file = join(workspace,'Map.md')
        await writeFile(file,'Sepia 4598')
        const body = { agentId, tabUid: blank.uid, text, attachmentPath: 'Map.md' }
        expect((await send({ ...body, agentId: sibling.id })).status).toBe(404)
        expect((await send({ ...body, tabUid: 'closed' })).status).toBe(404)
        // Fail local registration after the real engine has accepted its first run. Both requests
        // now lose their reply. A cold start must recover from that earlier engine commit.
        await db.execute("CREATE TRIGGER reject_local_tab BEFORE INSERT ON desktop_sessions BEGIN SELECT RAISE(ABORT,'lost registration'); END")
        const attempts = await Promise.all([send(body), send(body)])
        expect(attempts.map(response => response.status)).toEqual([500,500])
        await engine.waitForProviderRequest(1)
        engine.finishReply()
        const first = (await db.execute({ sql: 'SELECT engine_session_id,title FROM desktop_tab_starts WHERE agent_id=?', args: [agentId] })).rows[0]
        expect(first.title).toBe(text || 'Map.md')
        await expect.poll(async () => (await listRuns(conn, agent.id, { sessionId: String(first.engine_session_id) }))[0]?.status).toBe('done')
        await db.execute('DROP TRIGGER reject_local_tab')
        await rm(file)
        await closeDesktopDatabase(root)
        await engine.stop()
        const restarted = await engine.start()
        const sessionResponse = await getSessions(request(path+'/sessions'),context)
        expect(sessionResponse.status).toBe(200)
        const saved = await sessionResponse.json()
        expect(saved.tabs.activeIndex).toBe(0)
        expect(saved.tabs.revision).toBe(1)
        const recovered = saved.tabs.tabs[1].id
        expect(recovered).toBeTruthy()
        expect(saved.tabs.tabs[0].id).toBe(earlier.id)
        expect((await readDesktopHistory(restarted,recovered)).map(row=>row.role)).toEqual(['user','assistant'])
        const retry = await send(body)
        expect(retry.status).toBe(200)
        expect(retry.headers.get('x-session-id')).toBe(recovered)
        expect(await retry.text()).toBe('data: [DONE]\n\n')
        expect((await send({ ...body, text: 'A different request' })).status).toBe(409)
        expect((await putTabs(request(path+'/tabs','PUT',{ baseRevision: 1, tabs: [earlierTab], activeIndex: 0 }),context)).status).toBe(200)
        expect((await send(body)).status).toBe(404)
        expect((await (await getSessions(request(path+'/sessions'),context)).json()).tabs.tabs).toHaveLength(1)
        expect(JSON.stringify(engine.providerMessages[0])).toContain('Sepia 4598')
        expect(engine.providerMessages).toHaveLength(1)
        const retryTab = { uid: 'retry-after-rejection', id: null }
        expect((await putTabs(request(path+'/tabs','PUT',{ baseRevision: 2, tabs: [earlierTab,retryTab], activeIndex: 1 }),context)).status).toBe(200)
        const newDb = await openDesktopDatabase(root)
        const newConn = { baseUrl: restarted.engine.origin, apiKey: restarted.engine.apiKey }
        const attempt = { agentId, tabUid: retryTab.uid, text: 'Not accepted' }
        const receiptCount = async () => (await newDb.execute({ sql: 'SELECT uid FROM desktop_tab_starts WHERE uid=?', args: [retryTab.uid] })).rows.length
        // A never-dispatched reservation from a dead launch disappears on the first reopen.
        await reserveTabStart(newDb, coworker, retryTab.uid, attempt, 'previous-launch')
        await getSessions(request(path+'/sessions'), context)
        expect(await receiptCount()).toBe(0)
        await patchAgent(newConn, agent.id, { enabled: false })
        expect((await send(attempt)).status).toBe(403)
        expect(await receiptCount()).toBe(0)
        await patchAgent(newConn, agent.id, { enabled: true })
        const corrected = await send({ ...attempt, text: 'Corrected first message' })
        expect(corrected.status).toBe(200)
        const stream = corrected.text()
        await engine.waitForProviderRequest(2)
        engine.finishReply()
        await stream
        expect(engine.providerMessages).toHaveLength(2)
    } finally {
        await closeDesktopDatabase(root)
        await engine.close()
        process.env = env
        await rm(root, { recursive: true, force: true })
    }
}, 45000)
