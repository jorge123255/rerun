import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { readDesktopRuntime } from '@/lib/desktop/server/runtime'
import { beginDesktopWorkspaceAdmission, completeDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'
import * as coworkerFiles from '@/lib/desktop/server/coworker-files'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { createDesktopAgent, createDesktopSession } from '@/lib/desktop/server/store'
import { writeDesktopTabs } from '@/lib/desktop/server/session-tabs'
import { PUT as writeTabs } from '../tabs/route'
import { GET, PUT, DELETE } from './route'

const env = { ...process.env }
const origin = 'http://127.0.0.1:3189', token = 'd'.repeat(48)
let root: string, alice: string, bob: string, original: string, alternate: string, other: string
const workspace = (engineId: string) => join(root, 'workspaces', '1', 'engine', 'agents', engineId, 'workspace')
const params = (agentId: string) => ({ params: Promise.resolve({ agentId }) })
function request(agentId: string, tabUid: string, method = 'GET', body?: object, headers?: Record<string, string>) {
    return new Request(`${origin}/api/desktop/agents/${agentId}/draft?tabUid=${encodeURIComponent(tabUid)}`, { method,
        headers: { host: new URL(origin).host, origin, cookie: 'rerun-desktop-session=' + token, 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) })
}
const get = (tabUid = 'live', agentId = alice) => GET(request(agentId, tabUid), params(agentId))
const read = async (tabUid = 'live', agentId = alice) => (await (await get(tabUid, agentId)).json()).draft
const input = (text: string, baseRevision = 0, tabUid = 'live', attachmentPath?: string) => ({ tabUid, baseRevision, requestId: crypto.randomUUID(), text, ...(attachmentPath && { attachmentPath }) })
const put = (body: object, agentId = alice) => PUT(request(agentId, '', 'PUT', body), params(agentId))
const clear = (body: object, agentId = alice) => DELETE(request(agentId, '', 'DELETE', body), params(agentId))
const tabs = (body: object, agentId = alice) => writeTabs(request(agentId, '', 'PUT', body), params(agentId))

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-composer-drafts-'))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'drafts', buildId: 'draft-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:1', apiKey: 'unused' } }), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    alice = (await createDesktopAgent(db, { engineAgentId: 'alice-engine', name: 'Alice' })).id
    bob = (await createDesktopAgent(db, { engineAgentId: 'bob-engine', name: 'Bob' })).id
    original = (await createDesktopSession(db, { agentId: alice, engineSessionId: 'original-engine', title: 'Original chat' })).id
    alternate = (await createDesktopSession(db, { agentId: alice, engineSessionId: 'alternate-engine', title: 'Alternate chat' })).id
    other = (await createDesktopSession(db, { agentId: bob, engineSessionId: 'other-engine', title: 'Other chat' })).id
    await writeDesktopTabs(db, alice, { baseRevision: 0, tabs: [{ uid: 'live', id: original }, { uid: 'blank', id: null }], activeIndex: 0 })
    await writeDesktopTabs(db, bob, { baseRevision: 0, tabs: [{ uid: 'live', id: other }], activeIndex: 0 })
    for (const id of ['alice-engine', 'bob-engine']) {
        await mkdir(workspace(id), { recursive: true })
        await writeFile(join(workspace(id), 'notes.md'), id + ' file bytes')
    }
})
afterEach(async () => {
    await closeDesktopDatabase(root); process.env = { ...env }
    await rm(root, { recursive: true, force: true })
})

test('GET is read-only and drafts persist exact text and a selected own file through restart and disable', async () => {
    expect(await read()).toEqual({ revision: 0, text: '' })
    const db = await openDesktopDatabase(root)
    expect((await db.execute('SELECT * FROM desktop_composer_drafts')).rows).toHaveLength(0)
    const body = input('  Preserve whitespace\nUnicode: café 🚀\n', 0, 'live', 'notes.md')
    const response = await put(body)
    expect(response.status).toBe(200)
    const saved = (await response.json()).draft
    expect(saved).toMatchObject({ revision: 1, text: body.text, attachmentPath: 'notes.md' })
    await db.execute({ sql: 'UPDATE desktop_agents SET enabled = 0 WHERE id = ?', args: [alice] })
    await closeDesktopDatabase(root)
    expect(await read()).toEqual(saved)
    expect(await read('live', bob)).toEqual({ revision: 0, text: '' })
    expect((await put(input('Disabled draft still editable', 1))).status).toBe(200)
    expect(JSON.stringify((await (await openDesktopDatabase(root)).execute('SELECT * FROM desktop_composer_drafts')).rows)).not.toContain('alice-engine file bytes')
})

