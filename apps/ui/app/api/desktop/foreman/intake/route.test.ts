import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EMPTY_DRAFT, toIntake, type DesktopForemanChatRef } from '@rerun/contracts'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { DESKTOP_FOREMAN_CHAT_SCHEMA } from '@/lib/desktop/server/foreman/chat-store'
import { initializeDesktopRound35 } from '@/lib/desktop/server/round35-schema'
import { setDesktopWorkspaceFrozen } from '@/lib/desktop/server/workspace-admission'
import { readDesktopForemanIntakeProfile } from '@/lib/desktop/server/foreman/intake-profile'
import { createDesktopForemanIntakeClient } from '@/lib/desktop/foreman-intake/client'
import { DesktopForemanIntakeClientConflictError } from '@/lib/desktop/foreman-intake/ports'

const active = vi.hoisted(() => ({ runtime: null as DesktopRuntime | null, db: null as Client | null, sends: 0 }))
vi.mock('@/lib/desktop/server/runtime', async original => ({ ...await original<typeof import('@/lib/desktop/server/runtime')>(), readDesktopRuntime: async () => active.runtime! }))
vi.mock('@/lib/desktop/server/foreman/binding', () => ({ desktopForeman: async () => ({
    db: active.db!,
    send: async (chat: DesktopForemanChatRef, requestId: string, text: string) => {
        active.sends++
        const binding = { ...chat, runId: requestId, model: { connectionId: 'chosen-connection', model: 'chosen-model' } }
        const body = { binding, sessionId: 'the-original-session', text, brief: { instructions: 'Canonical Foreman test instructions', tools: [] } }
        const fingerprint = createHash('sha256').update(JSON.stringify([chat, text, null])).digest('hex')
        await active.db!.execute({ sql: "INSERT INTO desktop_foreman_turns(request_id,chat_id,fingerprint,body,status,created_at) VALUES(?,?,?,?,'admitted',?)", args: [requestId, chat.chatId, fingerprint, JSON.stringify(body), new Date().toISOString()] })
        return { runId: requestId }
    },
}) }))
import { GET, POST } from './route'

