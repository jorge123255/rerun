import type { UIMessage, UIMessageChunk } from 'ai'

import type { ChatLink } from '@/chat/transport'

import { HITL_CANCELLED, serializeAnswers, serializeApprovalDecisions } from '@rerun/contracts'

import { answerOf, createMacChatTransport, decisionsOf, replyStream, sendProblemOf } from './chat-transport'
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
        answerQuestion: jest.fn(async () => ({ requestId: '11111111-1111-4111-8111-111111111111' })),
        decideApproval: jest.fn(async () => ({ requestId: '11111111-1111-4111-8111-111111111111' })),
        startConversation: jest.fn(async () => 'chat-new'),
        streamSentTurn: jest.fn(async (_agent: string, _chat: string, _request: string, onFrame: (frame: Frame) => void) => {
            for (const frame of attaches.shift() ?? []) onFrame(frame)
        }),
        readSentTurn: jest.fn(async () => ({ status: statuses.shift() ?? 'done' })),
    }
    const hub = { turnStarted: jest.fn(), turnEnded: jest.fn(), rememberChat: jest.fn(), lastTurn: jest.fn(), api: jest.fn(), waitingQuestion: jest.fn((): unknown => null), waitingApproval: jest.fn((): unknown => null) }
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

    it('keeps following a reply when the Mac is slow to say how the turn stands', async () => {
        const busy = () => Object.assign(new Error('unavailable'), { status: 502 })
        const { client, transport } = setup({ attaches: [[{ reset: true }, { delta: 'Slow ' }], [{ reset: true }, { delta: 'Slow but' }], [{ reset: true }, { delta: 'Slow but sure' }]], statuses: [] })
        client.readSentTurn.mockRejectedValueOnce(busy()).mockRejectedValueOnce(new TypeError('Network request failed')).mockResolvedValueOnce({ status: 'done' })
        const chunks = await read(await send(transport, 'Hi'))
        expect(textOf(chunks)).toBe('Slow but sure')
        expect(chunks.at(-1)).toEqual({ type: 'finish' })
    })

    it('gives a reply up when the Mac refuses, or stays silent for too long', async () => {
        const refused = setup({ attaches: [], statuses: [] })
        refused.client.readSentTurn.mockRejectedValue(Object.assign(new Error('revoked'), { status: 401 }))
        await expect(read(await send(refused.transport, 'Hi'))).rejects.toThrow('revoked')
        expect(refused.client.readSentTurn).toHaveBeenCalledTimes(1)

        const silent = setup({ attaches: [], statuses: [] })
        silent.client.readSentTurn.mockRejectedValue(Object.assign(new Error('unavailable'), { status: 502 }))
        await expect(read(await send(silent.transport, 'Hi'))).rejects.toThrow('unavailable')
        expect(silent.client.readSentTurn).toHaveBeenCalledTimes(6)
    })

    it('answers a waiting question as an answer, naming the card and the choices', async () => {
        const { client, hub, link, transport } = setup({ attaches: [[]], statuses: ['done'] })
        link.sessionRef.current = 'chat-1'
        hub.waitingQuestion.mockReturnValue({ toolCallId: 'call-1', questions: [{ question: 'Which fruit?', options: ['Apple', 'Pear'], multiple: false }, { question: 'Which days?', options: ['Mon', 'Tue', 'Wed'], multiple: true }] })
        await read(await send(transport, serializeAnswers([{ question: 'Which fruit?', answers: ['Pear'] }, { question: 'Which days?', answers: ['Mon', 'Wed'] }])))
        expect(client.answerQuestion).toHaveBeenCalledWith('ada', 'chat-1', { requestId: '11111111-1111-4111-8111-111111111111', toolCallId: 'call-1', answers: [['Pear'], ['Mon', 'Wed']] }, undefined)
        expect(client.sendMessage).not.toHaveBeenCalled()
        expect(hub.turnStarted).toHaveBeenCalledWith('chat-1', 'ada', '11111111-1111-4111-8111-111111111111')
    })

    it('dismisses a waiting question without choices, and sends nothing else while it waits', async () => {
        const { client, hub, link, transport } = setup({ attaches: [[]], statuses: ['done'] })
        link.sessionRef.current = 'chat-1'
        hub.waitingQuestion.mockReturnValue({ toolCallId: 'call-1', questions: [{ question: 'Which fruit?', options: [], multiple: false }] })
        await read(await send(transport, HITL_CANCELLED.question))
        expect(client.answerQuestion).toHaveBeenCalledWith('ada', 'chat-1', { requestId: '11111111-1111-4111-8111-111111111111', toolCallId: 'call-1' }, undefined)

        await expect(send(transport, 'Never mind, do something else')).rejects.toThrow('problem:answerFirst')
        await expect(send(transport, serializeAnswers([{ question: 'A', answers: ['1'] }, { question: 'B', answers: ['2'] }]))).rejects.toThrow('problem:answerFirst')
        expect(client.sendMessage).not.toHaveBeenCalled()
        expect(client.answerQuestion).toHaveBeenCalledTimes(1)
        expect(answerOf(serializeAnswers([{ question: 'Which fruit?', answers: [] }]), 1)).toEqual({ answers: [[]] })
    })

    it('sends the decisions on a waiting approval as decisions, one for each action', async () => {
        const { client, hub, link, transport } = setup({ attaches: [[]], statuses: ['done'] })
        link.sessionRef.current = 'chat-1'
        const approvals = [{ action: 'Email invoice 1042', detail: 'Total 120.00' }, { action: 'Archive the thread' }]
        hub.waitingApproval.mockReturnValue({ toolCallId: 'call-9', approvals })
        await read(await send(transport, serializeApprovalDecisions([{ ...approvals[0], decision: 'approved' }, { ...approvals[1], decision: 'declined', note: 'Keep it' }])))
        expect(client.decideApproval).toHaveBeenCalledWith('ada', 'chat-1', { requestId: '11111111-1111-4111-8111-111111111111', toolCallId: 'call-9', decisions: [{ decision: 'approved' }, { decision: 'declined', note: 'Keep it' }] }, undefined)
        expect(client.sendMessage).not.toHaveBeenCalled()
    })

    it('never passes anything else off as a decision', async () => {
        const { client, hub, link, transport } = setup({ attaches: [], statuses: [] })
        link.sessionRef.current = 'chat-1'
        const approvals = [{ action: 'Email invoice 1042' }, { action: 'Archive the thread' }]
        hub.waitingApproval.mockReturnValue({ toolCallId: 'call-9', approvals })
        for (const text of ['approve', 'yes, do it', serializeApprovalDecisions([{ action: 'Email invoice 1042', decision: 'approved' }]), serializeApprovalDecisions([{ action: 'Delete everything', decision: 'approved' }, { action: 'Archive the thread', decision: 'approved' }])]) {
            await expect(send(transport, text)).rejects.toThrow('problem:answerFirst')
        }
        expect(client.decideApproval).not.toHaveBeenCalled()
        expect(client.sendMessage).not.toHaveBeenCalled()
        expect(decisionsOf(serializeApprovalDecisions([{ action: 'Email invoice 1042', decision: 'declined' }]), [{ action: 'Email invoice 1042' }])).toEqual([{ decision: 'declined' }])
        client.decideApproval.mockRejectedValueOnce(Object.assign(new Error('approve_not_allowed'), { status: 403 }))
        await expect(send(transport, serializeApprovalDecisions(approvals.map(item => ({ ...item, decision: 'approved' as const }))))).rejects.toThrow('problem:approveOff')
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

describe('the reply stream after the chat let go of it', () => {
    it('takes no more text, and ends without a word, once it was cancelled', async () => {
        let push: ((frame: Frame) => void) | null = null
        let finish: () => void = () => {}
        const { client, hub } = setup({ attaches: [], statuses: ['done'] })
        client.streamSentTurn.mockImplementation(async (_agent, _chat, _request, onFrame) => {
            push = onFrame
            await new Promise<void>(resolve => (finish = resolve))
        })
        const stream = replyStream(client as unknown as MacClient, hub as unknown as MacHub, { agentId: 'ada', chatId: 'chat-1', requestId: 'turn-1' }, {})
        const reader = stream.getReader()
        expect((await reader.read()).value).toEqual({ type: 'start' })
        await new Promise(resolve => setTimeout(resolve, 0))
        await reader.cancel()
        // The Mac still sends what it had, and the turn then ends: nothing throws.
        expect(() => push?.({ delta: 'late' })).not.toThrow()
        finish()
        await new Promise(resolve => setTimeout(resolve, 10))
        expect(client.readSentTurn).toHaveBeenCalledTimes(1)
    })
})

const CHIEF_GENERAL = 'fmc_11111111-1111-4111-8111-111111111111'
const CHIEF_THREAD = 'fmc_22222222-2222-4222-8222-222222222222'

function chiefSetup({ general, chatId = null }: { general: boolean; chatId?: string | null }) {
    const base = setup({ attaches: [[{ reset: true }, { delta: 'On it' }]], statuses: ['done'] })
    const client = Object.assign(base.client, {
        sendToChief: jest.fn(async (message: { chatId?: string; thread?: boolean }) => message.chatId ?? (message.thread ? CHIEF_THREAD : CHIEF_GENERAL)),
        answerChief: jest.fn(async () => ({ requestId: '11111111-1111-4111-8111-111111111111' })),
        streamChiefTurn: jest.fn(async (_chat: string, _request: string, onFrame: (frame: Frame) => void) => {
            onFrame({ reset: true })
            onFrame({ delta: 'On it' })
        }),
        readChiefTurn: jest.fn(async () => ({ status: 'done' })),
    })
    const link = { ...base.link, endpoints: { agentId: 'foreman', sendBody: (sessionId: string | null, text: string) => ({ sessionId, kind: general ? 'general' : 'thread', text }) }, sessionRef: { current: chatId } }
    const transport = createMacChatTransport(link as unknown as ChatLink, client as unknown as MacClient, base.hub as unknown as MacHub, problem => `problem:${problem}`, messages => (messages.at(-1)?.parts[0] as { text: string }).text)
    return { client, hub: base.hub, link, transport }
}

describe('the Chief of Staff on a paired Mac', () => {
    it('sends General\'s first message to General, and follows the reply through its own entries', async () => {
        const { client, hub, link, transport } = chiefSetup({ general: true })
        const chunks = await read(await send(transport, 'Plan the week'))
        expect(client.sendToChief).toHaveBeenCalledWith({ requestId: '11111111-1111-4111-8111-111111111111', text: 'Plan the week' }, undefined)
        expect(link.onSessionRef.current).toHaveBeenCalledWith(CHIEF_GENERAL)
        expect(hub.turnStarted).toHaveBeenCalledWith(CHIEF_GENERAL, 'foreman', '11111111-1111-4111-8111-111111111111')
        expect(textOf(chunks)).toBe('On it')
        expect(client.streamChiefTurn).toHaveBeenCalledWith(CHIEF_GENERAL, '11111111-1111-4111-8111-111111111111', expect.any(Function), undefined)
        expect(client.readChiefTurn).toHaveBeenCalledWith(CHIEF_GENERAL, '11111111-1111-4111-8111-111111111111', undefined)
        expect(client.startConversation).not.toHaveBeenCalled()
        expect(client.streamSentTurn).not.toHaveBeenCalled()
    })

    it('starts a task thread from a new page, and writes in the conversation it has open', async () => {
        const fresh = chiefSetup({ general: false })
        await read(await send(fresh.transport, 'Plan the launch'))
        expect(fresh.client.sendToChief).toHaveBeenCalledWith({ requestId: '11111111-1111-4111-8111-111111111111', text: 'Plan the launch', thread: true }, undefined)
        expect(fresh.link.onSessionRef.current).toHaveBeenCalledWith(CHIEF_THREAD)

        const open = chiefSetup({ general: false, chatId: CHIEF_THREAD })
        await read(await send(open.transport, 'And then?'))
        expect(open.client.sendToChief).toHaveBeenCalledWith({ requestId: '11111111-1111-4111-8111-111111111111', text: 'And then?', chatId: CHIEF_THREAD }, undefined)
    })

    it('answers its question card through the Mac\'s answer path, and sends nothing else while it waits', async () => {
        const { client, hub, transport } = chiefSetup({ general: true, chatId: CHIEF_GENERAL })
        hub.waitingQuestion.mockReturnValue({ toolCallId: 'call-chief', questions: [{ question: 'Which team?', options: ['Sales', 'Support'], multiple: false }] })
        await read(await send(transport, serializeAnswers([{ question: 'Which team?', answers: ['Sales'] }])))
        expect(client.answerChief).toHaveBeenCalledWith(CHIEF_GENERAL, { requestId: '11111111-1111-4111-8111-111111111111', toolCallId: 'call-chief', answers: [['Sales']] }, undefined)
        await expect(send(transport, 'Something else')).rejects.toThrow('problem:answerFirst')
        expect(client.sendToChief).not.toHaveBeenCalled()
        expect(client.answerQuestion).not.toHaveBeenCalled()
    })

    it('never decides an approval of the Chief of Staff, whatever this phone may approve for coworkers', async () => {
        const { client, hub, transport } = chiefSetup({ general: true, chatId: CHIEF_GENERAL })
        hub.waitingApproval.mockReturnValue({ toolCallId: 'call-approve', approvals: [{ action: 'Create Mara' }] })
        await read(await send(transport, serializeApprovalDecisions([{ action: 'Create Mara', decision: 'approved' }])))
        expect(client.decideApproval).not.toHaveBeenCalled()
        expect(hub.waitingApproval).not.toHaveBeenCalled()
    })

    it('says why the Mac turned a message down, and sends one it did not confirm again under the same id', async () => {
        const crypto = jest.requireMock('expo-crypto') as { randomUUID: () => string }
        const fixed = crypto.randomUUID
        let next = 0
        crypto.randomUUID = () => `00000000-0000-4000-8000-00000000000${next++}`
        const { client, transport } = chiefSetup({ general: true, chatId: CHIEF_GENERAL })
        client.sendToChief.mockRejectedValueOnce(Object.assign(new Error('send_not_allowed'), { status: 403 }))
        await expect(send(transport, 'Hi')).rejects.toThrow('problem:sendOff')
        client.sendToChief.mockRejectedValueOnce(Object.assign(new Error('Wait for the current message'), { status: 409 }))
        await expect(send(transport, 'Hi')).rejects.toThrow('problem:chiefBusy')
        client.sendToChief.mockRejectedValueOnce(new TypeError('Network request failed'))
        await expect(send(transport, 'Hi')).rejects.toThrow('problem:unreachable')
        await read(await send(transport, 'Hi'))
        const ids = client.sendToChief.mock.calls.map(call => (call[0] as { requestId: string }).requestId)
        expect(ids).toHaveLength(4)
        expect(new Set(ids).size).toBe(1)
        // Once confirmed, the next message is a new one.
        await read(await send(transport, 'Hi'))
        expect((client.sendToChief.mock.calls.at(-1)?.[0] as { requestId: string }).requestId).not.toBe(ids[0])
        crypto.randomUUID = fixed
        expect(sendProblemOf(Object.assign(new Error('x'), { status: 409 }))).toBe('busy')
    })
})
