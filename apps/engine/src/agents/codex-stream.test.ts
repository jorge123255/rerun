import { describe, expect, it } from 'vitest'
import { codexMcpCompatibilityMiddleware, normalizeCodexGeneratePart, normalizeCodexStreamPart } from './codex-stream.js'

const envelope = (overrides: Record<string, unknown> = {}) => ({
    type: 'mcpToolCall',
    id: 'call-1',
    server: 'rerun',
    tool: 'ask_user',
    status: 'completed',
    arguments: { questions: [{ question: 'Ready?' }] },
    result: { content: [{ type: 'text', text: JSON.stringify({ status: 'delivered' }) }], structuredContent: null },
    ...overrides,
})

describe('Codex MCP stream compatibility', () => {
    it('unwraps input deltas and complete tool calls', () => {
        const raw = JSON.stringify(envelope())
        expect(normalizeCodexStreamPart({ type: 'tool-input-delta', id: 'call-1', delta: raw } as any)).toMatchObject({
            type: 'tool-input-delta',
            delta: JSON.stringify({ questions: [{ question: 'Ready?' }] }),
        })
        expect(
            normalizeCodexStreamPart({ type: 'tool-call', toolCallId: 'call-1', toolName: 'mcp__rerun__ask_user', input: raw, providerExecuted: true } as any),
        ).toMatchObject({
            toolName: 'ask_user',
            input: JSON.stringify({ questions: [{ question: 'Ready?' }] }),
            providerExecuted: true,
        })
    })

    it('keeps the exact text of a file even when it is valid JSON', () => {
        const text = ' { "number" : 1234 }\n'
        const result = envelope({ tool: 'fs_read', result: { content: [{ type: 'text', text }], structuredContent: null } })
        const part = { type: 'tool-result', toolCallId: 'read-id', toolName: 'mcp__rerun__fs_read', result } as any
        expect(normalizeCodexStreamPart(part)).toMatchObject({ result: text, toolName: 'fs_read' })
        expect(normalizeCodexGeneratePart(part)).toMatchObject({ result: text, toolName: 'fs_read' })
    })

    it('prefers structured content and otherwise parses a single JSON text result', () => {
        const structured = envelope({ result: { structuredContent: { results: [{ slug: 'notion' }] }, content: [] } })
        expect(normalizeCodexStreamPart({ type: 'tool-result', toolCallId: 'call-1', toolName: 'mcp__rerun__rerun_hub_service_search', result: structured } as any)).toMatchObject({
            toolName: 'rerun_hub_service_search',
            result: { results: [{ slug: 'notion' }] },
        })

        expect(normalizeCodexStreamPart({ type: 'tool-result', toolCallId: 'call-1', toolName: 'mcp__rerun__ask_user', result: envelope(), isError: true } as any)).toMatchObject({
            toolName: 'ask_user',
            result: { status: 'delivered' },
            isError: true,
        })
    })

    it('preserves preliminary results, metadata, external MCP names, and unknown payloads', () => {
        const preliminary = { type: 'tool-result', toolCallId: 'call-1', toolName: 'mcp__rerun__shell_exec', result: { type: 'output-delta', delta: 'x' }, preliminary: true, providerMetadata: { codex: { item: 1 } } }
        expect(normalizeCodexStreamPart(preliminary as any)).toEqual({ ...preliminary, toolName: 'shell_exec' })

        const external = { type: 'tool-call', toolCallId: 'call-2', toolName: 'mcp__google-drive__gdrive_search', input: JSON.stringify(envelope({ server: 'google-drive' })) }
        expect(normalizeCodexStreamPart(external as any)).toMatchObject({
            toolName: 'mcp__google-drive__gdrive_search',
            input: JSON.stringify({ questions: [{ question: 'Ready?' }] }),
        })

        const native = { type: 'tool-call', toolCallId: 'call-3', toolName: 'exec', input: JSON.stringify({ type: 'commandExecution', command: 'pwd' }) }
        expect(normalizeCodexStreamPart(native as any)).toEqual(native)
        const invalid = { type: 'tool-input-delta', id: 'call-4', delta: '{not-json' }
        expect(normalizeCodexStreamPart(invalid as any)).toEqual(invalid)
    })

    it('preserves non-JSON and multi-part MCP results instead of dropping content', () => {
        const text = envelope({ result: { content: [{ type: 'text', text: 'plain result' }], structuredContent: null } })
        expect(normalizeCodexStreamPart({ type: 'tool-result', toolCallId: 'call-1', toolName: 'mcp__rerun__notify_user', result: text } as any)).toMatchObject({ result: 'plain result' })

        const multi = { content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], structuredContent: null }
        const wrapped = envelope({ result: multi })
        expect(normalizeCodexStreamPart({ type: 'tool-result', toolCallId: 'call-1', toolName: 'mcp__rerun__notify_user', result: wrapped } as any)).toMatchObject({ result: multi })
    })

    it('normalizes generated content and the middleware stream without changing unrelated parts', async () => {
        const raw = JSON.stringify(envelope())
        expect(normalizeCodexGeneratePart({ type: 'tool-call', toolCallId: 'call-1', toolName: 'rerun__ask_user', input: raw } as any)).toMatchObject({
            toolName: 'ask_user',
            input: JSON.stringify({ questions: [{ question: 'Ready?' }] }),
        })

        const wrapStream = codexMcpCompatibilityMiddleware.wrapStream!
        const result = await wrapStream({
            doStream: async () => ({
                stream: new ReadableStream({
                    start(controller) {
                        controller.enqueue({ type: 'tool-input-delta', id: 'call-1', delta: raw })
                        controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'hello' })
                        controller.close()
                    },
                }),
            }),
        } as any)
        const parts = []
        for await (const part of result.stream) parts.push(part)
        expect(parts[0]).toMatchObject({ delta: JSON.stringify({ questions: [{ question: 'Ready?' }] }) })
        expect(parts[1]).toEqual({ type: 'text-delta', id: 'text-1', delta: 'hello' })

        const generated = await codexMcpCompatibilityMiddleware.wrapGenerate!({
            doGenerate: async () => ({
                content: [
                    { type: 'tool-call', toolCallId: 'call-1', toolName: 'mcp__rerun__ask_user', input: raw },
                    { type: 'text', text: 'unchanged' },
                ],
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
                warnings: [],
            }),
        } as any)
        expect(generated.content[0]).toMatchObject({
            toolName: 'ask_user',
            input: JSON.stringify({ questions: [{ question: 'Ready?' }] }),
        })
        expect(generated.content[1]).toEqual({ type: 'text', text: 'unchanged' })
    })
})
