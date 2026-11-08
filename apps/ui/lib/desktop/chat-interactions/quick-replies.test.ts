import { afterEach, expect, test, vi } from 'vitest'
import { quickReplyDraft, quickRepliesOf } from '../../../../../packages/contracts/src/chat-quick-replies'
import { desktopDraftRecord, forgetDesktopDraft } from '../draft-writes'
import { createQuickReplyAdapter } from './quick-replies'
import { interaction } from './fixtures'

const message = { id: interaction.messageId, role: 'assistant', parts: [{ type: 'tool-suggest_replies', input: { replies: ['Here is the repo URL', "I'll send the URL", 'Try again'] } }] }
let count = 0
const records: ReturnType<typeof desktopDraftRecord>[] = []
afterEach(() => { for (const r of records.splice(0)) forgetDesktopDraft(r.agentId, r.uid); vi.unstubAllGlobals() })
function setup() {
    const identity = { ...interaction, tabUid: `reply-tab-${++count}` }
    const record = desktopDraftRecord(identity.agentId, identity.tabUid); records.push(record)
    record.state.loaded = true
    let current: typeof identity | null = identity
    const send = vi.fn(async () => true), changed = vi.fn(), focus = vi.fn()
    const adapter = createQuickReplyAdapter(identity, { current: () => current, message: () => message, record: () => record, send, onDraftChanged: changed, focusDraft: focus })
    return { identity, record, send, changed, focus, adapter, switchChat: () => { current = { ...identity, sessionId: 'other-chat' } } }
}
test('original announcements draft, future value promises disappear, real choices retain their value', () => {
    expect(quickReplyDraft('Here is the repo URL')).toBe('Here is the repo URL: ')
    expect(quickReplyDraft('Repo URL…')).toBe('Repo URL: ')
    expect(quickReplyDraft("I'll give it a try")).toBeNull()
    expect(quickRepliesOf(message)).toEqual(['Here is the repo URL', 'Try again'])
})
test('announcement uses the actual canonical draft writer and never sends', async () => {
    const state = setup()
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: { body: string }) => {
        const { tabUid: _tab, requestId: _request, baseRevision: _base, ...value } = JSON.parse(init.body)
        return { ok: true, status: 200, json: async () => ({ draft: { ...value, revision: 1 } }) }
    }))
    expect(await state.adapter.activate('Here is the repo URL')).toEqual({ kind: 'draft', saved: true })
    expect(state.record.state.text).toBe('Here is the repo URL: ')
    expect(state.changed).toHaveBeenCalledOnce(); expect(state.focus).toHaveBeenCalledOnce()
    expect(state.send).not.toHaveBeenCalled()
})
test('dirty composer and stale owner remain untouched; filtered promises cannot dispatch', async () => {
    const state = setup(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    state.record.state.text = 'My unfinished draft'; state.record.dirty = true
    expect((await state.adapter.activate('Here is the repo URL')).kind).toBe('blocked')
    expect(state.record.state.text).toBe('My unfinished draft')
    expect((await state.adapter.activate("I'll send the URL")).kind).toBe('blocked')
    state.switchChat()
    expect((await state.adapter.activate('Try again')).kind).toBe('blocked')
    expect(fetch).not.toHaveBeenCalled(); expect(state.send).not.toHaveBeenCalled()
})
test('lost draft acknowledgement keeps canonical immutable retry; switching cannot focus the new chat', async () => {
    const state = setup()
    vi.stubGlobal('fetch', vi.fn(async () => { state.switchChat(); throw Error('Lost acknowledgement') }))
    expect((await state.adapter.activate('Here is the repo URL')).kind).toBe('blocked')
    expect(state.record.attempt?.requestId).toBeTruthy()
    expect(state.record.attempt?.text).toBe('Here is the repo URL: ')
    expect(state.record.dirty).toBe(true); expect(state.focus).not.toHaveBeenCalled()
    expect(state.send).not.toHaveBeenCalled()
})
test('only accepted send acknowledgements count and closing the adapter prevents another admission', async () => {
    const state = setup(); state.send.mockResolvedValueOnce(false)
    expect(await state.adapter.activate('Try again')).toEqual({ kind: 'sent', accepted: false })
    expect(await state.adapter.activate('Try again')).toEqual({ kind: 'sent', accepted: true })
    state.adapter.close()
    expect((await state.adapter.activate('Try again')).kind).toBe('blocked')
    expect(state.send).toHaveBeenCalledTimes(2)
})
