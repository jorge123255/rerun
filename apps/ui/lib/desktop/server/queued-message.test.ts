import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from './database'
import { createDesktopAgent, createDesktopSession } from './store'
import { readDesktopQueue, writeDesktopQueue } from './queued-message'
import { writeDesktopTabs } from './session-tabs'
import { desktopQueuedMessageSchema, type DesktopQueuedMessage } from '../queued-message'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'rerun-queue-')) })
afterEach(async () => { await closeDesktopDatabase(root); await rm(root, { recursive: true, force: true }) })
const item = (text = 'Follow-up'): DesktopQueuedMessage => ({ id: crypto.randomUUID(), text, attachmentPath: 'notes.md', createdAt: Date.now(), behindRunId: 'original-run', state: 'waiting' })

async function setup() {
    const db = await openDesktopDatabase(root)
    const agent = await createDesktopAgent(db, { name: 'First', engineAgentId: 'first' })
    const other = await createDesktopAgent(db, { name: 'Other', engineAgentId: 'other' })
    const a = await createDesktopSession(db, { agentId: agent.id, engineSessionId: 'chat-a', title: 'A' })
    const b = await createDesktopSession(db, { agentId: agent.id, engineSessionId: 'chat-b', title: 'B' })
    return { db, agent, other, a, b }
}

test('queues survive a cold database reopen and remain scoped to their coworker and conversation', async () => {
    const { db, agent, other, a, b } = await setup()
    const first = item('First chat only'), second = item('Second chat only')
    await writeDesktopQueue(db, agent.id, { action: 'enqueue', scope: { sessionId: a.id }, expectedId: null, item: first })
    await writeDesktopQueue(db, agent.id, { action: 'enqueue', scope: { sessionId: b.id }, expectedId: null, item: second })
    await closeDesktopDatabase(root)
    const reopened = await openDesktopDatabase(root)
    expect((await readDesktopQueue(reopened, agent.id, { sessionId: a.id })).queued).toEqual(first)
    expect((await readDesktopQueue(reopened, agent.id, { sessionId: b.id })).queued).toEqual(second)
    await expect(readDesktopQueue(reopened, other.id, { sessionId: a.id })).rejects.toMatchObject({ status: 404 })
    await reopened.execute({ sql: 'DELETE FROM desktop_agents WHERE id = ?', args: [agent.id] })
    expect((await reopened.execute('SELECT * FROM desktop_queued_messages')).rows).toHaveLength(0)
})

test('replacement and acknowledgement compare the exact queue ID, and lost write responses are idempotent', async () => {
    const { db, agent, a } = await setup()
    const first = item('Earlier'), second = item('Replacement'), scope = { sessionId: a.id }
    const enqueue = { action: 'enqueue' as const, scope, expectedId: null, item: first }
    await writeDesktopQueue(db, agent.id, enqueue)
    expect((await writeDesktopQueue(db, agent.id, enqueue)).queued).toEqual(first)
    await writeDesktopQueue(db, agent.id, { action: 'enqueue', scope, expectedId: first.id, item: second })
    await writeDesktopQueue(db, agent.id, { action: 'remove', scope, id: first.id })
    expect((await readDesktopQueue(db, agent.id, scope)).queued).toEqual(second)
    await expect(writeDesktopQueue(db, agent.id, enqueue)).rejects.toMatchObject({ status: 409 })
    await writeDesktopQueue(db, agent.id, { action: 'attempt', scope, id: second.id })
    await expect(writeDesktopQueue(db, agent.id, { action: 'enqueue', scope, expectedId: second.id, item: first })).rejects.toMatchObject({ status: 409 })
})

