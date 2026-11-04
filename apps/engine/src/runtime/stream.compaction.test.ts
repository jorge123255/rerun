import { afterEach, describe, expect, it, vi } from 'vitest'
import { AbstractChat, DefaultChatTransport, streamText, type ChatState, type UIMessage } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import type { AgentRun } from './loop.js'
import { mergeRunStream } from './run-stream-merge.js'
import { resumeStreamResponse, toResumableStreamResponse } from './stream.js'

class SDKChat extends AbstractChat<UIMessage> {}

function chatFor(response: () => Response, messages: UIMessage[] = []) {
    // Like ReactChatState, replacements snapshot the message. Without this, mutating the SDK's
    // provisional ID also mutates the already-rendered row and conceals the duplicate-row bug.
    const state: ChatState<UIMessage> = {
        status: 'ready',
        error: undefined,
        messages,
        pushMessage(message) { this.messages = this.messages.concat(message) },
        popMessage() { this.messages = this.messages.slice(0, -1) },
        replaceMessage(index, message) {
            this.messages = [...this.messages.slice(0, index), this.snapshot(message), ...this.messages.slice(index + 1)]
        },
        snapshot: value => structuredClone(value),
    }
    let nextId = 0
    return new SDKChat({
        id: 'compaction-chat',
        generateId: () => `provisional-${++nextId}`,
        state,
        transport: new DefaultChatTransport({ api: 'http://engine.test/chat', fetch: async () => response() }),
    })
}

function gate() {
    let release!: () => void
    const promise = new Promise<void>(resolve => { release = resolve })
    return { promise, release }
}

function providerRun(runId: string): AgentRun {
    // Use the actual SDK producer as well as its Chat consumer: toUIMessageStream must suppress
    // its own later start, not merely receive a sendStart option in a mocked assertion.
    const result = streamText({
        model: new MockLanguageModelV3({
            doStream: async () => ({
                stream: new ReadableStream({
                    start(controller) {
                        controller.enqueue({ type: 'stream-start', warnings: [] })
                        controller.enqueue({ type: 'text-start', id: 'reply' })
                        controller.enqueue({ type: 'text-delta', id: 'reply', delta: 'The real reply is preserved.' })
                        controller.enqueue({ type: 'text-end', id: 'reply' })
                        controller.enqueue({
                            type: 'finish',
                            finishReason: { unified: 'stop', raw: 'stop' },
                            usage: {
                                inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
                                outputTokens: { total: 2, text: 2, reasoning: 0 },
                            },
                        })
                        controller.close()
                    },
                }),
            }),
        }),
        prompt: 'Continue after compacting the history.',
    })
    return { runId, result, settled: Promise.resolve({ kind: 'done' }) }
}

const assistants = (chat: SDKChat) => chat.messages.filter(message => message.role === 'assistant')
const compactions = (chat: SDKChat) => assistants(chat).flatMap(message => message.parts.filter(part => part.type === 'data-compaction'))
const done = { status: 'done', messagesCompacted: 8, tokensRecovered: 79_915 }
const meta = { provider: 'test', model: 'stream-test' }

afterEach(() => vi.unstubAllEnvs())

describe('desktop compaction stream identity', () => {
    it('keeps pre-provider running, done, and reply events in one SDK assistant message, including replay', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        const runId = 'desktop-compaction-identity'
        const finishCompaction = gate()
        const startProvider = gate()
        const chat = chatFor(() => toResumableStreamResponse(runId, async writer => {
            writer.write({ type: 'data-compaction', id: 'checkpoint-1', data: { status: 'running' } })
            await finishCompaction.promise
            writer.write({ type: 'data-compaction', id: 'checkpoint-1', data: done })
            await startProvider.promise
            mergeRunStream(writer, providerRun(runId), meta)
        }))
        const sending = chat.sendMessage({ text: 'Continue.' })
        try {
            await vi.waitFor(() => expect(compactions(chat)).toEqual([
                { type: 'data-compaction', id: 'checkpoint-1', data: { status: 'running' } },
            ]))
            finishCompaction.release()
            await vi.waitFor(() => expect(compactions(chat)).toEqual([
                { type: 'data-compaction', id: 'checkpoint-1', data: done },
            ]))
        } finally {
            finishCompaction.release()
            startProvider.release()
            await sending
        }

        expect(chat.status).toBe('ready')
        expect(assistants(chat)).toHaveLength(1)
        expect(assistants(chat)[0]).toMatchObject({ id: runId, metadata: { ...meta, usage: { inputTokens: 3, outputTokens: 2 } } })
        expect(compactions(chat)).toEqual([{ type: 'data-compaction', id: 'checkpoint-1', data: done }])
        expect(assistants(chat)[0].parts.filter(part => part.type === 'text')).toEqual([
            { type: 'text', text: 'The real reply is preserved.', state: 'done' },
        ])
        expect(chat.messages.filter(message => message.role === 'user')).toHaveLength(1)

        const replay = chatFor(() => resumeStreamResponse(runId), structuredClone(chat.messages.filter(message => message.role === 'user')))
        await replay.resumeStream()
        expect(replay.status).toBe('ready')
        expect(replay.messages).toEqual(chat.messages)
    })

    it('keeps an early failure on the same desktop message without inventing a provider reply', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '1')
        const runId = 'desktop-compaction-early-error'
        const chat = chatFor(() => toResumableStreamResponse(runId, async writer => {
            writer.write({ type: 'data-compaction', id: 'checkpoint-error', data: { status: 'running' } })
            writer.write({ type: 'data-compaction', id: 'checkpoint-error', data: { status: 'error' } })
            throw new Error('Could not prepare this turn.')
        }))

        await chat.sendMessage({ text: 'Continue.' })

        expect(chat.status).toBe('error')
        expect(chat.error?.message).toBe('Could not prepare this turn.')
        expect(assistants(chat)).toHaveLength(1)
        expect(assistants(chat)[0].id).toBe(runId)
        expect(assistants(chat)[0].parts).toEqual([
            { type: 'data-compaction', id: 'checkpoint-error', data: { status: 'error' } },
        ])
    })

    it('leaves hosted message identity and provider start behavior unchanged', async () => {
        vi.stubEnv('RERUN_DESKTOP_APP', '0')
        const runId = 'hosted-provider-start'
        const chat = chatFor(() => toResumableStreamResponse(runId, async writer => {
            mergeRunStream(writer, providerRun(runId), meta)
        }))

        await chat.sendMessage({ text: 'Continue.' })

        expect(chat.status).toBe('ready')
        expect(assistants(chat)).toHaveLength(1)
        expect(assistants(chat)[0].id).not.toBe(runId)
        expect(assistants(chat)[0].parts.filter(part => part.type === 'text')).toEqual([
            { type: 'text', text: 'The real reply is preserved.', state: 'done' },
        ])
    })
})
