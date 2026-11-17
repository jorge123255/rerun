import type { UIMessage, UIMessageChunk } from 'ai'

import type { ChatLink } from '@/chat/transport'

import { createMacChatTransport, replyStream, sendProblemOf } from './chat-transport'
import type { MacClient } from './client'
import type { MacHub } from './hub'

jest.mock('expo-crypto', () => ({ randomUUID: () => '11111111-1111-4111-8111-111111111111' }))

type Frame = { reset: true } | { delta: string }

async function read(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
    const chunks: UIMessageChunk[] = []
    const reader = stream.getReader()
    for (;;) {
        const { value, done } = await reader.read()
        if (done) return chunks
        chunks.push(value)
    }
}

const textOf = (chunks: UIMessageChunk[]) => chunks.flatMap(chunk => (chunk.type === 'text-delta' ? [chunk.delta] : [])).join('')

function setup({ attaches, statuses }: { attaches: Frame[][]; statuses: string[] }) {
    const client = {
        sendMessage: jest.fn(async () => ({ requestId: '11111111-1111-4111-8111-111111111111' })),
        startConversation: jest.fn(async () => 'chat-new'),
        streamSentTurn: jest.fn(async (_agent: string, _chat: string, _request: string, onFrame: (frame: Frame) => void) => {
            for (const frame of attaches.shift() ?? []) onFrame(frame)
        }),
        readSentTurn: jest.fn(async () => ({ status: statuses.shift() ?? 'done' })),
    }
    const hub = { turnStarted: jest.fn(), turnEnded: jest.fn(), rememberChat: jest.fn(), lastTurn: jest.fn(), api: jest.fn() }
    const link = { endpoints: { agentId: 'ada' }, sessionRef: { current: null as string | null }, runRef: { current: null as string | null }, callerRef: { current: null }, onSessionRef: { current: jest.fn() }, resumeOntoRef: { current: null as string | null }, reconnectFailedRef: { current: false } }
    const transport = createMacChatTransport(link as unknown as ChatLink, client as unknown as MacClient, hub as unknown as MacHub, problem => `problem:${problem}`, messages => (messages.at(-1)?.parts[0] as { text: string }).text)
    return { client, hub, link, transport }
}

const said = (text: string): UIMessage[] => [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }]
const send = (transport: ReturnType<typeof setup>['transport'], text: string) => transport.sendMessages({ trigger: 'submit-message', chatId: 'page', messageId: undefined, messages: said(text), abortSignal: undefined })

