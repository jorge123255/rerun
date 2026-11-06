import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    EMPTY_DRAFT,
    type DesktopForemanChatRef,
    type DesktopForemanIntakeCompleteInput,
    type DesktopForemanIntakeCompletionReceipt,
} from '@rerun/contracts'

vi.mock('../settings', () => ({ engineOf: (runtime: { engine: { origin: string; apiKey: string } }) => ({ baseUrl: runtime.engine.origin, apiKey: runtime.engine.apiKey }) }))
vi.mock('@/lib/engine/client', () => ({
    EngineRequestError: class extends Error { constructor(message: string, readonly status: number) { super(message) } },
    getRun: vi.fn(),
}))
import { EngineRequestError, getRun } from '@/lib/engine/client'
import type { DesktopRuntime } from '../runtime'
import { DESKTOP_FOREMAN_INTAKE_SCHEMA_SQL, fingerprintIntakeAnswers } from '../foreman-intake'
import { DESKTOP_FOREMAN_CHAT_SCHEMA, type ForemanTurn } from './chat-store'
import { createDesktopForemanIntakeBinding, foremanIntakeMessage } from './intake'
import { readDesktopForemanIntakeProfile } from './intake-profile'

const chat = { workspaceId: '1', chatId: 'fmc_intakebinding1' }
const model = { connectionId: 'local-connection', model: 'chosen-model' }
const answers = { companyUrl: 'acme.com', industry: null, decidedIndustry: null, industryLabel: null, position: 'Founder', firstName: 'Ada' }
const draft = { ...EMPTY_DRAFT, companyUrl: 'acme.com', position: 'Founder', firstName: 'Ada' }
const sessionId = 'the-original-foreman-session'

