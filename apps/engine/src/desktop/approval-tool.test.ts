import { mkdtempSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import { DESKTOP_FOREMAN_TURN_TEXT_LIMIT, desktopApprovalGuardSchema, desktopApprovalInput, desktopRerunGrantsOf, desktopRerunToolCatalog, findDesktopApproval, findDesktopQuestion, serializeApprovalDecisions } from '@rerun/contracts'
import type { RunContext } from '../runtime/context.js'

const root = mkdtempSync(join(tmpdir(), 'rerun-mac-approval-tool-'))
process.env.RERUN_DATA_DIR = root
process.env.RERUN_API_KEY = ''
const { agentDir } = await import('../config/paths.js')
const { agentConfigSchema } = await import('../agents/types.js')
const { writeAgentConfig } = await import('../agents/config-write.js')
const { readAgentConfig } = await import('../agents/loader.js')
const { desktopApprovalTools } = await import('./approval-tool.js')
const { buildTools } = await import('../tools/registry.js')
const { HITL_ACK_CALL_FIRST } = await import('../tools/builtin/hitl.js')
const { createServer } = await import('../http/server.js')
const app = createServer()
const alpha = 'approval-alpha', bravo = 'approval-bravo'
const input = { approvals: [{ action: 'Use the blue title', detail: 'Title: Blue sky' }, { action: 'Use the green subtitle' }] }
const options = { messages: [], toolCallId: 'approval-test' }

async function patch(id: string, body: unknown) {
    return app.request(`/agents/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}
async function registry(id: string, abortSignal?: AbortSignal) {
    const ctx = { agent: { id, config: await readAgentConfig(id) }, turnOrder: 'call-first', provider: 'codex', model: 'gpt-6.1-terra', abortSignal } as RunContext
    return (await buildTools(ctx)).tools
}
beforeAll(async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    for (const id of [alpha, bravo]) await mkdir(agentDir(id), { recursive: true })
})
beforeEach(async () => {
    for (const id of [alpha, bravo]) await writeAgentConfig(id, agentConfigSchema.parse({ name: id, tools: { requestApproval: false } }))
})
afterAll(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
})

describe('desktop request_approval grant', () => {
    it('defaults off and enables only the selected conversational tool without granting execution permissions', async () => {
        expect(desktopRerunGrantsOf({}).requestApproval).toBe(false)
        expect(desktopRerunToolCatalog.find(row => row.id === 'requestApproval')).toMatchObject({ available: true, tools: ['request_approval'] })
        expect((await registry(alpha)).request_approval).toBeUndefined()
        expect((await patch(alpha, { tools: { desktopToolGrants: { requestApproval: true } } })).status).toBe(200)
        expect(Object.keys(await registry(alpha))).toEqual(['request_approval'])
        expect((await registry(bravo)).request_approval).toBeUndefined()
        const config = await readAgentConfig(alpha)
        expect(config.tools.requestApproval).toBe(false)
        expect(desktopRerunGrantsOf(config.tools).workspaceRead).toBe(false)
        expect(config.tools.desktopCodexGrants).toBeUndefined()
        expect(await (await registry(alpha)).request_approval!.execute!(input, options)).toEqual(HITL_ACK_CALL_FIRST)
    })

    it('keeps Rerun’s approval schema, end-turn acknowledgement and mixed-decision language', async () => {
        await patch(alpha, { tools: { desktopToolGrants: { requestApproval: true } } })
        const approval = (await registry(alpha)).request_approval!
        const schema = approval.inputSchema as z.ZodTypeAny
        const parsed = schema.parse({ approvals: JSON.stringify([{ action: 'Use blue', detail: null }, { action: 'Use green', detail: 'Subtitle' }]) })
        expect(await approval.execute!(parsed, options)).toEqual(HITL_ACK_CALL_FIRST)
        expect(approval.description).toContain('END YOUR TURN')
        expect(approval.description).toContain('must NOT perform a declined action')
        expect(schema.safeParse({ approvals: [] }).success).toBe(false)
        await expect(approval.execute!({ approvals: [{ action: 'x'.repeat(4001) }] }, options)).rejects.toThrow('shorter action')
        const text = serializeApprovalDecisions([{ action: 'Use blue', decision: 'approved' }, { action: 'Use green', decision: 'declined', note: 'Keep it plain.' }])
        expect(text).toContain('**APPROVED** — Use blue')
        expect(text).toContain('**DECLINED** — Use green\nReason: Keep it plain.')
        expect(text).toContain('Do not perform any declined action')
    })

    it('rejects a proposed batch that could not fit a decision turn even with no notes', async () => {
        await patch(alpha, { tools: { desktopToolGrants: { requestApproval: true } } })
        const config = await readAgentConfig(alpha)
        const ctx = { agent: { id: alpha, config }, turnOrder: 'call-first' } as RunContext
        const oversized = { approvals: Array.from({ length: 6 }, (_, index) => ({ action: `${index} ` + 'x'.repeat(3600) })) }
        expect(desktopApprovalInput(oversized)).not.toBeNull()
        const tool = desktopApprovalTools(ctx, DESKTOP_FOREMAN_TURN_TEXT_LIMIT).request_approval!
        await expect(tool.execute!(oversized, options)).rejects.toThrow('decisions fit')
        await expect(tool.execute!(input, options)).resolves.toEqual(HITL_ACK_CALL_FIRST)
        await expect(desktopApprovalTools(ctx).request_approval!.execute!(oversized, options)).resolves.toEqual(HITL_ACK_CALL_FIRST)
    })

    it('rechecks a cached tool after grant revocation, disable, cancellation and configuration removal', async () => {
        await patch(alpha, { tools: { desktopToolGrants: { requestApproval: true } } })
        const approval = (await registry(alpha)).request_approval!
        await patch(alpha, { tools: { desktopToolGrants: { requestApproval: false } } })
        await expect(approval.execute!(input, options)).rejects.toThrow('turned off')
        await patch(alpha, { enabled: false, tools: { desktopToolGrants: { requestApproval: true } } })
        await expect(approval.execute!(input, options)).rejects.toThrow('turned off')
        await patch(alpha, { enabled: true })
        const controller = new AbortController()
        const cancelled = (await registry(alpha, controller.signal)).request_approval!
        controller.abort(new Error('Reply stopped'))
        await expect(cancelled.execute!(input, options)).rejects.toThrow('Reply stopped')
        await rm(agentDir(alpha), { recursive: true, force: true })
        await expect(approval.execute!(input, options)).rejects.toThrow('turned off')
        await mkdir(agentDir(alpha), { recursive: true })
    })
})

const row = (id: string, role: string, content: unknown) => ({ id, role, contentJson: JSON.stringify(content), toolCallsJson: null })
const call = (toolName = 'request_approval', raw: unknown = input) => row('approve', 'assistant', [{ type: 'tool-call', toolName, toolCallId: 'call', input: raw }])
const result = (output: unknown = { type: 'json', value: { status: 'delivered' } }) => row('result', 'tool', [{ type: 'tool-result', toolCallId: 'call', toolName: 'request_approval', output }])

describe('saved desktop approvals', () => {
    it('keeps source age out of the strict, stable decision guard', () => {
        const sourceTime = '2026-11-04T12:00:00.000Z'
        const laterTime = '2026-11-04T12:05:00.000Z'
        const pending = findDesktopApproval([{ ...call(), createdAt: sourceTime }, { ...result(), createdAt: laterTime }, { ...row('explain', 'assistant', 'Review these changes.'), createdAt: laterTime }])!
        expect(pending.requestedAt).toBe(sourceTime)
        const guard = { sourceMessageId: pending.sourceMessageId, toolCallId: pending.toolCallId, fingerprint: pending.fingerprint }
        expect(desktopApprovalGuardSchema.parse(guard)).toEqual(guard)
        expect(desktopApprovalGuardSchema.safeParse({ ...guard, requestedAt: sourceTime }).success).toBe(false)
        expect(desktopApprovalGuardSchema.safeParse({ ...guard, extra: true }).success).toBe(false)
        const corrected = findDesktopApproval([{ ...call(), createdAt: laterTime }, result()])!
        expect(corrected.requestedAt).toBe(laterTime)
        expect({ sourceMessageId: corrected.sourceMessageId, toolCallId: corrected.toolCallId, fingerprint: corrected.fingerprint }).toEqual(guard)
    })

    it('reads bounded batches, legacy singular fields, JSON arrays and nullable details with a stable canonical identity', () => {
        expect(desktopApprovalInput({ action: 'Use blue', detail: null })).toEqual({ approvals: [{ action: 'Use blue', detail: undefined }] })
        const batch = { approvals: JSON.stringify(input.approvals) }
        const approval = findDesktopApproval([row('user', 'user', 'Ask first'), call('mcp__rerun__request_approval', batch), result(), row('explanation', 'assistant', 'Please review these two changes.')])
        expect(approval).toEqual({ sourceMessageId: 'approve', toolCallId: 'call', approvals: input.approvals, fingerprint: JSON.stringify(input.approvals), requestedAt: null })
        const legacy = { ...row('approve', 'assistant', 'Review the title.'), toolCallsJson: JSON.stringify([{ id: 'call', name: 'rerun__request_approval', args: { action: 'Use blue', detail: null } }]) }
        expect(findDesktopApproval([legacy, result({ type: 'json', value: { content: [{ type: 'text', text: '{"status":"delivered"}' }], structuredContent: null } })])?.approvals)
            .toEqual([{ action: 'Use blue', detail: undefined }])
    })

    it('requires a successful acknowledgement and invalidates a request after a user or later non-skill tool', () => {
        expect(findDesktopApproval([call()])).toBeNull()
        expect(findDesktopApproval([call(), result({ type: 'error-text', value: 'Rejected' })])).toBeNull()
        expect(findDesktopApproval([call(), result({ isError: true, status: 'delivered' })])).toBeNull()
        expect(findDesktopApproval([call(), result(), row('decision', 'user', 'Approved')])).toBeNull()
        expect(findDesktopApproval([call(), result(), call('fs_read')])).toBeNull()
        expect(findDesktopApproval([call(), result(), call()])).toBeNull()
        expect(findDesktopApproval([call(), result(), call('skill_propose')])?.toolCallId).toBe('call')
    })

    it('invalidates pending state across question and approval kinds', () => {
        const question = call('ask_user', { questions: [{ question: 'Which color?' }] })
        expect(findDesktopApproval([call(), result(), question, result()])).toBeNull()
        expect(findDesktopQuestion([call(), result(), question, result()])?.toolCallId).toBe('call')
        expect(findDesktopQuestion([question, result(), call(), result()])).toBeNull()
        expect(findDesktopApproval([question, result(), call(), result()])?.toolCallId).toBe('call')
    })

    it('rejects malformed and oversized input without truncating actions or details', () => {
        for (const raw of [
            { approvals: [] }, { approvals: '{}' }, { approvals: [{ action: 17 }] },
            { approvals: [{ action: 'Use blue', detail: {} }] },
            { approvals: [{ action: 'x'.repeat(4001) }] },
            { approvals: [{ action: 'Use blue', detail: 'x'.repeat(8001) }] },
            { approvals: Array.from({ length: 21 }, () => ({ action: 'Use blue' })) },
            { approvals: Array.from({ length: 5 }, () => ({ action: 'Use blue', detail: 'x'.repeat(8000) })) },
        ]) expect(desktopApprovalInput(raw)).toBeNull()
    })
})