test('drafts keep an ordered multi-file set and validate each file before storing it', async () => {
    for (const name of ['a.md', 'b.txt']) await writeFile(join(workspace('alice-engine'), name), name)
    const body = { tabUid: 'live', baseRevision: 0, requestId: crypto.randomUUID(), text: 'Compare them', attachmentPaths: ['a.md', 'b.txt'] }
    const response = await put(body)
    expect(response.status).toBe(200)
    const saved = (await response.json()).draft
    expect(saved).toMatchObject({ revision: 1, text: 'Compare them', attachmentPaths: ['a.md', 'b.txt'] })
    expect(saved).not.toHaveProperty('attachmentPath')
    const db = await openDesktopDatabase(root)
    const row = (await db.execute('SELECT attachment_path, attachment_paths FROM desktop_composer_drafts')).rows[0]
    expect(String(row.attachment_path)).toBe('a.md')
    expect(JSON.parse(String(row.attachment_paths))).toEqual(['a.md', 'b.txt'])

    expect((await put({ ...body, baseRevision: 1, requestId: crypto.randomUUID(), attachmentPaths: ['a.md', 'missing.md'] })).status).toBe(404)
    expect((await put({ ...body, baseRevision: 1, requestId: crypto.randomUUID(), attachmentPaths: ['a.md', 'a.md'] })).status).toBe(400)
    for (let index = 0; index < 5; index++) await writeFile(join(workspace('alice-engine'), `heavy-${index}.md`), Buffer.alloc(32 * 1024, 65))
    expect((await put({ ...body, baseRevision: 1, requestId: crypto.randomUUID(), attachmentPaths: Array.from({ length: 5 }, (_, index) => `heavy-${index}.md`) })).status).toBe(413)
    expect(await read()).toEqual(saved)
})
test('draft writes require authentication, ownership, and safe own-file paths', async () => {
    const body = input('Draft')
    expect((await PUT(request(alice, '', 'PUT', body, { cookie: '' }), params(alice))).status).toBe(401)
    expect((await PUT(request(alice, '', 'PUT', body, { origin: 'https://example.com' }), params(alice))).status).toBe(403)
    expect((await put({ ...body, tabUid: 'missing' })).status).toBe(404)
    expect((await put({ ...body, tabUid: 'blank' }, bob)).status).toBe(404)
    expect((await put(body, 'missing-agent')).status).toBe(404)
    for (const extra of [{ sessionId: other }, { content: 'Fake file bytes' }, { baseRevision: -1 }, { requestId: 'invalid' }, { text: 'x'.repeat(20_001) }, { attachmentPath: '../notes.md' }]) expect((await put({ ...body, ...extra })).status).toBe(400)
    await symlink(join(workspace('bob-engine'), 'notes.md'), join(workspace('alice-engine'), 'foreign.md'))
    expect((await put({ ...body, attachmentPath: 'foreign.md' })).status).toBe(400)
    expect((await put({ ...body, attachmentPath: 'missing.md' })).status).toBe(404)
    expect(await read()).toEqual({ revision: 0, text: '' })
})

