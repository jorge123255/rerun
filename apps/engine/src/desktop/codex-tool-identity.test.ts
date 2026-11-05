import { createLocalMcpServer, tool } from 'ai-sdk-provider-codex-cli'
import { z } from 'zod'
import { expect, test } from 'vitest'

test('Codex MCP preserves transport call identity through parsing and concurrent identical inputs', async () => {
    const observed: Array<{ value: string; id: string | undefined }> = []
    const server = await createLocalMcpServer({ name: 'identity', tools: [tool({
        name: 'echo', description: 'Identity fixture', parameters: z.object({ value: z.string() }),
        execute: async (input, context) => {
            observed.push({ value: input.value, id: context?.toolCallId })
            return context?.toolCallId ?? 'missing'
        },
    })] })
    const call = async (requestId: number, meta?: unknown, extra = {}) => {
        const response = await fetch(server.url, { method: 'POST', headers: { Authorization: `Bearer ${server.config.bearerToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({
            jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name: 'echo', arguments: { value: 'same', ...extra }, ...(meta === undefined ? {} : { _meta: meta }) },
        }) })
        return response.json()
    }
    try {
        const results = await Promise.all([call(2, { callId: 'call-a' }), call(2, { callId: 'call-b' })])
        expect(results.map(r => r.result.content[0].text)).toEqual(['call-a', 'call-b'])
        expect(observed).toEqual(expect.arrayContaining([{ value: 'same', id: 'call-a' }, { value: 'same', id: 'call-b' }]))
        for (const meta of [undefined, { callId: 7 }, { callId: '' }, { callId: ' ' }, { callId: 'x'.repeat(257) }]) {
            const result = await call(99, meta, { callId: 'argument-spoof', _meta: { callId: 'nested-spoof' } })
            expect(result.result.content[0].text).toBe('missing')
            expect(observed.at(-1)).toEqual({ value: 'same', id: undefined })
        }
    } finally { await server.stop() }
})
