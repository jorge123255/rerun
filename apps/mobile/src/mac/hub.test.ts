import { agentConversationsOverviewSchema, agentViewSchema, boardAgentSchema, boxSchema, conversationMessageSchema, conversationSchema, findPendingHitl, inboxSchema, meSchema } from '@rerun/contracts'

import type { MacClient } from './client'
import { createMacHub, messagesOf, NOT_ON_A_MAC, waitingOf } from './hub'

const CHAT = { id: 'chat-1', agentId: 'ada', title: 'Saved briefing', createdAt: '2026-11-12T18:00:00.000Z', updatedAt: '2026-11-12T18:05:00.000Z', kind: 'thread' as const }
const OLDER = { ...CHAT, id: 'chat-0', title: 'Older', updatedAt: '2026-11-11T10:00:00.000Z', kind: 'general' as const }
const READ = { chat: { ...CHAT, acceptsMessages: true }, messages: [{ id: 'm1', role: 'user' as const, createdAt: '2026-11-12T18:00:01.000Z', content: { type: 'text' as const, text: 'Hello' } }, { id: 'm2', role: 'assistant' as const, content: { type: 'text' as const, text: 'Hi there' } }] }

class Refusal extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message)
    }
}

function setup(overrides: Partial<Record<keyof MacClient, jest.Mock>> = {}) {
    const client = {
        listCoworkers: jest.fn(async () => ({ coworkers: [{ id: 'ada', name: 'Ada', status: 'enabled' }, { id: 'bo', name: 'Bo', status: 'disabled' }] })),
        listSavedChats: jest.fn(async (agentId: string) => ({ acceptsMessages: true, chats: agentId === 'ada' ? [OLDER, CHAT] : [] })),
        openSavedChat: jest.fn(async () => READ),
        readSentTurn: jest.fn(async () => ({ status: 'running' })),
        stopSentTurn: jest.fn(async () => undefined),
        ...overrides,
    }
    const onRevoked = jest.fn()
    const hub = createMacHub({ client: client as unknown as MacClient, link: { deviceId: 'device-1', workspaceId: 7 }, fail: (status, message) => new Refusal(status, message), onRevoked })
    return { hub, client, onRevoked }
}

