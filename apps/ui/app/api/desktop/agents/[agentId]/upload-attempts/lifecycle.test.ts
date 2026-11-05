import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession } from '@/lib/desktop/server/store'
import { readDesktopChats, writeDesktopTabs } from '@/lib/desktop/server/session-tabs'
import type { DesktopTabWrite } from '@/lib/desktop/session-tabs'
import type { DesktopUploadAttempt } from '@/lib/desktop/composer-upload-attempts'
import { PUT as putTabs } from '../tabs/route'
import { GET, POST, DELETE } from './route'

const env = { ...process.env }, origin = 'http://127.0.0.1:3189', token = 'l'.repeat(48)
let directory: string, alice: string, bob: string, original: string, alternate: string, foreign: string
const params = (agentId: string) => ({ params: Promise.resolve({ agentId }) })
function request(owner: string, uid: string, method = 'GET', body?: unknown) {
    return new Request(`${origin}/api/desktop/agents/${owner}/upload-attempts?${new URLSearchParams({ tabUid: uid })}`, {
        method, headers: { host: new URL(origin).host, origin, cookie: `rerun-desktop-session=${token}`, 'content-type': 'application/json' },
        ...(body !== undefined && { body: JSON.stringify(body) }),
    })
}
const get = (uid: string, owner = alice) => GET(request(owner, uid), params(owner))
const tabs = (body: DesktopTabWrite, owner = alice) => putTabs(request(owner, '', 'PUT', body), params(owner))
const dismiss = (id: string, uid: string, owner = alice) => DELETE(request(owner, uid, 'DELETE', { tabUid: uid, id }), params(owner))
async function reserve(uid: string, owner = alice, name = 'notes.md') {
    const attempt = { id: crypto.randomUUID(), name, size: 12 }
    const response = await POST(request(owner, uid, 'POST', { tabUid: uid, ...attempt }), params(owner))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ created: true, attempt })
    return attempt
}
async function attempts(uid: string, owner = alice): Promise<DesktopUploadAttempt[]> {
    const response = await get(uid, owner)
    expect(response.status).toBe(200)
    return (await response.json()).attempts
}
const ids = (rows: DesktopUploadAttempt[]) => rows.map(row => row.id).sort()
async function snapshot() {
    const db = await openDesktopDatabase(directory)
    const result = await db.batch([
        'SELECT * FROM desktop_agent_tabs ORDER BY agent_id',
        'SELECT * FROM desktop_composer_uploads ORDER BY agent_id,tab_uid,id',
        'SELECT * FROM desktop_composer_drafts ORDER BY agent_id,tab_uid',
        'SELECT * FROM desktop_composer_draft_writes ORDER BY request_id',
    ], 'read')
    return result.map(value => value.rows)
}
async function seedDraft(owner: string, uid: string, text: string) {
    const db = await openDesktopDatabase(directory)
    await db.execute({ sql: 'INSERT INTO desktop_composer_drafts (agent_id,tab_uid,revision,text,updated_at) VALUES (?,?,1,?,?)',
        args: [owner, uid, text, '2026-11-04T00:00:00.000Z'] })
    await db.execute({ sql: 'INSERT INTO desktop_composer_draft_writes (request_id,agent_id,tab_uid,fingerprint,result_revision) VALUES (?,?,?,?,1)',
        args: [crypto.randomUUID(), owner, uid, 'fixture-write'] })
}

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rerun-upload-lifecycle-'))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: directory, RERUN_DESKTOP_RUNTIME_FILE: join(directory, 'runtime.json') })
    await writeFile(join(directory, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'upload-lifecycle', buildId: 'test', workspaceId: 1, dataRoot: directory,
        app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:1', apiKey: 'unused' } }), { mode: 0o600 })
    const db = await openDesktopDatabase(directory)
    alice = (await createDesktopAgent(db, { engineAgentId: 'alice', name: 'Alice' })).id
    bob = (await createDesktopAgent(db, { engineAgentId: 'bob', name: 'Bob' })).id
    original = (await createDesktopSession(db, { agentId: alice, engineSessionId: 'original', title: 'Original' })).id
    alternate = (await createDesktopSession(db, { agentId: alice, engineSessionId: 'alternate', title: 'Alternate' })).id
    foreign = (await createDesktopSession(db, { agentId: bob, engineSessionId: 'foreign', title: 'Foreign' })).id
    await writeDesktopTabs(db, alice, { baseRevision: 0, tabs: [{ uid: 'live', id: original }, { uid: 'spare', id: null }], activeIndex: 0 })
    await writeDesktopTabs(db, bob, { baseRevision: 0, tabs: [{ uid: 'live', id: foreign }], activeIndex: 0 })
})
afterEach(async () => {
    await closeDesktopDatabase(directory)
    process.env = { ...env }
    await rm(directory, { recursive: true, force: true })
})

