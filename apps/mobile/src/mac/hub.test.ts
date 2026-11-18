import { foremanEngineConversationSchema, foremanEngineFilesSchema, foremanEngineMessagesSchema, foremanStateSchema, agentConversationsOverviewSchema, agentViewSchema, boardAgentSchema, boxSchema, conversationMessageSchema, conversationSchema, findPendingHitl, inboxSchema, meSchema } from '@rerun/contracts'

import type { MacPhoneCoworkerSettingsChange } from '@rerun/mac-contracts/mac-phone-pairing'

import type { MacClient } from './client'
import { chiefMessagesOf, createMacHub, messagesOf, NOT_ON_A_MAC, waitingOf } from './hub'

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
    it('passes only a settings refusal’s public message through to the coworker settings page', async () => {
        const message = 'Stop this coworker’s current reply before editing its tools.'
        const refusal = Object.assign(new Error('settings_refused'), { status: 409, body: { error: 'settings_refused', message } })
        const read = jest.fn().mockRejectedValueOnce(refusal)
        const change = jest.fn().mockRejectedValueOnce(refusal)
        const { hub, onRevoked } = setup({ readCoworkerSettings: read, changeCoworkerSettings: change })
        const body = { field: 'enabled' as const, body: { enabled: false } }
        await expect(hub.readCoworkerSettings('ada')).rejects.toMatchObject({ message, status: 409 })
        await expect(hub.changeCoworkerSettings('ada', body)).rejects.toMatchObject({ message, status: 409 })
        expect(change).toHaveBeenCalledWith('ada', body, undefined)
        expect(onRevoked).not.toHaveBeenCalled()
        change.mockRejectedValueOnce(Object.assign(new Error('settings_not_allowed'), { status: 403, body: { message: 'unvetted error details' } }))
        await expect(hub.changeCoworkerSettings('ada', body)).rejects.toMatchObject({ message: 'settings_not_allowed' })
        change.mockRejectedValueOnce(Object.assign(new Error('revoked'), { status: 401 }))
        await expect(hub.changeCoworkerSettings('ada', body)).rejects.toMatchObject({ message: 'revoked' })
        expect(onRevoked).toHaveBeenCalledTimes(1)
    })

    it.each(['setup', 'box'] as const)('reuses exactly the pending %s request on ambiguity, then retires it on admission or refusal', async field => {
        const send = jest.fn()
        const { hub } = setup({ changeCoworkerSettings: send })
        const edit = (requestId: string, revision = 3): MacPhoneCoworkerSettingsChange => field === 'setup'
            ? { field, body: { requestId, action: 'start', expectedRevision: 'saved-' + revision } }
            : { field, body: { requestId, spaceId: 'reports', expectedRevision: revision } }
        send.mockRejectedValueOnce(new Refusal(503, 'unavailable'))
        await expect(hub.changeCoworkerSettings('ada', edit('first'))).rejects.toThrow()
        expect(hub.unconfirmedSettingsChange('ada', field)).toEqual(edit('first'))
        expect(hub.unconfirmedSettingsChange('other', field)).toBeNull()
        await hub.changeCoworkerSettings('other', edit('other-owner'))
        await hub.changeCoworkerSettings('ada', edit('new-revision', 4))
        await hub.changeCoworkerSettings('ada', edit('retry'))
        expect(hub.unconfirmedSettingsChange('ada', field)).toBeNull()
        expect(send.mock.calls.map(([id, change]) => [id, change])).toEqual([
            ['ada', edit('first')], ['other', edit('other-owner')], ['ada', edit('new-revision', 4)], ['ada', edit('first')],
        ])
        send.mockRejectedValueOnce(new Refusal(409, 'conflict'))
        await expect(hub.changeCoworkerSettings('ada', edit('next'))).rejects.toThrow()
        await hub.changeCoworkerSettings('ada', edit('after-refusal'))
        expect(send.mock.calls.slice(-2).map(([, change]) => change.body.requestId)).toEqual(['next', 'after-refusal'])
    })

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
        expect(agentViewSchema.parse(await hub.api('/api/v1/agents/ada')).agent.name).toBe('Ada')
    })

    it('lists the Mac\'s inbox, and marks read the rows the app names by their conversations', async () => {
        const row = (id: string, state: string, sessionIds: string[]) => ({ id, state, agentId: 'ada', agentName: 'Ada', sessionId: sessionIds[0], sessionIds, title: 'T', message: null, updatedAt: '2026-11-17T10:00:00.000Z', count: sessionIds.length })
        const readInbox = jest.fn(async () => ({ items: [row('p:q1', 'question', ['s1']), row('p:x1', 'on-mac', ['s2']), row('d:g1', 'done', ['s9', 's8']), row('d:g2', 'done', ['s7'])] }))
        const markInboxRead = jest.fn(async () => ({ marked: 1 }))
        const { hub } = setup({ readInbox, markInboxRead } as never)
        const inbox = inboxSchema.parse(await hub.api('/api/v1/inbox'))
        expect(inbox.items.map(item => [item.id, item.status, item.count])).toEqual([['p:q1', 'awaiting_question', 1], ['p:x1', 'waiting_human', 1], ['d:g1', 'done', 2], ['d:g2', 'done', 1]])

        await hub.api('/api/v1/inbox/read', { method: 'POST', body: { sessionIds: ['s8', 'unknown'] } })
        expect(markInboxRead).toHaveBeenLastCalledWith(['d:g1'], undefined)
        await hub.api('/api/v1/inbox/read', { method: 'POST', body: { sessionIds: ['nothing-listed'] } })
        expect(markInboxRead).toHaveBeenCalledTimes(1)
        await hub.api('/api/v1/inbox/read', { method: 'POST', body: { all: true } })
        expect(markInboxRead).toHaveBeenLastCalledWith(['p:q1', 'p:x1', 'd:g2'], undefined)
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
        expect(hub.waitingQuestion('chat-1')).toEqual(pending.question)
        hub.turnStarted('chat-1', 'ada', 'turn-1')
        expect(hub.waitingQuestion('chat-1')).toBeNull()
        expect(hub.waitingApproval('chat-1')).toBeNull()
    })

    it('remembers an approval only for a phone that may decide it', async () => {
        const pending = { question: null, approval: { toolCallId: 'call-2', approvals: [{ action: 'Send the report' }] } }
        const readOnly = setup({ openSavedChat: jest.fn(async () => ({ ...READ, pending, permissions: { sendMessages: true } })) })
        await readOnly.hub.api('/api/v1/conversations/chat-1/messages')
        expect(readOnly.hub.waitingApproval('chat-1')).toBeNull()
        const allowed = setup({ openSavedChat: jest.fn(async () => ({ ...READ, pending, permissions: { sendMessages: false, approveRequests: true } })) })
        await allowed.hub.api('/api/v1/conversations/chat-1/messages')
        expect(allowed.hub.waitingApproval('chat-1')).toEqual(pending.approval)
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
        for (const [path, method] of [['/api/v1/agents', 'POST'], ['/api/v1/me/account', 'DELETE'], ['/api/v1/foreman/routines', 'GET'], ['/api/v1/foreman/voice', 'POST'], ['/api/v1/agents/ada/files', 'GET'], ['/api/v1/agents/ada/model', 'PUT']] as const) {
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

    const words = { approvalOnMac: () => 'Decide on your Mac', macOnly: (kind: string) => `On your Mac: ${kind}` }
    const approval = { toolCallId: 'call-2', approvals: [{ action: 'Send the report', detail: 'To the whole team' }, { action: 'Rename it' }] }

    it('shows a waiting approval as words on a phone that may not approve requests', () => {
        for (const permissions of [undefined, { sendMessages: true }, { sendMessages: true, approveRequests: false }]) {
            const messages = messagesOf({ ...READ, messages: READ.messages.slice(0, 1), pending: { question: null, approval }, permissions }, words)
            expect(messages[1]).toMatchObject({ role: 'assistant', parts: [{ type: 'text', text: '**Decide on your Mac**\n\n- Send the report\n  To the whole team\n\n- Rename it' }] })
            expect(findPendingHitl(messages)).toBeNull()
        }
        expect(waitingOf({ ...READ, pending: { question: null, approval } })).toBe('awaiting_approval')
    })

    it('gives a phone that may approve requests the card, with the action and its detail', () => {
        const messages = messagesOf({ ...READ, pending: { question: null, approval }, permissions: { sendMessages: false, approveRequests: true } }, words)
        expect(findPendingHitl(messages)).toMatchObject({ kind: 'approval', toolCallId: 'call-2', input: { approvals: approval.approvals } })
    })

    it('names a request only the Mac settles, and offers nothing to decide', () => {
        const pending = { question: null, approval: null, macOnly: { kind: 'secret' as const, summary: 'Stripe API key' } }
        const messages = messagesOf({ ...READ, pending, permissions: { sendMessages: true, approveRequests: true } }, words)
        expect(messages.at(-1)?.parts.at(-1)).toEqual({ type: 'text', text: '**On your Mac: secret**\n\nStripe API key' })
        expect(findPendingHitl(messages)).toBeNull()
        expect(waitingOf({ ...READ, pending })).toBe('waiting_human')
    })

    it('adds nothing to a chat that waits on nobody, or to a Mac older than the cards', () => {
        expect(findPendingHitl(messagesOf(READ))).toBeNull()
        expect(findPendingHitl(messagesOf({ ...READ, pending: { question: null, approval: null } }))).toBeNull()
    })
})

const GENERAL = 'fmc_11111111-1111-4111-8111-111111111111'
const THREAD = 'fmc_22222222-2222-4222-8222-222222222222'
const CHIEF = {
    state: 'ready',
    conversations: [
        { id: GENERAL, title: null, kind: 'general', createdAt: '2026-11-17T10:00:00.000Z', updatedAt: '2026-11-17T10:05:00.000Z' },
        { id: THREAD, title: 'Launch plan', kind: 'thread', createdAt: '2026-11-17T11:00:00.000Z', updatedAt: '2026-11-17T11:30:00.000Z' },
    ],
    permissions: { sendMessages: false },
}
const PLAN = { kind: 'plan' as const, title: 'Support desk', lines: ['Ava: answers tickets'] }
const CHIEF_CHAT = {
    state: 'ready',
    chat: CHIEF.conversations[0],
    messages: [{ id: 'm1', role: 'user', content: { type: 'text', text: 'Plan the week' } }, { id: 'm2', role: 'assistant', content: { type: 'text', text: 'Here is a plan.' } }],
    running: false,
    pending: { question: null, approval: null, macOnly: null },
    cards: [PLAN],
    permissions: { sendMessages: false },
}

describe('the Chief of Staff of a paired Mac', () => {
    it('opens the page on its conversations once the Mac is past its first-run questions, and never walks the hub\'s own', async () => {
        const readChief = jest.fn(async () => CHIEF)
        const { hub } = setup({ readChief } as never)
        expect(foremanStateSchema.parse(await hub.api('/api/chat/foreman/state'))).toMatchObject({ surface: 'engine', phase: 'companion' })
        const listed = conversationSchema.array().parse(await hub.api('/api/v1/foreman/conversations'))
        expect(listed.map(row => [row.id, row.kind, row.title])).toEqual([[GENERAL, 'general', ''], [THREAD, 'thread', 'Launch plan']])
        // The Home's row: the conversation written in last.
        expect(foremanEngineConversationSchema.parse(await hub.api('/api/chat/foreman/engine'))).toMatchObject({ sessionId: THREAD, title: 'Launch plan' })
        // Attachments stay on the Mac.
        expect(foremanEngineFilesSchema.parse(await hub.api('/api/v1/foreman/files')).supported).toBe(false)
    })

    it('says to finish on the Mac while it still asks its first-run company questions', async () => {
        const { hub } = setup({ readChief: jest.fn(async () => ({ state: 'intake', conversations: [] })) } as never)
        // The page reads the surface; the phase keeps the app out of the hub's own first-run questions.
        expect(foremanStateSchema.parse(await hub.api('/api/chat/foreman/state'))).toMatchObject({ surface: 'onboarding', phase: 'companion' })
        expect(await hub.api('/api/v1/foreman/conversations')).toEqual([])
        expect(await hub.api('/api/chat/foreman/engine')).toBeNull()
    })

    it('reads a conversation as text, with its change cards as words in a message of their own', async () => {
        const openChiefChat = jest.fn(async () => CHIEF_CHAT)
        const { hub } = setup({ openChiefChat } as never)
        const { messages } = foremanEngineMessagesSchema.parse(await hub.api(`/api/chat/foreman/engine?sessionId=${GENERAL}`))
        expect(openChiefChat).toHaveBeenCalledWith(GENERAL, undefined)
        expect(messages.map(message => [message.role, message.parts.map(part => part.type)])).toEqual([['user', ['text']], ['assistant', ['text']], ['assistant', ['text']]])
        expect(messages[2].parts[0]).toEqual({ type: 'text', text: '**A plan to build**\n\nSupport desk\n\n- Ava: answers tickets\n\n_Open on your Mac to approve_' })
        expect(findPendingHitl(messages)).toBeNull()
    })

    it('puts a waiting question where the chat looks for it, and keeps the Chief of Staff\'s approval as words', async () => {
        const question = { toolCallId: 'call-chief', questions: [{ question: 'Which team?', options: ['Sales', 'Support'], multiple: false }] }
        const approval = { toolCallId: 'call-approve', approvals: [{ action: 'Create Mara' }] }
        const asked = setup({ openChiefChat: jest.fn(async () => ({ ...CHIEF_CHAT, pending: { question, approval: null, macOnly: null }, permissions: { sendMessages: true } })) } as never)
        const { messages } = foremanEngineMessagesSchema.parse(await asked.hub.api(`/api/chat/foreman/engine?sessionId=${GENERAL}`))
        expect(findPendingHitl(messages)).toMatchObject({ kind: 'question', toolCallId: 'call-chief' })
        expect(asked.hub.waitingQuestion(GENERAL)).toEqual(question)

        const read = { ...CHIEF_CHAT, cards: [], pending: { question: null, approval, macOnly: null }, permissions: { sendMessages: true } } as Parameters<typeof chiefMessagesOf>[0]
        const shown = chiefMessagesOf(read)
        expect(findPendingHitl(shown)).toBeNull()
        expect(JSON.stringify(shown)).toContain('Create Mara')
        const waiting = setup({ openChiefChat: jest.fn(async () => read) } as never)
        await waiting.hub.api(`/api/chat/foreman/engine?sessionId=${GENERAL}`)
        expect(waiting.hub.waitingApproval(GENERAL)).toBeNull()
    })

    it('follows and stops only the turn this phone started, through the Chief of Staff\'s own entries', async () => {
        const readChiefTurn = jest.fn(async () => ({ status: 'running' }))
        const stopChiefTurn = jest.fn(async () => undefined)
        const { hub, client } = setup({ readChiefTurn, stopChiefTurn, openChiefChat: jest.fn(async () => CHIEF_CHAT) } as never)
        await hub.api(`/api/chat/foreman/engine?sessionId=${GENERAL}&runId=x`, { method: 'DELETE' })
        expect(stopChiefTurn).not.toHaveBeenCalled()
        hub.turnStarted(GENERAL, 'foreman', 'turn-1')
        expect(foremanEngineConversationSchema.parse(await hub.api(`/api/chat/foreman/engine?sessionId=${GENERAL}`))?.activeRunId).toBe('turn-1')
        readChiefTurn.mockResolvedValueOnce({ status: 'running' }).mockResolvedValue({ status: 'cancelled' })
        await hub.api(`/api/chat/foreman/engine?sessionId=${GENERAL}&runId=turn-1`, { method: 'DELETE' })
        expect(stopChiefTurn).toHaveBeenCalledWith(GENERAL, 'turn-1', undefined)
        expect(client.stopSentTurn).not.toHaveBeenCalled()
    })

    it('hands a removed phone back to sign-in, and shows nothing', async () => {
        const { hub, onRevoked } = setup({ readChief: jest.fn(async () => Promise.reject(new Refusal(401, 'revoked'))) } as never)
        await expect(hub.api('/api/chat/foreman/state')).rejects.toMatchObject({ status: 401 })
        expect(onRevoked).toHaveBeenCalledTimes(1)
    })

    it('asks the Mac for a voice conversation, and sends a removed phone back to sign in', async () => {
        const chatId = 'fmc_11111111-1111-4111-8111-111111111111'
        const startVoice = jest.fn(async () => ({ conversationToken: 'voice-token', conversationId: 'conv_1', expiresAt: '2026-11-17T12:00:00Z' }))
        const { hub, onRevoked } = setup({ startVoice } as never)
        await expect(hub.startVoice(chatId)).resolves.toEqual({ conversationToken: 'voice-token', conversationId: 'conv_1', expiresAt: '2026-11-17T12:00:00Z' })
        expect(startVoice).toHaveBeenCalledWith(chatId, undefined)

        startVoice.mockRejectedValueOnce(new Refusal(404, 'not_found'))
        await expect(hub.startVoice(chatId)).rejects.toMatchObject({ status: 404, message: 'not_found' })
        expect(onRevoked).not.toHaveBeenCalled()
        startVoice.mockRejectedValueOnce(new Refusal(401, 'revoked'))
        await expect(hub.startVoice(chatId)).rejects.toMatchObject({ status: 401 })
        expect(onRevoked).toHaveBeenCalledTimes(1)
    })
})