describe('the hub paths a paired Mac answers', () => {
    it('gives the Home its coworkers, their latest chat and one Box, in the hub shapes', async () => {
        const { hub } = setup()
        const agents = boardAgentSchema.array().parse(await hub.api('/api/v1/agents'))
        expect(agents.map(agent => [agent.id, agent.status, agent.workspaceId])).toEqual([
            ['ada', 'idle', 7],
            ['bo', 'offline', 7],
        ])
        const overview = agentConversationsOverviewSchema.parse(await hub.api('/api/v1/agents/conversations'))
        expect(overview.map(row => [row.agentId, row.latest?.id ?? null])).toEqual([
            ['ada', 'chat-1'],
            ['bo', null],
        ])
        const boxes = boxSchema.array().parse(await hub.api('/api/v1/boxes'))
        expect(agents.every(agent => agent.spaceId === boxes[0].id)).toBe(true)
        expect(meSchema.parse(await hub.api('/api/v1/me')).workspace).toMatchObject({ id: 7, subscribed: true, role: 'member' })
        expect(inboxSchema.parse(await hub.api('/api/v1/inbox')).items).toEqual([])
        expect(agentViewSchema.parse(await hub.api('/api/v1/agents/ada')).agent.name).toBe('Ada')
    })

    it('reads a chat by its id alone, finding its coworker', async () => {
        const { hub, client } = setup()
        const messages = conversationMessageSchema.array().parse(await hub.api('/api/v1/conversations/chat-1/messages'))
        expect(client.openSavedChat).toHaveBeenCalledWith('ada', 'chat-1', undefined)
        expect(messages.map(message => [message.role, message.parts])).toEqual([
            ['user', [{ type: 'text', text: 'Hello' }]],
            ['assistant', [{ type: 'text', text: 'Hi there' }]],
        ])
        expect(messages[0].metadata).toEqual({ createdAt: '2026-11-12T18:00:01.000Z' })
    })

    it('says a chat waits on a question once it has read it', async () => {
        const pending = { question: { toolCallId: 'call-1', questions: [{ question: 'Which color?', options: ['Red', 'Blue'], multiple: false }] }, approval: null }
        const { hub } = setup({ openSavedChat: jest.fn(async () => ({ ...READ, pending })) })
        const before = conversationSchema.array().parse(await hub.api('/api/v1/agents/ada/conversations'))
        expect(before.find(row => row.id === 'chat-1')?.status).toBe('idle')
        await hub.api('/api/v1/conversations/chat-1/messages')
        const after = conversationSchema.array().parse(await hub.api('/api/v1/agents/ada/conversations'))
        expect(after.find(row => row.id === 'chat-1')?.status).toBe('awaiting_question')
    })

    it('follows and stops only the turn this phone started', async () => {
        const { hub, client } = setup()
        expect(await hub.api('/api/v1/conversations/chat-1/active-run')).toEqual({ runId: null })
        await hub.api('/api/v1/conversations/chat-1/stop', { method: 'POST' })
        expect(client.stopSentTurn).not.toHaveBeenCalled()

        hub.turnStarted('chat-1', 'ada', 'turn-1')
        expect(await hub.api('/api/v1/conversations/chat-1/active-run')).toEqual({ runId: 'turn-1' })
        expect(conversationSchema.array().parse(await hub.api('/api/v1/agents/ada/conversations')).find(row => row.id === 'chat-1')?.status).toBe('working')
        await hub.api('/api/v1/conversations/chat-1/stop', { method: 'POST' })
        expect(client.stopSentTurn).toHaveBeenCalledWith('ada', 'chat-1', 'turn-1', undefined)

        client.readSentTurn.mockResolvedValue({ status: 'done' })
        expect(await hub.api('/api/v1/conversations/chat-1/active-run')).toEqual({ runId: null })
    })

    it('reads a chat the person just stopped only once the Mac has stopped the turn', async () => {
        const order: string[] = []
        const { hub, client } = setup({
            stopSentTurn: jest.fn(async () => void order.push('stop')),
            readSentTurn: jest.fn(async () => (order.push('status'), { status: order.filter(step => step === 'status').length > 1 ? 'cancelled' : 'running' })),
            openSavedChat: jest.fn(async () => (order.push('read'), READ)),
        })
        await hub.api('/api/v1/agents/ada/conversations')
        hub.turnStarted('chat-1', 'ada', 'turn-1')
        const stopping = hub.api('/api/v1/conversations/chat-1/stop', { method: 'POST' })
        await Promise.all([stopping, hub.api('/api/v1/conversations/chat-1/messages')])
        expect(order).toEqual(['stop', 'status', 'status', 'read'])
        expect(client.stopSentTurn).toHaveBeenCalledTimes(1)
    })

    it('answers what a Mac does not serve with a refusal, and sends nothing', async () => {
        const { hub, client } = setup()
        for (const [path, method] of [['/api/v1/agents', 'POST'], ['/api/v1/me/account', 'DELETE'], ['/api/chat/foreman/state', 'GET'], ['/api/v1/agents/ada/files', 'GET'], ['/api/v1/agents/ada/model', 'PUT']] as const) {
            await expect(hub.api(path, { method })).rejects.toMatchObject({ status: 404, message: NOT_ON_A_MAC })
        }
        expect(Object.values(client).every(call => call.mock.calls.length === 0)).toBe(true)
    })

    it('forgets the Mac when the Mac says the phone was removed, and only then', async () => {
        const off = setup({ listCoworkers: jest.fn(async () => Promise.reject(new Refusal(401, 'unauthorized'))) })
        await expect(off.hub.api('/api/v1/agents')).rejects.toMatchObject({ status: 401 })
        expect(off.onRevoked).not.toHaveBeenCalled()

        const unreachable = setup({ listCoworkers: jest.fn(async () => Promise.reject(new TypeError('Network request failed'))) })
        await expect(unreachable.hub.api('/api/v1/agents')).rejects.toThrow('Network request failed')
        expect(unreachable.onRevoked).not.toHaveBeenCalled()

        const removed = setup({ listCoworkers: jest.fn(async () => Promise.reject(new Refusal(401, 'revoked'))) })
        await expect(removed.hub.api('/api/v1/agents')).rejects.toMatchObject({ status: 401, message: 'revoked' })
        expect(removed.onRevoked).toHaveBeenCalledTimes(1)
    })

    it('refuses a chat the Mac does not list', async () => {
        const { hub, client } = setup()
        await expect(hub.api('/api/v1/conversations/unknown/messages')).rejects.toMatchObject({ status: 404 })
        expect(client.openSavedChat).not.toHaveBeenCalled()
    })
})

describe('messagesOf', () => {
    it('puts a waiting question where the chat looks for it', () => {
        const pending = { question: { toolCallId: 'call-1', questions: [{ question: 'Which color?', options: ['Red', 'Blue'], multiple: false }] }, approval: null }
        const found = findPendingHitl(messagesOf({ ...READ, pending }))
        expect(found).toMatchObject({ kind: 'question', toolCallId: 'call-1' })
        expect(found?.input).toEqual({ questions: pending.question.questions })
    })

    it('shows a waiting approval as words, with nothing to approve it from the phone', () => {
        const pending = { question: null, approval: { toolCallId: 'call-2', approvals: [{ action: 'Send the report', detail: 'To the whole team' }, { action: 'Rename it' }] } }
        const messages = messagesOf({ ...READ, messages: READ.messages.slice(0, 1), pending }, 'Decide on your Mac')
        expect(messages).toHaveLength(2)
        expect(messages[1]).toMatchObject({ role: 'assistant', parts: [{ type: 'text', text: '**Decide on your Mac**\n\n- Send the report\n  To the whole team\n\n- Rename it' }] })
        expect(findPendingHitl(messages)).toBeNull()
        expect(waitingOf({ ...READ, pending })).toBe('awaiting_approval')
    })

    it('adds nothing to a chat that waits on nobody, or to a Mac older than the cards', () => {
        expect(findPendingHitl(messagesOf(READ))).toBeNull()
        expect(findPendingHitl(messagesOf({ ...READ, pending: { question: null, approval: null } }))).toBeNull()
    })
})
