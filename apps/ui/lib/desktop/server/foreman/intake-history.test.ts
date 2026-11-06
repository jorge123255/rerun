import { createClient, type Client } from '@libsql/client'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopForemanIntakeCompletionReceipt } from '@rerun/contracts'
import type { HistoryMessage } from '@/lib/chat/engine-history'
import type { DesktopRuntime } from '../runtime'
import { DESKTOP_FOREMAN_CHAT_SCHEMA, type ForemanTurn } from './chat-store'
import { DESKTOP_FOREMAN_INTAKE_SCHEMA_SQL, fingerprintIntakeAnswers } from '../foreman-intake'
import { foremanIntakeMessage } from './intake'
import { hideDesktopForemanIntakeKickoff } from './intake-history'

vi.mock('../settings', () => ({ engineOf: (runtime: DesktopRuntime) => ({ baseUrl: runtime.engine.origin, apiKey: runtime.engine.apiKey }) }))

describe('receipt-bound Foreman kickoff presentation', () => {
    let directory: string, db: Client, runtime: DesktopRuntime
    const chat = { workspaceId: '2', chatId: 'fmc_historyprimary01' }
    const sessionId = randomUUID(), requestId = randomUUID(), messageId = randomUUID()
    const model = { connectionId: 'chosen-local-connection', model: 'chosen-model' }
    const owner = { chat, sessionId, model }
    const answers = { companyUrl: null, industry: 'saas' as const, decidedIndustry: null, industryLabel: null, position: 'Product or Engineering', firstName: 'QA' }
    const text = foremanIntakeMessage(answers)
    const timestamp = '2026-11-06T14:00:00.000Z'
    const open = () => createClient({ url: `file:${join(directory, 'app.sqlite')}` })
    let payload: Record<string, unknown>, fetcher: ReturnType<typeof vi.fn>
    const history = (): HistoryMessage[] => [
        { id: `engine-${messageId}`, role: 'user', parts: [{ type: 'text', text }] },
        { id: 'engine-reply', role: 'assistant', parts: [{ type: 'text', text: 'Here is a proposed plan.' }] },
        // A user can paste exactly the generated text. That genuine message remains visible.
        { id: 'engine-pasted-by-user', role: 'user', parts: [{ type: 'text', text }] },
    ]
    const project = (messages = history()) => hideDesktopForemanIntakeKickoff(runtime, db, owner, messages)
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'rerun-intake-history-'))
        db = open()
        await db.executeMultiple(DESKTOP_FOREMAN_CHAT_SCHEMA + DESKTOP_FOREMAN_INTAKE_SCHEMA_SQL)
        await db.execute({ sql: 'INSERT INTO desktop_foreman_chats(chat_id,workspace_id,engine_session_id,model) VALUES(?,?,?,?)', args: [chat.chatId, chat.workspaceId, sessionId, JSON.stringify(model)] })
        const receipt: DesktopForemanIntakeCompletionReceipt = { requestId, chat, fingerprint: fingerprintIntakeAnswers(answers, chat, requestId), state: 'acknowledged', answers, followUp: { conversationId: sessionId, runId: requestId, industry: 'saas' }, error: null, missingAuthority: null, createdAt: timestamp, updatedAt: timestamp }
        await db.execute({ sql: 'INSERT INTO desktop_foreman_intake_completions(request_id,workspace_id,chat_id,fingerprint,state,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', args: [requestId, chat.workspaceId, chat.chatId, receipt.fingerprint, receipt.state, JSON.stringify(receipt), timestamp, timestamp] })
        const turn: ForemanTurn = { binding: { ...chat, runId: requestId, model }, sessionId, text, brief: { instructions: 'Original immutable brief', tools: [] } }
        await db.execute({ sql: "INSERT INTO desktop_foreman_turns(request_id,chat_id,fingerprint,body,status,created_at) VALUES(?,?,?,?,'admitted',?)", args: [requestId, chat.chatId, createHash('sha256').update(JSON.stringify([chat, text, null])).digest('hex'), JSON.stringify(turn), timestamp] })
        runtime = { protocolVersion: 1, workspaceId: 2, launchNonce: randomUUID(), buildId: 'source-test', dataRoot: directory, app: { origin: 'http://127.0.0.1:3210', sessionToken: 'a'.repeat(64) }, engine: { origin: 'http://127.0.0.1:3222', apiKey: 'b'.repeat(64) } }
        payload = { id: requestId, agentId: 'foreman', sessionId, status: 'done', stepCount: 1, usageJson: null, provider: 'codex', model: model.model, triggerSource: null, triggerSlug: null, costMicros: null, inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, totalTokens: null, startedAt: timestamp, finishedAt: timestamp, error: null, queuedUserMessageId: messageId }
        fetcher = vi.fn(async (url: string, init: RequestInit) => {
            expect(url).toBe(`${runtime.engine.origin}/agents/foreman/runs/${requestId}`)
            expect(init.method).toBe('GET')
            return Response.json(payload)
        })
        vi.stubGlobal('fetch', fetcher)
    })
    afterEach(async () => { db.close(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }) })

    it('hides only the canonical generated user row, retaining assistant and same-text ordinary messages', async () => {
        expect((await project()).map(message => message.id)).toEqual(['engine-reply', 'engine-pasted-by-user'])
        expect(fetcher).toHaveBeenCalledOnce()
    })

    it('restores the same presentation after real-file reopen without changing receipts or turns', async () => {
        const before = await db.execute('SELECT body FROM desktop_foreman_turns')
        db.close(); db = open()
        expect((await project()).map(message => message.id)).toEqual(['engine-reply', 'engine-pasted-by-user'])
        expect((await db.execute('SELECT body FROM desktop_foreman_turns')).rows).toEqual(before.rows)
        expect(Number((await db.execute('SELECT COUNT(*) AS n FROM desktop_foreman_intake_completions')).rows[0]!.n)).toBe(1)
    })

    it.each(['id', 'agentId', 'sessionId', 'model', 'queuedUserMessageId'])('retains history when the engine %s does not identify this exact kickoff', async field => {
        payload[field] = 'different-identity'
        await expect(project()).rejects.toMatchObject({ status: 503 })
    })

    it('requires a confirmed pointer, exact visible body and user role', async () => {
        delete payload.queuedUserMessageId
        await expect(project()).rejects.toMatchObject({ status: 503 })
        payload.queuedUserMessageId = messageId
        const assistant = history(); assistant[0]!.role = 'assistant'
        expect(await project(assistant)).toEqual(assistant)
        const changed = history(); changed[0]!.parts = [{ type: 'text', text: text + '\nMy own words' }]
        expect(await project(changed)).toEqual(changed)
    })

    it.each(['pending', 'uncertain', 'failed'] as const)('hides a proven generated row with a %s receipt without granting completion authority', async state => {
        const row = (await db.execute('SELECT body FROM desktop_foreman_intake_completions')).rows[0]!
        const receipt = JSON.parse(String(row.body)); receipt.state = state; receipt.followUp = null
        await db.execute({ sql: 'UPDATE desktop_foreman_intake_completions SET state=?,body=?', args: [state, JSON.stringify(receipt)] })
        await db.execute({ sql: 'UPDATE desktop_foreman_turns SET status=?', args: [state === 'failed' ? 'failed' : 'pending'] })
        expect((await project()).map(message => message.id)).toEqual(['engine-reply', 'engine-pasted-by-user'])
        expect((await db.execute('SELECT state FROM desktop_foreman_intake_completions')).rows[0]!.state).toBe(state)
        expect(fetcher).toHaveBeenCalledOnce()
    })

    it('never hides using an unavailable receipt', async () => {
        await db.execute("UPDATE desktop_foreman_intake_completions SET state='unavailable'")
        expect(await project()).toEqual(history())
        expect(fetcher).not.toHaveBeenCalled()
    })

    it('requires the canonical local send body before consulting the engine', async () => {
        await db.execute("UPDATE desktop_foreman_turns SET fingerprint='damaged'")
        expect(await project()).toEqual(history())
        expect(fetcher).not.toHaveBeenCalled()
    })

    it('keeps unproven kickoff history unavailable rather than publishing raw instructions, without any retry effect', async () => {
        fetcher.mockRejectedValueOnce(new Error('Engine unavailable'))
        await expect(project()).rejects.toMatchObject({ status: 503 })
        expect(fetcher).toHaveBeenCalledOnce()
        expect(await hideDesktopForemanIntakeKickoff({ ...runtime, workspaceId: 3 }, db, owner, history())).toEqual(history())
        expect(fetcher).toHaveBeenCalledOnce()
    })
})