test('uncertain imports follow the original session without a draft, survive restart and do not move twice on retry', async () => {
    const first = await reserve('live'), second = await reserve('live', alice, 'second.md'), other = await reserve('live', bob)
    const db = await openDesktopDatabase(directory)
    expect((await db.execute('SELECT * FROM desktop_composer_drafts')).rows).toHaveLength(0)
    const moved: DesktopTabWrite = { baseRevision: 1, activeIndex: 1,
        tabs: [{ uid: 'original-new', id: original }, { uid: 'live', id: alternate }, { uid: 'spare', id: null }] }
    expect((await tabs(moved)).status).toBe(200)
    expect(ids(await attempts('original-new'))).toEqual(ids([first, second]))
    expect(await attempts('live')).toEqual([])
    const alternateAttempt = await reserve('live', alice, 'alternate.md')
    const after = await snapshot()
    // Lost-response layout retries must not steal the alternate chat's newer import warning.
    expect((await tabs(moved)).status).toBe(200)
    expect(await snapshot()).toEqual(after)
    await closeDesktopDatabase(directory)
    expect(ids(await attempts('original-new'))).toEqual(ids([first, second]))
    expect(await attempts('live')).toEqual([alternateAttempt])
    expect(await attempts('live', bob)).toEqual([other])
    expect((await readDesktopChats(await openDesktopDatabase(directory), alice)).tabs).toMatchObject({ revision: 2, activeIndex: 1 })
})

test('a transfer can fill exactly ten unresolved imports and the eleventh admission leaves them intact', async () => {
    const all: DesktopUploadAttempt[] = []
    for (let index = 0; index < 6; index++) all.push(await reserve('live'))
    for (let index = 0; index < 4; index++) all.push(await reserve('spare'))
    expect((await tabs({ baseRevision: 1, activeIndex: 1, tabs: [{ uid: 'live', id: alternate }, { uid: 'spare', id: original }] })).status).toBe(200)
    expect(ids(await attempts('spare'))).toEqual(ids(all))
    const before = await snapshot()
    const rejected = { id: crypto.randomUUID(), tabUid: 'spare', name: 'eleventh.md', size: 12 }
    expect((await POST(request(alice, 'spare', 'POST', rejected), params(alice))).status).toBe(409)
    expect(await snapshot()).toEqual(before)
})

test('over-cap combining refuses the whole warning, tab and draft plan atomically', async () => {
    const db = await openDesktopDatabase(directory)
    const third = (await createDesktopSession(db, { agentId: alice, engineSessionId: 'third', title: 'Third' })).id
    expect((await tabs({ baseRevision: 1, activeIndex: 1, tabs: [{ uid: 'third', id: third }, { uid: 'live', id: original }, { uid: 'spare', id: null }] })).status).toBe(200)
    await reserve('third')
    for (let index = 0; index < 6; index++) await reserve('live')
    for (let index = 0; index < 5; index++) await reserve('spare')
    await seedDraft(alice, 'third', 'Third draft remains here')
    await seedDraft(alice, 'live', 'Original draft remains here')
    const before = await snapshot()
    // Third has a valid move, but Original would combine 6 + 5 unresolved imports.
    expect((await tabs({ baseRevision: 2, activeIndex: 1,
        tabs: [{ uid: 'third-new', id: third }, { uid: 'live', id: alternate }, { uid: 'spare', id: original }] })).status).toBe(409)
    expect(await snapshot()).toEqual(before)
    await closeDesktopDatabase(directory)
    expect(await snapshot()).toEqual(before)
    expect((await get('third-new')).status).toBe(404)
})

test('swapping two existing chat UIDs moves each original warning once and applies the cap to final owners', async () => {
    expect((await tabs({ baseRevision: 1, activeIndex: 0, tabs: [{ uid: 'live', id: original }, { uid: 'spare', id: alternate }] })).status).toBe(200)
    const originalWarnings: DesktopUploadAttempt[] = [], alternateWarnings: DesktopUploadAttempt[] = []
    for (let index = 0; index < 6; index++) {
        originalWarnings.push(await reserve('live', alice, `original-${index}.md`))
        alternateWarnings.push(await reserve('spare', alice, `alternate-${index}.md`))
    }
    const other = await reserve('live', bob)
    const swapped: DesktopTabWrite = { baseRevision: 2, activeIndex: 0, tabs: [{ uid: 'live', id: alternate }, { uid: 'spare', id: original }] }
    // The intermediate sum is 12, but each final chat still owns only its six warnings.
    expect((await tabs(swapped)).status).toBe(200)
    expect(ids(await attempts('live'))).toEqual(ids(alternateWarnings))
    expect(ids(await attempts('spare'))).toEqual(ids(originalWarnings))
    const after = await snapshot()
    expect((await tabs(swapped)).status).toBe(200)
    expect(await snapshot()).toEqual(after)
    await closeDesktopDatabase(directory)
    expect(await snapshot()).toEqual(after)
    expect(await attempts('live', bob)).toEqual([other])
})