test('freeze refuses fresh browser writes and only the current native drain can save a pending draft', async () => {
    const runtime = await readDesktopRuntime()
    const pending = input('Edit pending before the switch')
    beginDesktopWorkspaceAdmission(runtime, 'freeze', 1)
    const rejected = await put(input('Fresh edit during freeze'))
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({ code: 'draft_frozen' })
    expect((await clear({ tabUid: pending.tabUid, requestId: crypto.randomUUID(), revision: 0, text: '' })).status).toBe(409)
    expect(await read()).toEqual({ revision: 0, text: '' })
    const drain = (authorization: string, launchNonce: string, body = pending, agentId = alice) =>
        PUT(request(agentId, '', 'PUT', body, { cookie: '', authorization, 'x-rerun-launch-nonce': launchNonce }), params(agentId))
    const bearer = `Bearer ${runtime.engine.apiKey}`
    expect((await drain('Bearer browser-forgery', runtime.launchNonce)).status).toBe(401)
    expect((await drain(bearer, 'stale-launch')).status).toBe(409)
    expect((await drain(bearer, runtime.launchNonce, { ...pending, tabUid: 'missing' })).status).toBe(404)
    expect((await drain(bearer, runtime.launchNonce, pending, 'missing-agent')).status).toBe(404)
    expect((await drain(bearer, runtime.launchNonce)).status).toBe(200)
    expect((await drain(bearer, runtime.launchNonce)).status).toBe(200)
    await closeDesktopDatabase(root)
    expect(await read()).toMatchObject({ revision: 1, text: pending.text })
    beginDesktopWorkspaceAdmission(runtime, 'unfreeze', 2)
    completeDesktopWorkspaceAdmission(runtime, 'unfreeze', 2)
    expect((await put(input('Editing resumed', 1))).status).toBe(200)
})

test('attachment validation refusals are typed, unaccepted, and can be corrected without losing text', async () => {
    const body = { ...input('Keep this exact text'), attachmentPaths: ['notes.md', 'missing.md'] }
    const rejected = await put(body)
    expect(rejected.status).toBe(404)
    expect(await rejected.json()).toMatchObject({ code: 'draft_attachment_rejected', error: 'File not found' })
    const db = await openDesktopDatabase(root)
    expect((await db.execute({ sql: 'SELECT request_id FROM desktop_composer_draft_writes WHERE request_id = ?', args: [body.requestId] })).rows).toHaveLength(0)
    expect(await read()).toEqual({ revision: 0, text: '' })
    const corrected = { ...input(body.text), attachmentPath: 'notes.md' }
    expect((await put(corrected)).status).toBe(200)
    expect(await read()).toMatchObject({ revision: 1, text: body.text, attachmentPath: 'notes.md' })
    const stale = await put({ ...body, requestId: crypto.randomUUID() })
    expect(stale.status).toBe(409)
    expect(await stale.json()).not.toHaveProperty('code')
    await closeDesktopDatabase(root)
    expect(await read()).toMatchObject({ revision: 1, text: body.text, attachmentPath: 'notes.md' })
})