describe('a conversation with a coworker on a paired Mac', () => {
    it('starts a conversation on the Mac and streams the reply', async () => {
        const { client, hub, link, transport } = setup({ attaches: [[{ reset: true }, { delta: 'Hel' }, { delta: 'lo' }]], statuses: ['done'] })
        const chunks = await read(await send(transport, 'Hi'))
        expect(client.startConversation).toHaveBeenCalledWith('ada', { requestId: '11111111-1111-4111-8111-111111111111', text: 'Hi' }, undefined)
        expect(link.onSessionRef.current).toHaveBeenCalledWith('chat-new')
        expect(link.runRef.current).toBe('11111111-1111-4111-8111-111111111111')
        expect(hub.turnStarted).toHaveBeenCalledWith('chat-new', 'ada', '11111111-1111-4111-8111-111111111111')
        expect(chunks.map(chunk => chunk.type)).toEqual(['start', 'text-start', 'text-delta', 'text-delta', 'text-end', 'finish'])
        expect(textOf(chunks)).toBe('Hello')
        expect(hub.turnEnded).toHaveBeenCalledWith('chat-new', '11111111-1111-4111-8111-111111111111')
    })

    it('sends to the saved chat it has open', async () => {
        const { client, link, transport } = setup({ attaches: [[]], statuses: ['done'] })
        link.sessionRef.current = 'chat-1'
        await read(await send(transport, 'More'))
        expect(client.sendMessage).toHaveBeenCalledWith('ada', 'chat-1', { requestId: '11111111-1111-4111-8111-111111111111', text: 'More' }, undefined)
        expect(client.startConversation).not.toHaveBeenCalled()
        expect(link.onSessionRef.current).not.toHaveBeenCalled()
    })

    it('never shows text twice when the Mac plays the reply again', async () => {
        const { client, transport } = setup({ attaches: [[{ reset: true }, { delta: 'One ' }, { delta: 'two' }], [{ reset: true }, { delta: 'On' }, { delta: 'e two th' }, { delta: 'ree' }]], statuses: ['running', 'done'] })
        const chunks = await read(await send(transport, 'Count'))
        expect(textOf(chunks)).toBe('One two three')
        expect(client.streamSentTurn).toHaveBeenCalledTimes(2)
    })

    it('says why the Mac turned a message down', async () => {
        const refusal = (status: number, message: string) => Object.assign(new Error(message), { status })
        const { client, hub, link, transport } = setup({ attaches: [], statuses: [] })
        link.sessionRef.current = 'chat-1'
        client.sendMessage.mockRejectedValueOnce(refusal(403, 'send_not_allowed'))
        await expect(send(transport, 'Hi')).rejects.toThrow('problem:sendOff')
        expect(hub.turnStarted).not.toHaveBeenCalled()
        expect(sendProblemOf(refusal(409, 'turn_blocked'))).toBe('busy')
        expect(sendProblemOf(refusal(403, 'coworker_unavailable'))).toBe('coworkerOff')
        expect(sendProblemOf(refusal(401, 'unauthorized'))).toBe('removed')
        expect(sendProblemOf(new TypeError('Network request failed'))).toBe('unreachable')
    })

    it('picks a running turn back up on the message already on screen, and nothing else', async () => {
        const idle = setup({ attaches: [], statuses: [] })
        expect(await idle.transport.reconnectToStream({ chatId: 'page' })).toBeNull()

        const over = setup({ attaches: [], statuses: ['done'] })
        Object.assign(over.link.sessionRef, { current: 'chat-1' })
        Object.assign(over.link.runRef, { current: 'turn-1' })
        expect(await over.transport.reconnectToStream({ chatId: 'page' })).toBeNull()

        const live = setup({ attaches: [[{ reset: true }, { delta: 'Still here' }]], statuses: ['running', 'done'] })
        Object.assign(live.link.sessionRef, { current: 'chat-1' })
        Object.assign(live.link.runRef, { current: 'turn-1' })
        live.link.resumeOntoRef.current = 'message-on-screen'
        const chunks = await read((await live.transport.reconnectToStream({ chatId: 'page' }))!)
        expect(chunks[0]).toEqual({ type: 'start', messageId: 'message-on-screen' })
        expect(textOf(chunks)).toBe('Still here')
        expect(live.client.streamSentTurn).toHaveBeenCalledWith('ada', 'chat-1', 'turn-1', expect.any(Function), undefined)
    })

    it('tells a Mac that cannot be reached from a turn that is over', async () => {
        const { client, link, transport } = setup({ attaches: [], statuses: [] })
        Object.assign(link.sessionRef, { current: 'chat-1' })
        Object.assign(link.runRef, { current: 'turn-1' })
        client.readSentTurn.mockRejectedValueOnce(new TypeError('Network request failed'))
        await expect(transport.reconnectToStream({ chatId: 'page' })).rejects.toThrow('Network request failed')
        expect(link.reconnectFailedRef.current).toBe(true)
    })

    it('stops following when the person lets go of the reply', async () => {
        const controller = new AbortController()
        const { client, hub } = setup({ attaches: [], statuses: [] })
        client.streamSentTurn.mockImplementation(async (_agent, _chat, _request, onFrame) => {
            onFrame({ delta: 'Half' })
            controller.abort()
        })
        const chunks = await read(replyStream(client as unknown as MacClient, hub as unknown as MacHub, { agentId: 'ada', chatId: 'chat-1', requestId: 'turn-1' }, { signal: controller.signal }))
        expect(textOf(chunks)).toBe('Half')
        expect(client.streamSentTurn).toHaveBeenCalledTimes(1)
        expect(client.readSentTurn).not.toHaveBeenCalled()
        expect(hub.turnEnded).not.toHaveBeenCalled()
    })
})
