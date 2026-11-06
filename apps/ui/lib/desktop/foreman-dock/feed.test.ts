import { expect, it } from 'vitest'
import { createParkedFeed, type ExactDockFeed } from './feed'
const chat = { workspaceId: 'workspace', chatId: 'fmc_abcdefgh' }
const base: ExactDockFeed = { ...chat, source: 'current', runId: 'run', busy: false, label: null, pending: null, reply: { id: 'reply', text: 'Done', runId: 'run' }, failed: null }
it('never announces a restored reply or another owner/run', () => {
    const feed = createParkedFeed(chat)
    expect(feed.accept(base, false).reply).toBeNull()
    feed.accept({ ...base, busy: true }, false)
    expect(feed.accept({ ...base, chatId: 'other' }, false).reply).toBeNull()
    expect(feed.accept({ ...base, source: 'history' }, false).reply).toBeNull()
})
it('announces only the witnessed closed run; manual dismiss and reading the column suppress replay', () => {
    const feed = createParkedFeed(chat)
    feed.accept({ ...base, busy: true }, false)
    expect(feed.accept(base, false).reply?.text).toBe('Done')
    feed.dismiss('reply')
    expect(feed.accept(base, false).reply).toBeNull()
    feed.accept({ ...base, busy: true, runId: 'new' }, false)
    expect(feed.accept(base, false).reply).toBeNull()
    feed.accept(base, true)
    expect(feed.accept(base, false).reply).toBeNull()
})
it('retains exact pending request identity without answering it or opening anything', () => {
    const feed = createParkedFeed(chat)
    const pending = { id: 'request', requestId: 'request', runId: 'run', kind: 'approval' as const, title: 'Approve change', detail: null, more: 0 }
    expect(feed.accept({ ...base, pending }, false).pending).toEqual(pending)
    feed.dismiss('request')
    expect(feed.accept({ ...base, pending }, false).pending).toBeNull()
    expect(feed.accept({ ...base, pending: { ...pending, runId: 'old' } }, false).pending).toBeNull()
})
it('requires reply/run equality and never confuses a different completed run with the witnessed run', () => {
    const feed = createParkedFeed(chat)
    feed.accept({ ...base, busy: true, runId: 'current' }, false)
    expect(feed.accept({ ...base, runId: 'current' }, false).reply).toBeNull()
})
it('projects streamed same-ID replies only at witnessed completion, never on initial history', async () => {
    const { createClientDockFeed } = await import('./feed')
    const project = createClientDockFeed(chat)
    const state = { chat, view: { chat, live: null }, messages: [{ id: 'old', role: 'assistant', parts: [{ type: 'text', text: 'Old' }] }] } as unknown as import('@/lib/desktop/foreman-client/runtime-client').DesktopForemanClientState
    expect(project(state)?.source).toBe('history')
    const running = { ...state, view: { ...state.view, live: { runId: 'run', model: { connectionId: 'model', model: 'selected' } } }, messages: [{ id: 'new', role: 'assistant' as const, parts: [{ type: 'text', text: 'Part' }] }] }
    expect(project(running)?.reply).toBeNull()
    const finished = { ...running, view: { ...running.view, live: null }, messages: [{ id: 'new', role: 'assistant' as const, parts: [{ type: 'text', text: 'Completed' }] }] }
    expect(project(finished)?.reply).toMatchObject({ id: 'new', text: 'Completed', runId: 'run' })
    expect(project({ ...finished, messages: [{ id: 'unrelated', role: 'assistant', parts: [{ type: 'text', text: 'Readback' }] }] })?.reply?.id).toBe('new')
})
