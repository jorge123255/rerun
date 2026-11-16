// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest'
import { createDesktopForemanDraftPorts, createDesktopForemanDraftTask, sendDesktopForemanFirstMessage, takeDesktopForemanFirstSend } from './draft-task'
import { emptyForemanUi } from './persistence'

afterEach(() => { vi.unstubAllGlobals() })
const created = () => vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { workspaceId: string; requestId: string }
    return Response.json({ chat: { workspaceId: body.workspaceId, chatId: `fmc_${body.requestId}` } })
})

test('a draft has its own on-screen identity, apart from the conversation its first message will create', () => {
    const ids = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b']
    const draft = createDesktopForemanDraftTask('7', () => ids.shift()!)
    expect(draft).toEqual({ chat: { workspaceId: '7', chatId: 'fmc_00000000-0000-4000-8000-00000000000a' }, requestId: '00000000-0000-4000-8000-00000000000b' })
})

test('the draft\'s ports keep its interface state in memory and reach no server', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const draft = createDesktopForemanDraftTask('7')
    const send = vi.fn(async () => true)
    const ports = createDesktopForemanDraftPorts(draft.chat, send)
    expect(await ports.persistence.load(draft.chat)).toBeNull()
    const ui = { ...emptyForemanUi(draft.chat), draft: 'half a thought' }
    await ports.persistence.save(ui)
    expect(await ports.persistence.load(draft.chat)).toEqual(ui)
    expect(await ports.plans.readShownPlan(draft.chat)).toBeNull()
    expect((await ports.plans.readConversationView(draft.chat))?.chat).toEqual(draft.chat)
    expect(await ports.build.readProgress(draft.chat)).toBeNull()
    expect(ports.discovery.capabilities().available).toBe(false)
    await ports.conversation.sendMessage('Plan the launch', undefined, { coworkerMentions: [] })
    expect(send).toHaveBeenCalledExactlyOnceWith('Plan the launch', { coworkerMentions: [] })
    expect(fetcher).not.toHaveBeenCalled()
})

test('the first message creates the conversation, then leaves itself for that conversation exactly once', async () => {
    const fetcher = created()
    vi.stubGlobal('fetch', fetcher)
    const draft = createDesktopForemanDraftTask('7')
    const model = { connectionId: 'connection', model: 'model' }
    const open = vi.fn(async (chat: { chatId: string }) => {
        // The conversation is created before it is opened, and the message is already waiting for it.
        expect(fetcher).toHaveBeenCalledOnce()
        expect(chat.chatId).toBe(`fmc_${draft.requestId}`)
    })
    const chat = await sendDesktopForemanFirstMessage(draft, { text: 'Plan the launch', model }, open, new AbortController().signal)
    expect(chat).toEqual({ workspaceId: '7', chatId: `fmc_${draft.requestId}` })
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({ workspaceId: '7', requestId: draft.requestId })
    expect(takeDesktopForemanFirstSend(draft.chat.chatId)).toBeNull()
    expect(takeDesktopForemanFirstSend(chat.chatId)).toEqual({ chatId: chat.chatId, text: 'Plan the launch', model })
    expect(takeDesktopForemanFirstSend(chat.chatId)).toBeNull()
})

test('a conversation that cannot be created or opened leaves no message behind', async () => {
    const draft = createDesktopForemanDraftTask('7')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Workspace is busy.' }, { status: 409 })))
    const open = vi.fn(async () => {})
    await expect(sendDesktopForemanFirstMessage(draft, { text: 'Plan', model: null }, open, new AbortController().signal)).rejects.toThrow('Workspace is busy.')
    expect(open).not.toHaveBeenCalled()
    vi.stubGlobal('fetch', created())
    await expect(sendDesktopForemanFirstMessage(draft, { text: 'Plan', model: null }, async () => { throw new Error('Could not leave.') }, new AbortController().signal)).rejects.toThrow('Could not leave.')
    expect(takeDesktopForemanFirstSend(`fmc_${draft.requestId}`)).toBeNull()
})