const chat = { workspaceId: '1', chatId: 'fmc_intakehttp001' }
const origin = 'http://127.0.0.1:43100', token = 's'.repeat(48)
const draft = { ...EMPTY_DRAFT, companyUrl: 'example.com', position: 'QA', firstName: 'QA' }
let directory: string
const open = () => createClient({ url: `file:${join(directory, 'app.db')}` })
function request(body?: unknown, query: Record<string, string> = chat, options: { cookie?: boolean; origin?: string } = {}) {
    const headers: Record<string, string> = { host: '127.0.0.1:43100' }
    if (options.cookie !== false) headers.cookie = `rerun-desktop-session=${token}`
    if (body !== undefined) { headers.origin = options.origin ?? origin; headers['content-type'] = 'application/json' }
    return new Request(`${origin}/api/desktop/foreman/intake?${new URLSearchParams(query)}`, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
async function save(baseRevision = 0) {
    const input = { chat, requestId: randomUUID(), baseRevision, stepIndex: 2, draft, decidedIndustry: null, knownFirstName: null }
    const response = await POST(request({ action: 'save', input }))
    expect(response.status).toBe(200)
    return { input, view: await response.json() }
}
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rerun-intake-http-'))
    active.db = open(); active.sends = 0
    active.runtime = { protocolVersion: 1, workspaceId: 1, dataRoot: directory, launchNonce: randomUUID(), buildId: 'intake-http', app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:43101', apiKey: 'not-a-live-key' } }
    setDesktopWorkspaceFrozen(active.runtime, false)
    await active.db.executeMultiple(`PRAGMA foreign_keys=ON; CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY,id TEXT NOT NULL); ${DESKTOP_FOREMAN_CHAT_SCHEMA}`)
    await active.db.execute({ sql: 'INSERT INTO desktop_foreman_chats(chat_id,workspace_id,engine_session_id) VALUES(?,?,?)', args: [chat.chatId, chat.workspaceId, 'the-original-session'] })
    await initializeDesktopRound35(active.db)
})
afterEach(async () => {
    if (active.runtime) setDesktopWorkspaceFrozen(active.runtime, false)
    active.db?.close(); active.db = null; active.runtime = null
    vi.unstubAllGlobals()
    await rm(directory, { recursive: true, force: true })
})

it('uses the real cookie/origin checks and refuses a different workspace or chat', async () => {
    expect((await GET(request(undefined, chat, { cookie: false }))).status).toBe(401)
    expect((await POST(request({ action: 'lookup', chat, requestId: randomUUID() }, chat, { origin: 'https://elsewhere.invalid' }))).status).toBe(403)
    expect((await GET(request(undefined, { ...chat, workspaceId: '2' }))).status).toBe(404)
    expect((await GET(request(undefined, { ...chat, chatId: 'fmc_someoneelse001' }))).status).toBe(404)
    expect(active.sends).toBe(0)
})

it('restores saved answers and the exact acknowledged completion after file-backed close/reopen', async () => {
    expect((await GET(request())).status).toBe(200)
    const { view } = await save()
    const command = { action: 'complete', input: { chat, requestId: randomUUID(), expectedRevision: view.session.revision, answers: toIntake(draft, null) } }
    const response = await POST(request(command)); expect(response.status).toBe(200)
    const receipt = await response.json()
    expect(receipt.state).toBe('acknowledged')
    expect(receipt.followUp.conversationId).toBe('the-original-session')
    expect(active.sends).toBe(1)
    active.db!.close(); active.db = open()
    const after = await GET(request()); expect(after.status).toBe(200)
    expect((await after.json()).completion).toEqual(receipt)
    expect(await readDesktopForemanIntakeProfile(active.db!, chat)).toEqual(toIntake(draft, null))
    expect(await (await POST(request(command))).json()).toEqual(receipt)
    expect((await active.db!.execute('SELECT engine_session_id FROM desktop_foreman_chats')).rows).toEqual([{ engine_session_id: 'the-original-session' }])
    expect(active.sends).toBe(1)
})

it('returns the canonical conflict and rejects fabricated hints or unsaved completion answers', async () => {
    const { input, view } = await save()
    const conflict = await POST(request({ action: 'save', input: { ...input, requestId: randomUUID(), draft: { ...draft, firstName: 'Different' } } }))
    expect(conflict.status).toBe(409)
    expect((await conflict.json()).view.session).toEqual(view.session)
    expect((await POST(request({ action: 'save', input: { ...input, requestId: randomUUID(), baseRevision: 1, knownFirstName: 'Invented account name' } }))).status).toBe(400)
    const response = await POST(request({ action: 'complete', input: { chat, requestId: randomUUID(), expectedRevision: 1, answers: { ...toIntake(draft, null), firstName: 'Unsaved' } } }))
    expect(response.status).toBe(409)
    expect(active.sends).toBe(0)
})

it('drains admitted draft saves during a workspace freeze but refuses completion effects', async () => {
    await save()
    setDesktopWorkspaceFrozen(active.runtime!, true)
    const { view } = await save(1)
    expect(view.session.revision).toBe(2)
    const response = await POST(request({ action: 'complete', input: { chat, requestId: randomUUID(), expectedRevision: 2, answers: toIntake(draft, null) } }))
    expect(response.status).toBe(409)
    expect((await active.db!.execute('SELECT count(*) AS n FROM desktop_foreman_intake_completions')).rows[0].n).toBe(0)
    expect(active.sends).toBe(0)
})

it('projects route conflicts through the real browser adapter without replacing the visible draft', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => init?.body ? POST(request(JSON.parse(String(init.body)))) : GET(request())))
    const client = createDesktopForemanIntakeClient()
    expect((await client.read(chat)).completion).toBeNull()
    await save()
    await expect(client.save({ chat, requestId: randomUUID(), baseRevision: 0, stepIndex: 2, draft: { ...draft, firstName: 'Local unsaved' }, decidedIndustry: null, knownFirstName: null })).rejects.toBeInstanceOf(DesktopForemanIntakeClientConflictError)
    expect((await client.read(chat)).session.draft.firstName).toBe('QA')
    expect(active.sends).toBe(0)
})

it('refuses a corrupt saved receipt on read or lookup without acknowledging or repeating it', async () => {
    const { view } = await save()
    const input = { chat, requestId: randomUUID(), expectedRevision: view.session.revision, answers: toIntake(draft, null) }
    expect((await POST(request({ action: 'complete', input }))).status).toBe(200)
    await active.db!.execute({ sql: 'UPDATE desktop_foreman_intake_completions SET fingerprint=? WHERE request_id=?', args: ['corrupt', input.requestId] })
    expect((await GET(request())).status).toBe(503)
    expect((await POST(request({ action: 'lookup', chat, requestId: input.requestId }))).status).toBe(503)
    expect(active.sends).toBe(1)
})