describe('canonical local Foreman intake binding', () => {
    let directory: string
    let db: Client
    let runtime: DesktopRuntime
    const open = () => createClient({ url: `file:${join(directory, 'app.sqlite')}` })
    const recordTurn = async (scope: DesktopForemanChatRef, requestId: string, text: string, status = 'admitted') => {
        const body: ForemanTurn = { binding: { ...scope, runId: requestId, model }, sessionId, text, brief: { instructions: 'Local Foreman instructions', tools: [] } }
        const fingerprint = createHash('sha256').update(JSON.stringify([scope, text, null])).digest('hex')
        await db.execute({ sql: 'INSERT INTO desktop_foreman_turns(request_id,chat_id,fingerprint,body,status,created_at) VALUES(?,?,?,?,?,?)', args: [requestId, scope.chatId, fingerprint, JSON.stringify(body), status, new Date().toISOString()] })
    }
    const send = vi.fn(async (scope: DesktopForemanChatRef, requestId: string, text: string) => {
        await recordTurn(scope, requestId, text)
        return { runId: requestId }
    })
    const binding = () => createDesktopForemanIntakeBinding(runtime, { db, send })
    const save = async (): Promise<DesktopForemanIntakeCompleteInput> => {
        const view = await binding().save({ chat, requestId: randomUUID(), baseRevision: 0, stepIndex: 2, draft, decidedIndustry: null, knownFirstName: null })
        return { chat, requestId: randomUUID(), expectedRevision: view.session.revision, answers }
    }
    const seed = async (input: DesktopForemanIntakeCompleteInput, state: DesktopForemanIntakeCompletionReceipt['state']) => {
        const timestamp = '2026-11-06T00:00:00.000Z'
        const receipt: DesktopForemanIntakeCompletionReceipt = {
            requestId: input.requestId, chat: input.chat, fingerprint: fingerprintIntakeAnswers(input.answers, input.chat, input.requestId),
            state, answers: input.answers, followUp: null, error: null, missingAuthority: null, createdAt: timestamp, updatedAt: timestamp,
        }
        await db.execute({
            sql: 'INSERT INTO desktop_foreman_intake_completions(request_id,workspace_id,chat_id,fingerprint,state,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
            args: [receipt.requestId, chat.workspaceId, chat.chatId, receipt.fingerprint, state, JSON.stringify(receipt), timestamp, timestamp],
        })
    }
    const engineRun = (requestId: string) => ({ id: requestId, agentId: 'foreman', sessionId, status: 'running' }) as Awaited<ReturnType<typeof getRun>>

    beforeEach(async () => {
        vi.clearAllMocks()
        send.mockImplementation(async (scope, requestId, text) => { await recordTurn(scope, requestId, text); return { runId: requestId } })
        directory = await mkdtemp(join(tmpdir(), 'rerun-intake-binding-'))
        db = open()
        await db.executeMultiple(DESKTOP_FOREMAN_CHAT_SCHEMA + DESKTOP_FOREMAN_INTAKE_SCHEMA_SQL)
        await db.execute({ sql: 'INSERT INTO desktop_foreman_chats(chat_id,workspace_id,engine_session_id,model) VALUES(?,?,?,?)', args: [chat.chatId, chat.workspaceId, sessionId, JSON.stringify(model)] })
        runtime = { protocolVersion: 1, workspaceId: 1, launchNonce: randomUUID(), buildId: 'intake-source-test', dataRoot: directory, app: { origin: 'http://127.0.0.1:3210', sessionToken: 'a'.repeat(64) }, engine: { origin: 'http://127.0.0.1:3222', apiKey: 'b'.repeat(64) } }
    })
    afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

    it('uses stable user answers, asks needs, and carries no creation approval', () => {
        const text = foremanIntakeMessage(answers)
        expect(foremanIntakeMessage({ ...answers, firstName: ' Ada ' })).toBe(text)
        expect(text).toContain('Ask what work I need help with')
        expect(text).toContain('Never create coworkers')
        expect(text).toContain('review and explicitly confirm')
        expect(text).toContain('Treat missing company details as unknown')
        expect(text).toContain('read_company in this live conversation')
    })

    it('sends once to the existing chat/session and accepts only the canonical admission journal', async () => {
        const input = await save()
        expect(await readDesktopForemanIntakeProfile(db, chat)).toBeNull()
        const receipt = await binding().complete(input)
        expect(receipt.state).toBe('acknowledged')
        expect(receipt.followUp).toEqual({ conversationId: sessionId, runId: input.requestId, industry: null })
        expect(send).toHaveBeenCalledExactlyOnceWith(chat, input.requestId, foremanIntakeMessage(answers))
        expect(getRun).not.toHaveBeenCalled()
        expect(await readDesktopForemanIntakeProfile(db, chat)).toEqual(answers)
        expect(Number((await db.execute('SELECT COUNT(*) AS n FROM desktop_foreman_chats')).rows[0]!.n)).toBe(1)
        expect(String((await db.execute('SELECT engine_session_id FROM desktop_foreman_chats')).rows[0]!.engine_session_id)).toBe(sessionId)
    })

    it('uses root-migrated schema without executing DDL when request-scoped bindings are recreated', async () => {
        const ddl = vi.spyOn(db, 'executeMultiple')
        await binding().read(chat)
        await binding().read(chat)
        const input = await save()
        await binding().complete(input)
        await binding().lookupCompletion(chat, input.requestId)
        expect(ddl).not.toHaveBeenCalled()
    })

    it('restores acknowledgement after real-file reopen without sending or consulting the engine', async () => {
        const input = await save(), receipt = await binding().complete(input)
        db.close(); db = open()
        const restored = binding()
        expect((await restored.read(chat)).completion).toEqual(receipt)
        expect(await restored.lookupCompletion(chat, input.requestId)).toEqual(receipt)
        expect(await restored.complete(input)).toEqual(receipt)
        expect(await readDesktopForemanIntakeProfile(db, chat)).toEqual(answers)
        expect(send).toHaveBeenCalledTimes(1)
        expect(getRun).not.toHaveBeenCalled()
    })

    it('recovers a lost completion ACK from the admitted local turn after reopen without a second send', async () => {
        const input = await save()
        send.mockImplementationOnce(async (scope, requestId, text) => { await recordTurn(scope, requestId, text); throw new Error('response lost after admission') })
        expect((await binding().complete(input)).state).toBe('uncertain')
        expect(await readDesktopForemanIntakeProfile(db, chat)).toBeNull()
        expect(await readDesktopForemanIntakeProfile(db, chat, input.requestId)).toEqual(answers)
        db.close(); db = open()
        const receipt = await binding().complete(input)
        expect(receipt.state).toBe('acknowledged')
        expect(receipt.followUp?.runId).toBe(input.requestId)
        expect(send).toHaveBeenCalledTimes(1)
        expect(getRun).not.toHaveBeenCalled()
    })

    it('recovers a pending send from the exact engine receipt and bounds the lookup', async () => {
        const input = await save()
        await seed(input, 'pending')
        await recordTurn(chat, input.requestId, foremanIntakeMessage(answers), 'pending')
        vi.mocked(getRun).mockResolvedValueOnce(engineRun(input.requestId))
        expect((await binding().complete(input)).state).toBe('acknowledged')
        expect(send).not.toHaveBeenCalled()
        expect(getRun).toHaveBeenCalledWith({ baseUrl: runtime.engine.origin, apiKey: runtime.engine.apiKey }, 'foreman', input.requestId, { signal: expect.any(AbortSignal) })
    })

    it('retries an engine-absent pending journal through the same canonical send identity', async () => {
        const input = await save()
        await seed(input, 'pending')
        await recordTurn(chat, input.requestId, foremanIntakeMessage(answers), 'pending')
        vi.mocked(getRun).mockRejectedValueOnce(new EngineRequestError('not found', 404))
        send.mockImplementationOnce(async (_scope, requestId) => {
            await db.execute({ sql: "UPDATE desktop_foreman_turns SET status='admitted' WHERE request_id=?", args: [requestId] })
            return { runId: requestId }
        })
        expect((await binding().complete(input)).state).toBe('acknowledged')
        expect(send).toHaveBeenCalledExactlyOnceWith(chat, input.requestId, foremanIntakeMessage(answers))
    })

    it('keeps unknown engine outcomes uncertain and cannot send under a fresh nonce', async () => {
        const input = await save()
        await seed(input, 'pending')
        await recordTurn(chat, input.requestId, foremanIntakeMessage(answers), 'pending')
        vi.mocked(getRun).mockRejectedValueOnce(new EngineRequestError('provider or engine unavailable', 503))
        expect((await binding().complete(input)).state).toBe('uncertain')
        await expect(binding().complete({ ...input, requestId: randomUUID() })).rejects.toMatchObject({ status: 409 })
        expect(send).not.toHaveBeenCalled()
    })

    it.each(['binding', 'text', 'fingerprint', 'session', 'index'] as const)('rejects a mismatched canonical turn %s before acknowledgement or resend', async field => {
        const input = await save()
        await seed(input, 'pending')
        await recordTurn(chat, input.requestId, foremanIntakeMessage(answers))
        const row = (await db.execute({ sql: 'SELECT body FROM desktop_foreman_turns WHERE request_id=?', args: [input.requestId] })).rows[0]!
        const body = JSON.parse(String(row.body)) as ForemanTurn
        if (field === 'binding') body.binding = { ...body.binding, workspaceId: '2' }
        if (field === 'text') body.text += '\nextra instruction'
        if (field === 'session') body.sessionId = 'another-session'
        if (field === 'index') await db.execute({
            sql: 'INSERT INTO desktop_foreman_chats(chat_id,workspace_id,engine_session_id,model) VALUES(?,?,?,?)',
            args: ['fmc_anotherchat1', '2', 'rival-workspace-session', JSON.stringify(model)],
        })
        await db.execute({ sql: 'UPDATE desktop_foreman_turns SET body=?,fingerprint=CASE WHEN ? THEN ? ELSE fingerprint END,chat_id=CASE WHEN ? THEN ? ELSE chat_id END WHERE request_id=?', args: [JSON.stringify(body), field === 'fingerprint' ? 1 : 0, 'bad-hash', field === 'index' ? 1 : 0, 'fmc_anotherchat1', input.requestId] })
        expect((await binding().complete(input)).state).toBe('uncertain')
        expect(send).not.toHaveBeenCalled()
        expect(getRun).not.toHaveBeenCalled()
    })

    it.each(['agentId', 'sessionId', 'id'] as const)('refuses a pending engine receipt with a different %s', async field => {
        const input = await save()
        await seed(input, 'pending')
        await recordTurn(chat, input.requestId, foremanIntakeMessage(answers), 'pending')
        vi.mocked(getRun).mockResolvedValueOnce({ ...engineRun(input.requestId), [field]: 'different-identity' })
        expect((await binding().complete(input)).state).toBe('uncertain')
        expect(send).not.toHaveBeenCalled()
    })

    it('does not accept a send return value without the canonical admission journal', async () => {
        const input = await save()
        send.mockResolvedValueOnce({ runId: input.requestId })
        expect((await binding().complete(input)).state).toBe('uncertain')
        expect(await readDesktopForemanIntakeProfile(db, chat)).toBeNull()
    })

    it('keeps missing provider/model delivery truthful and optional authorities unavailable', async () => {
        const input = await save()
        send.mockRejectedValueOnce(new Error('Choose a connected model in Settings'))
        const service = binding()
        expect((await service.complete(input)).state).toBe('uncertain')
        expect(await service.decideIndustry('acme.com')).toBeNull()
        expect(service.analyzeSite('acme.com')).toEqual({ started: false, missingAuthority: 'DesktopForemanIntakeSiteAuthority' })
        expect(await service.resolveKnownFirstName(chat)).toBeNull()
        expect(await readDesktopForemanIntakeProfile(db, chat)).toBeNull()
        expect(getRun).not.toHaveBeenCalled()
    })

    it('limits unacknowledged profile access to the exact active request and rejects body/index corruption', async () => {
        const input = await save()
        await seed(input, 'pending')
        expect(await readDesktopForemanIntakeProfile(db, chat)).toBeNull()
        expect(await readDesktopForemanIntakeProfile(db, chat, randomUUID())).toBeNull()
        expect(await readDesktopForemanIntakeProfile(db, chat, input.requestId)).toEqual(answers)
        await db.execute({ sql: 'UPDATE desktop_foreman_intake_completions SET fingerprint=? WHERE request_id=?', args: ['different-column-hash', input.requestId] })
        await expect(readDesktopForemanIntakeProfile(db, chat, input.requestId)).rejects.toMatchObject({ status: 503 })
        await expect(binding().complete(input)).rejects.toMatchObject({ status: 503 })
        expect(send).not.toHaveBeenCalled()
    })

    it('refuses another workspace or unowned chat on every data path', async () => {
        const service = binding(), input = await save()
        const foreign = { ...chat, workspaceId: '2' }, deleted = { ...chat, chatId: 'fmc_deletedchat1' }
        for (const scope of [foreign, deleted]) {
            await expect(service.read(scope)).rejects.toMatchObject({ status: 404 })
            await expect(service.complete({ ...input, chat: scope })).rejects.toMatchObject({ status: 404 })
            await expect(service.lookupCompletion(scope, input.requestId)).rejects.toMatchObject({ status: 404 })
        }
        expect(send).not.toHaveBeenCalled()
        expect(getRun).not.toHaveBeenCalled()
    })
})