test.each([false, true])('a late attachment refusal reconciles an identical accepted request before rejecting (newer draft: %s)', async newerDraft => {
    let entered!: () => void, release!: () => void
    const validating = new Promise<void>(resolve => { entered = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    const readFile = coworkerFiles.readCoworkerFile
    let held = false
    const spy = vi.spyOn(coworkerFiles, 'readCoworkerFile').mockImplementation(async (...args) => {
        if (!held) {
            held = true
            entered()
            await released
            throw new DesktopHttpError(404, 'File not found')
        }
        return readFile(...args)
    })
    const body = input('An accepted attachment draft', 0, 'live', 'notes.md')
    const first = put(body)
    try {
        // The first request has passed receipt/CAS admission but is still validating its file.
        await validating
        const duplicate = await put(body)
        expect(duplicate.status).toBe(200)
        if (newerDraft) expect((await put(input('A newer saved draft', 1, 'live', 'notes.md'))).status).toBe(200)
        const latest = await read()
        release()
        const reconciled = await first
        expect(reconciled.status).toBe(200)
        const result = await reconciled.json()
        expect(result).not.toHaveProperty('code')
        expect(result.draft).toEqual(latest)
        expect(result.draft).toMatchObject({ revision: newerDraft ? 2 : 1, text: newerDraft ? 'A newer saved draft' : body.text, attachmentPath: 'notes.md' })
        expect(await read()).toEqual(latest)
        const db = await openDesktopDatabase(root)
        expect((await db.execute({ sql: 'SELECT request_id FROM desktop_composer_draft_writes WHERE request_id = ?', args: [body.requestId] })).rows).toHaveLength(1)
    } finally {
        release()
        await first
        spy.mockRestore()
    }
})

test('one concurrent CAS writer wins; immutable UUID retries reconcile without replaying old text', async () => {
    const first = input('First'), second = input('Second')
    const replies = await Promise.all([put(first), put(second)])
    expect(replies.map(reply => reply.status).sort()).toEqual([200, 409])
    const winner = replies[0].status === 200 ? first : second
    const saved = await read()
    expect((await replies.find(reply => reply.status === 409)!.json()).draft).toEqual(saved)
    expect((await (await put(winner)).json()).draft).toEqual(saved)
    expect((await put({ ...winner, text: 'Changed identity' })).status).toBe(409)
    expect((await put(winner, bob)).status).toBe(409)
    expect((await put(input('A newer edit', saved.revision))).status).toBe(200)
    const newer = await read()
    expect((await (await put(winner)).json()).draft).toEqual(newer)
    expect((await read()).text).toBe('A newer edit')
})

test('accepted snapshot clearing preserves newer typing and tombstones block delayed draft resurrection', async () => {
    const body = input('Sent text')
    expect((await put(body)).status).toBe(200)
    const snapshot = await read(), clearId = crypto.randomUUID()
    expect((await put(input('Typed while sending', snapshot.revision))).status).toBe(200)
    const lateClear = await clear({ tabUid: 'live', requestId: clearId, revision: snapshot.revision, text: snapshot.text })
    expect(lateClear.status).toBe(200)
    expect(await lateClear.json()).toMatchObject({ cleared: false, draft: { text: 'Typed while sending', revision: 2 } })
    const current = await read(), acceptedClear = { tabUid: 'live', requestId: crypto.randomUUID(), revision: current.revision, text: current.text }
    expect(await (await clear(acceptedClear)).json()).toMatchObject({ cleared: true, draft: { text: '', revision: 3 } })
    expect((await put(input('Stale resurrection', 1))).status).toBe(409)
    await closeDesktopDatabase(root)
    expect(await read()).toMatchObject({ text: '', revision: 3 })
    expect((await put(input('New draft after clear', 3))).status).toBe(200)
    expect(await (await clear(acceptedClear)).json()).toMatchObject({ cleared: false, draft: { text: 'New draft after clear', revision: 4 } })
    expect((await (await put(body)).json()).draft.text).toBe('New draft after clear')
})

test('first-send session binding preserves the stable blank-tab draft and attachment', async () => {
    expect((await put(input('Follow-up typed during first send', 0, 'blank', 'notes.md'))).status).toBe(200)
    const before = await read('blank')
    expect((await tabs({ baseRevision: 1, activeIndex: 1, tabs: [{ uid: 'live', id: original }, { uid: 'blank', id: alternate }] })).status).toBe(200)
    await closeDesktopDatabase(root)
    expect(await read('blank')).toEqual(before)
})

test('regeneration atomically moves the original draft to its new UID and invalidates old live-UID saves', async () => {
    expect((await put(input('Original chat draft', 0, 'live', 'notes.md'))).status).toBe(200)
    const source = await read()
    const layout = { baseRevision: 1, activeIndex: 1, tabs: [{ uid: 'source-new', id: original }, { uid: 'live', id: alternate }, { uid: 'blank', id: null }] }
    expect((await tabs(layout)).status).toBe(200)
    expect(await read('source-new')).toMatchObject({ text: source.text, attachmentPath: source.attachmentPath })
    const live = await read()
    expect(live).toMatchObject({ text: '', revision: source.revision + 1 })
    expect((await put(input('Delayed original autosave', source.revision))).status).toBe(409)
    expect((await put(input('Alternate draft', live.revision))).status).toBe(200)
    const alternateDraft = await read()
    expect((await tabs(layout)).status).toBe(200)
    expect(await read()).toEqual(alternateDraft)
    await closeDesktopDatabase(root)
    expect((await read('source-new')).text).toBe('Original chat draft')
    expect((await read()).text).toBe('Alternate draft')
    expect((await tabs({ baseRevision: 2, activeIndex: 0, tabs: [{ uid: 'live', id: alternate }, { uid: 'blank', id: null }] })).status).toBe(200)
    expect((await get('source-new')).status).toBe(404)
    expect((await put(input('Closed source must stay gone', 0, 'source-new'))).status).toBe(404)
    expect(await read()).toEqual(alternateDraft)
})

test('regeneration transfers every ordered attachment and clears both fields on the alternate through retry and restart', async () => {
    await writeFile(join(workspace('alice-engine'), 'second.txt'), 'second attachment')
    const paths = ['second.txt', 'notes.md']
    expect((await put({ ...input('Multi-file source draft'), attachmentPaths: paths })).status).toBe(200)
    const source = await read()
    const layout = { baseRevision: 1, activeIndex: 1, tabs: [{ uid: 'source-new', id: original }, { uid: 'live', id: alternate }, { uid: 'blank', id: null }] }
    expect((await tabs(layout)).status).toBe(200)
    const transferred = await read('source-new')
    expect(transferred).toMatchObject({ text: source.text, attachmentPaths: paths })
    expect(transferred).not.toHaveProperty('attachmentPath')
    const cleared = await read()
    expect(cleared).toMatchObject({ text: '', revision: source.revision + 1 })
    expect(cleared).not.toHaveProperty('attachmentPath')
    expect(cleared).not.toHaveProperty('attachmentPaths')
    const db = await openDesktopDatabase(root)
    const stored = (await db.execute({ sql: 'SELECT attachment_path,attachment_paths FROM desktop_composer_drafts WHERE agent_id=? AND tab_uid=?', args: [alice, 'live'] })).rows[0]
    expect(stored.attachment_path).toBeNull()
    expect(stored.attachment_paths).toBeNull()
    expect((await put({ ...input('Delayed original draft', source.revision), attachmentPaths: paths })).status).toBe(409)
    expect((await put(input('Alternate’s new draft', cleared.revision, 'live', 'notes.md'))).status).toBe(200)
    const alternateDraft = await read()
    expect((await tabs(layout)).status).toBe(200)
    await closeDesktopDatabase(root)
    expect(await read('source-new')).toEqual(transferred)
    expect(await read()).toEqual(alternateDraft)
    expect(alternateDraft).not.toHaveProperty('attachmentPaths')
})

test('fork transfer refuses a destination whose attachment set differs after the same first file', async () => {
    for (const name of ['second.txt', 'third.txt']) await writeFile(join(workspace('alice-engine'), name), name)
    expect((await put({ ...input('Same text'), attachmentPaths: ['notes.md', 'second.txt'] })).status).toBe(200)
    expect((await tabs({ baseRevision: 1, activeIndex: 0, tabs: [{ uid: 'live', id: original }, { uid: 'occupied', id: alternate }] })).status).toBe(200)
    expect((await put({ ...input('Same text', 0, 'occupied'), attachmentPaths: ['notes.md', 'third.txt'] })).status).toBe(200)
    const source = await read(), destination = await read('occupied')
    expect((await tabs({ baseRevision: 2, activeIndex: 0, tabs: [{ uid: 'live', id: alternate }, { uid: 'occupied', id: original }] })).status).toBe(409)
    await closeDesktopDatabase(root)
    expect(await read()).toEqual(source)
    expect(await read('occupied')).toEqual(destination)
})

test('a failed layout commit rolls back draft transfer and an occupied destination does not lose either draft', async () => {
    expect((await put(input('Original draft'))).status).toBe(200)
    const before = await read(), db = await openDesktopDatabase(root)
    await db.execute("CREATE TRIGGER reject_draft_layout BEFORE UPDATE ON desktop_agent_tabs BEGIN SELECT RAISE(ABORT, 'simulated commit failure'); END")
    const fork = { baseRevision: 1, activeIndex: 1, tabs: [{ uid: 'new-source', id: original }, { uid: 'live', id: alternate }] }
    expect((await tabs(fork)).status).toBe(500)
    await db.execute('DROP TRIGGER reject_draft_layout')
    expect(await read()).toEqual(before)
    expect((await db.execute({ sql: 'SELECT * FROM desktop_composer_drafts WHERE tab_uid = ?', args: ['new-source'] })).rows).toHaveLength(0)
    expect((await tabs({ baseRevision: 1, activeIndex: 0, tabs: [{ uid: 'live', id: original }, { uid: 'occupied', id: alternate }] })).status).toBe(200)
    expect((await put(input('Other chat draft', 0, 'occupied'))).status).toBe(200)
    expect((await tabs({ baseRevision: 2, activeIndex: 0, tabs: [{ uid: 'live', id: alternate }, { uid: 'occupied', id: original }] })).status).toBe(409)
    expect((await read()).text).toBe('Original draft')
    expect((await read('occupied')).text).toBe('Other chat draft')
})

test('closing a tab or deleting its coworker cascades draft receipts and delayed writes cannot recreate them', async () => {
    expect((await put(input('Alice draft'))).status).toBe(200)
    expect((await put(input('Bob draft'), bob)).status).toBe(200)
    const closed = { baseRevision: 1, activeIndex: 0, tabs: [{ uid: 'blank', id: null }] }
    const results = await Promise.all([put(input('Late Alice update', 1)), tabs(closed)])
    expect(results[1].status).toBe(200)
    expect([200, 404]).toContain(results[0].status)
    expect((await put(input('After close', 0))).status).toBe(404)
    const db = await openDesktopDatabase(root)
    expect((await db.execute({ sql: 'SELECT * FROM desktop_composer_drafts WHERE agent_id = ?', args: [alice] })).rows).toHaveLength(0)
    expect((await db.execute({ sql: 'SELECT * FROM desktop_composer_draft_writes WHERE agent_id = ?', args: [alice] })).rows).toHaveLength(0)
    expect((await read('live', bob)).text).toBe('Bob draft')
    await db.execute({ sql: 'DELETE FROM desktop_agents WHERE id = ?', args: [bob] })
    expect((await put(input('After deletion'), bob)).status).toBe(404)
    expect((await db.execute('SELECT * FROM desktop_composer_drafts')).rows).toHaveLength(0)
    expect((await db.execute('SELECT * FROM desktop_composer_draft_writes')).rows).toHaveLength(0)
})

test('retry metadata stays bounded and an evicted old operation remains blocked by its stale revision', async () => {
    const oldest = input('Oldest')
    expect((await put(oldest)).status).toBe(200)
    for (let version = 1; version <= 65; version++) expect((await put(input('Draft ' + version, version))).status).toBe(200)
    const db = await openDesktopDatabase(root)
    expect((await db.execute('SELECT * FROM desktop_composer_draft_writes')).rows).toHaveLength(64)
    expect((await put(oldest)).status).toBe(409)
    expect(await read()).toMatchObject({ text: 'Draft 65', revision: 66 })
})

test('mixed image drafts retain snapshot identity through visible replacement, fork transfer, retry and restart', async () => {
    const sharp = (await import('sharp')).default
    const { importDesktopComposerImage } = await import('@/lib/desktop/server/composer-image-files')
    const runtime = { protocolVersion: 1 as const, launchNonce: 'drafts', buildId: 'draft-test', workspaceId: 1 as const, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:1', apiKey: 'unused' } }
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ff0000' } }).png().toBuffer()
    const imported = await importDesktopComposerImage(runtime, alice, '', 'reference.png', bytes)
    await writeFile(join(workspace('alice-engine'), 'after.txt'), 'After')
    const attachmentItems = [{ type: 'text', path: 'notes.md' }, { type: 'image', image: imported.image }, { type: 'text', path: 'after.txt' }]
    const body = { ...input('Compare the notes and image'), attachmentItems }
    expect((await put(body)).status).toBe(200)
    const source = await read()
    expect(source).toMatchObject({ attachmentItems, revision: 1 })
    expect(source).not.toHaveProperty('attachmentPaths')
    // Changing the Files copy cannot change or invalidate this already accepted snapshot.
    await writeFile(join(workspace('alice-engine'), 'reference.png'), 'a replacement visible file')
    expect((await put(body)).status).toBe(200)
    expect((await put({ ...body, requestId: crypto.randomUUID() }, bob)).status).toBe(404)
    const layout = { baseRevision: 1, activeIndex: 1, tabs: [{ uid: 'source-new', id: original }, { uid: 'live', id: alternate }, { uid: 'blank', id: null }] }
    expect((await tabs(layout)).status).toBe(200)
    expect(await read('source-new')).toMatchObject({ text: source.text, attachmentItems })
    const cleared = await read()
    expect(cleared).toMatchObject({ text: '' })
    expect(cleared).not.toHaveProperty('attachmentItems')
    expect((await put({ ...body, requestId: crypto.randomUUID(), baseRevision: source.revision })).status).toBe(409)
    expect((await tabs(layout)).status).toBe(200)
    await closeDesktopDatabase(root)
    expect(await read('source-new')).toMatchObject({ text: source.text, attachmentItems })
    expect(await read()).toEqual(cleared)
})
