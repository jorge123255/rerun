import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText } from 'ai'
import { expect, it } from 'vitest'
import type { RunContext } from '../context.js'

process.env.RERUN_DATA_DIR = mkdtempSync(join(tmpdir(), 'rerun-fork-replay-'))
const { prepareRunHistory } = await import('./compact.js')
const { createSession } = await import('../../db/repos/sessions.js')
const { appendMessage, listMessages } = await import('../../db/repos/messages.js')
const { forkReply } = await import('../../db/repos/regenerations.js')

it('replays a copied prefix with the actual OpenAI Responses adapter even if the source item references expired', async () => {
    const agent = 'drafts'
    const scope = (sessionId: string) => ({ agent: { id: agent }, sessionId, model: 'fixture', provider: 'openai' } as RunContext)
    const source = await createSession(agent)
    await appendMessage(agent, source.id, { role: 'user', content: 'Find the sketch' })
    const oldId = { openai: { itemId: 'expired_source_item', phase: 'final_answer' } }
    await appendMessage(agent, source.id, { role: 'assistant', content: [
        { type: 'reasoning', text: 'hidden reasoning' },
        { type: 'text', text: 'Earlier visible response', providerOptions: oldId },
        { type: 'tool-call', toolCallId: 'local_call', toolName: 'lookup', input: { name: 'plan' }, providerOptions: oldId },
    ] })
    await appendMessage(agent, source.id, { role: 'tool', content: [
        { type: 'tool-result', toolCallId: 'local_call', toolName: 'lookup', output: { type: 'text', value: 'Orange' }, providerOptions: oldId },
    ] })
    await appendMessage(agent, source.id, { role: 'user', content: 'Review that sketch' })
    const answer = await appendMessage(agent, source.id, { role: 'assistant', content: 'Original selected answer' })

    const requests: Array<Array<Record<string, unknown>>> = []
    const model = createOpenAI({ apiKey: 'local-fixture', fetch: async (_url, init) => {
        const { input } = JSON.parse(String(init?.body))
        requests.push(input)
        if (input.some((item: { type?: string; id?: string }) => item.type === 'item_reference' && item.id === 'expired_source_item')) {
            return Response.json({ error: { message: 'Item no longer exists' } }, { status: 400 })
        }
        return Response.json({
            id: 'resp_fixture', created_at: 100, model: 'gpt-test', status: 'completed',
            output: [{ type: 'message', id: 'msg_current', role: 'assistant', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }],
        })
    } }).responses('gpt-test')
    const send = async (sessionId: string) => generateText({ model, messages: await prepareRunHistory(scope(sessionId), 'system'), maxRetries: 0 })

    await expect(send(source.id)).rejects.toThrow('Item no longer exists')
    expect(requests[0]).toContainEqual({ type: 'item_reference', id: 'expired_source_item' })

    const fork = await forkReply(agent, source, { sessionId: source.id, regenerateMessageId: answer.id, requestId: crypto.randomUUID() })
    expect((await send(fork.sessionId)).text).toBe('ok')
    expect(requests[1]).toContainEqual({ role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Earlier visible response' }] })
    expect(requests[1]).toContainEqual(expect.objectContaining({ type: 'function_call', call_id: 'local_call', name: 'lookup' }))
    expect(requests[1]).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'local_call', output: 'Orange' }))
    expect(JSON.stringify(requests[1])).not.toMatch(/hidden reasoning|expired_source_item|Original selected answer/)

    await appendMessage(agent, fork.sessionId, { role: 'assistant', content: [{ type: 'text', text: 'ok', providerOptions: { openai: { itemId: 'msg_current' } } }] })
    await appendMessage(agent, fork.sessionId, { role: 'user', content: 'Next question' })
    expect((await send(fork.sessionId)).text).toBe('ok')
    expect(requests[2]).toContainEqual({ type: 'item_reference', id: 'msg_current' })
    expect(JSON.stringify(requests[2])).toContain('Earlier visible response')
    for (const id of [source.id, fork.sessionId]) {
        const stored = (await listMessages(agent, id))[1].contentJson
        expect(stored).toContain('expired_source_item')
        expect(stored).toContain('hidden reasoning')
    }
})