test('a three-chat UID cycle preserves every warning with its original session after restart', async () => {
    const db = await openDesktopDatabase(directory)
    const third = (await createDesktopSession(db, { agentId: alice, engineSessionId: 'cycle-third', title: 'Third' })).id
    expect((await tabs({ baseRevision: 1, activeIndex: 0,
        tabs: [{ uid: 'live', id: original }, { uid: 'spare', id: alternate }, { uid: 'third', id: third }] })).status).toBe(200)
    const warnings: Record<string, DesktopUploadAttempt[]> = { live: [], spare: [], third: [] }
    for (const uid of ['live', 'spare', 'third']) for (let index = 0; index < 4; index++) warnings[uid]!.push(await reserve(uid, alice, `${uid}-${index}.md`))
    const cycle: DesktopTabWrite = { baseRevision: 2, activeIndex: 2,
        tabs: [{ uid: 'live', id: alternate }, { uid: 'spare', id: third }, { uid: 'third', id: original }] }
    expect((await tabs(cycle)).status).toBe(200)
    await closeDesktopDatabase(directory)
    expect(ids(await attempts('live'))).toEqual(ids(warnings.spare!))
    expect(ids(await attempts('spare'))).toEqual(ids(warnings.third!))
    expect(ids(await attempts('third'))).toEqual(ids(warnings.live!))
    const after = await snapshot()
    expect((await tabs(cycle)).status).toBe(200)
    expect(await snapshot()).toEqual(after)
})

test('a failed layout write rolls back exact warning moves and a reused UID cannot inherit a closed chat warning', async () => {
    const warning = await reserve('live'), db = await openDesktopDatabase(directory)
    const before = await snapshot()
    await db.execute("CREATE TRIGGER reject_upload_layout BEFORE UPDATE ON desktop_agent_tabs BEGIN SELECT RAISE(ABORT, 'fixture layout failure'); END")
    expect((await tabs({ baseRevision: 1, activeIndex: 0, tabs: [{ uid: 'moved', id: original }, { uid: 'live', id: alternate }] })).status).toBe(500)
    await db.execute('DROP TRIGGER reject_upload_layout')
    expect(await snapshot()).toEqual(before)
    expect((await tabs({ baseRevision: 1, activeIndex: 0, tabs: [{ uid: 'live', id: alternate }] })).status).toBe(200)
    expect(await attempts('live')).toEqual([])
    expect((await db.execute({ sql: 'SELECT id FROM desktop_composer_uploads WHERE id=?', args: [warning.id] })).rows).toHaveLength(0)
})

test('closing a tab removes only its uncertain imports, draft and draft receipts; late writes cannot recreate it', async () => {
    const closed = await reserve('live'), retained = await reserve('spare'), other = await reserve('live', bob)
    await seedDraft(alice, 'live', 'Discard only this closed draft')
    await seedDraft(alice, 'spare', 'Keep this blank draft')
    await seedDraft(bob, 'live', 'Keep Bob draft')
    expect((await tabs({ baseRevision: 1, activeIndex: 0, tabs: [{ uid: 'spare', id: null }] })).status).toBe(200)
    expect((await get('live')).status).toBe(404)
    expect((await POST(request(alice, 'live', 'POST', { ...closed, tabUid: 'live' }), params(alice))).status).toBe(404)
    const db = await openDesktopDatabase(directory)
    expect((await db.execute({ sql: 'SELECT * FROM desktop_composer_uploads WHERE id=?', args: [closed.id] })).rows).toHaveLength(0)
    for (const table of ['desktop_composer_drafts', 'desktop_composer_draft_writes'])
        expect((await db.execute({ sql: `SELECT * FROM ${table} WHERE agent_id=? AND tab_uid=?`, args: [alice, 'live'] })).rows).toHaveLength(0)
    const after = await snapshot()
    await closeDesktopDatabase(directory)
    expect(await snapshot()).toEqual(after)
    expect(await attempts('spare')).toEqual([retained])
    expect(await attempts('live', bob)).toEqual([other])
})

test('foreign owner, wrong tab and corrupt cross-owner layouts cannot move, read or dismiss another warning', async () => {
    const own = await reserve('live'), other = await reserve('live', bob)
    const before = await snapshot()
    expect((await tabs({ baseRevision: 1, activeIndex: 0, tabs: [{ uid: 'live', id: foreign }, { uid: 'spare', id: null }] })).status).toBe(404)
    expect((await POST(request(bob, 'live', 'POST', { ...own, tabUid: 'live' }), params(bob))).status).toBe(409)
    expect((await POST(request(alice, 'spare', 'POST', { ...own, tabUid: 'spare' }), params(alice))).status).toBe(409)
    await dismiss(own.id, 'live', bob)
    await dismiss(own.id, 'spare')
    expect(await snapshot()).toEqual(before)
    const db = await openDesktopDatabase(directory)
    await db.execute({ sql: 'UPDATE desktop_agent_tabs SET layout=? WHERE agent_id=?', args: [JSON.stringify({ activeIndex: 0, tabs: [{ uid: 'live', id: foreign }] }), alice] })
    const corrupt = await snapshot()
    expect((await get('live')).status).toBe(404)
    expect((await POST(request(alice, 'live', 'POST', { ...own, tabUid: 'live' }), params(alice))).status).toBe(404)
    expect((await dismiss(own.id, 'live')).status).toBe(404)
    expect(await snapshot()).toEqual(corrupt)
    expect(await attempts('live', bob)).toEqual([other])
})