test('a blank-tab queue follows only its first-turn mapping, and migration collisions return a reviewable draft', async () => {
    const { db, agent, a } = await setup()
    const tabUid = 'blank-tab', original = item('From the blank tab'), destination = item('Already in this conversation')
    await writeDesktopTabs(db, agent.id, { baseRevision: 0, tabs: [{ uid: tabUid, id: null }], activeIndex: 0 })
    await writeDesktopQueue(db, agent.id, { action: 'enqueue', scope: { tabUid }, expectedId: null, item: original })
    await writeDesktopQueue(db, agent.id, { action: 'enqueue', scope: { sessionId: a.id }, expectedId: null, item: destination })
    await db.execute({ sql: 'INSERT INTO desktop_tab_starts (agent_id, uid, input_hash, engine_session_id, run_id, title, model_choice, launch_nonce) VALUES (?,?,?,?,?,?,?,?)', args: [agent.id, tabUid, 'hash', a.engineSessionId, crypto.randomUUID(), 'A', 'null', 'launch'] })
    const scope = { sessionId: a.id, tabUid }
    expect((await readDesktopQueue(db, agent.id, scope)).queued).toEqual({ ...original, state: 'review' })
    expect((await readDesktopQueue(db, agent.id, { sessionId: a.id })).queued).toEqual(destination)
    await writeDesktopQueue(db, agent.id, { action: 'remove', scope, id: original.id })
    expect((await readDesktopQueue(db, agent.id, scope)).queued).toEqual(destination)
})

test('pending coworker deletion blocks queue writes and does not touch another coworker', async () => {
    const { db, agent, other, a } = await setup()
    await db.execute({ sql: 'INSERT INTO desktop_deletions (agent_id, engine_agent_id, name, completed) VALUES (?,?,?,0)', args: [agent.id, agent.engineAgentId, agent.name] })
    await expect(writeDesktopQueue(db, agent.id, { action: 'enqueue', scope: { sessionId: a.id }, expectedId: null, item: item() })).rejects.toMatchObject({ status: 409 })
    const otherSession = await createDesktopSession(db, { agentId: other.id, engineSessionId: 'other-chat', title: 'Other' })
    const otherItem = item('Other coworker')
    await writeDesktopQueue(db, other.id, { action: 'enqueue', scope: { sessionId: otherSession.id }, expectedId: null, item: otherItem })
    expect((await readDesktopQueue(db, other.id, { sessionId: otherSession.id })).queued).toEqual(otherItem)
})


test('an image-only queued message remains valid after a cold reopen; empty or malformed selections fail', async () => {
    const { db, agent, a } = await setup()
    const image = { sha256: '1'.repeat(64), name: 'image.png', path: 'image.png', mediaType: 'image/png' as const, width: 1, height: 1, byteLength: 12 }
    const queued = desktopQueuedMessageSchema.parse({ ...item(''), attachmentPath: undefined, attachmentItems: [{ type: 'image', image }] })
    await writeDesktopQueue(db, agent.id, { action: 'enqueue', scope: { sessionId: a.id }, expectedId: null, item: queued })
    await closeDesktopDatabase(root)
    const reopened = await openDesktopDatabase(root)
    expect((await readDesktopQueue(reopened, agent.id, { sessionId: a.id })).queued).toEqual(queued)
    expect(desktopQueuedMessageSchema.safeParse({ ...queued, attachmentItems: undefined }).success).toBe(false)
    expect(desktopQueuedMessageSchema.safeParse({ ...queued, attachmentItems: [] }).success).toBe(false)
    expect(desktopQueuedMessageSchema.safeParse({ ...queued, attachmentItems: [{ type: 'image', image: { ...image, sha256: 'invalid' } }] }).success).toBe(false)
})


test('keeps selected coworker IDs in a reviewed queue after reopening its database',async()=>{
    const {db,agent,a,b}=await setup()
    const mentions=[{targetId:'local-peer',token:'@ada',start:0,end:4}]
    const selected={...item('@ada review'),coworkerMentions:mentions}
    await writeDesktopQueue(db,agent.id,{action:'enqueue',scope:{sessionId:a.id},expectedId:null,item:selected})
    await closeDesktopDatabase(root)
    const reopened=await openDesktopDatabase(root)
    expect((await readDesktopQueue(reopened,agent.id,{sessionId:a.id})).queued).toMatchObject({id:selected.id,text:selected.text,coworkerMentions:mentions})
    expect((await readDesktopQueue(reopened,agent.id,{sessionId:b.id})).queued).toBeNull()
    await writeDesktopQueue(reopened,agent.id,{action:'review',scope:{sessionId:a.id},id:selected.id})
    expect((await readDesktopQueue(reopened,agent.id,{sessionId:a.id})).queued).toMatchObject({state:'review',coworkerMentions:mentions})
})
