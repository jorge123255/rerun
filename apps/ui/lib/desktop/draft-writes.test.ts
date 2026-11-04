import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopComposerDraft, DesktopComposerDraftWrite } from './composer-draft'

let drafts: typeof import('./draft-writes')
let tabs: typeof import('./tab-writes')
const saved = new Map<string, DesktopComposerDraft>()
const writes: (DesktopComposerDraftWrite & { agentId: string })[] = []
let read: (key: string) => Promise<Response>
let write: (key: string, body: DesktopComposerDraftWrite) => Promise<Response>
const keyOf = (agentId: string, uid: string) => JSON.stringify([agentId, uid])
const empty = (): DesktopComposerDraft => ({ revision: 0, text: '' })
function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}
function commit(key: string, body: DesktopComposerDraftWrite) {
    const previous = saved.get(key) ?? empty()
    if (body.baseRevision !== previous.revision) return Response.json({ draft: previous }, { status: 409 })
    const draft = { revision: previous.revision + 1, text: body.text, ...(body.attachmentPath && { attachmentPath: body.attachmentPath }), ...(body.attachmentPaths && { attachmentPaths: [...body.attachmentPaths] }) }
    saved.set(key, draft)
    return Response.json({ draft })
}

beforeEach(async () => {
    vi.resetModules()
    drafts = await import('./draft-writes')
    tabs = await import('./tab-writes')
    saved.clear(); writes.length = 0
    read = async key => Response.json({ draft: saved.get(key) ?? empty() })
    write = async (key, body) => commit(key, body)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://local')
        const agentId = decodeURIComponent(url.pathname.split('/')[4])
        expect(url.pathname).toMatch(/\/api\/desktop\/agents\/[^/]+\/draft$/)
        if (init?.method === 'PUT') {
            const body = JSON.parse(String(init.body)) as DesktopComposerDraftWrite
            writes.push({ ...body, agentId })
            return write(keyOf(agentId, body.tabUid), body)
        }
        return read(keyOf(agentId, url.searchParams.get('tabUid')!))
    }))
})
afterEach(() => vi.unstubAllGlobals())

test('a late saved read cannot replace a newer local edit, including an intentional empty draft', async () => {
    const response = deferred<Response>()
    read = () => response.promise
    const record = drafts.desktopDraftRecord('alice', 'one')
    const loading = drafts.saveDesktopDraft(record)
    drafts.updateDesktopDraft(record, { text: 'Started locally', attachmentPath: 'notes.md' })
    drafts.updateDesktopDraft(record, { text: '' })
    saved.set(keyOf('alice', 'one'), { revision: 7, text: 'Older saved draft', attachmentPath: 'old.md' })
    response.resolve(Response.json({ draft: saved.get(keyOf('alice', 'one')) }))
    await loading
    expect(record.state).toMatchObject({ loaded: true, text: '', attachmentPath: undefined, version: 2 })
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ baseRevision: 7, text: '' })
    expect(saved.get(keyOf('alice', 'one'))).toEqual({ revision: 8, text: '' })
})

test('writes wait for tab ownership and coalesce edits behind the pending save', async () => {
    const ownership = deferred<void>()
    tabs.queueTabWrite('alice', () => ownership.promise)
    const record = drafts.desktopDraftRecord('alice', 'one')
    const loading = drafts.saveDesktopDraft(record)
    await Promise.resolve()
    expect(fetch).not.toHaveBeenCalled()
    ownership.resolve(); await loading
    const first = deferred<Response>()
    write = (key, body) => writes.length === 1 ? first.promise : Promise.resolve(commit(key, body))
    drafts.updateDesktopDraft(record, { text: 'First' })
    await vi.waitFor(() => expect(writes).toHaveLength(1))
    drafts.updateDesktopDraft(record, { text: 'Second' })
    drafts.updateDesktopDraft(record, { text: 'Newest', attachmentPath: 'proof.md' })
    first.resolve(commit(keyOf('alice', 'one'), writes[0]))
    await drafts.saveDesktopDraft(record)
    expect(writes.map(value => [value.text, value.baseRevision])).toEqual([['First', 0], ['Newest', 1]])
    expect(writes[1].requestId).not.toBe(writes[0].requestId)
    expect(record.state).toMatchObject({ text: 'Newest', attachmentPath: 'proof.md', saving: false })
})

test('an edit queued from the first save acknowledgement is saved automatically after its drain exits', async () => {
    const record = drafts.desktopDraftRecord('alice', 'one')
    await drafts.saveDesktopDraft(record)
    let queued = false
    const onState = () => {
        if (queued || record.state.saving || writes.length !== 1 || record.dirty) return
        queued = true
        // This runs after drain's final while condition but before its work promise is cleared.
        queueMicrotask(() => drafts.updateDesktopDraft(record, { text: 'Typed just after acknowledgement', attachmentPath: 'latest.md' }))
    }
    record.listeners.add(onState)
    try {
        drafts.updateDesktopDraft(record, { text: 'First save' })
        // Deliberately do not call save/flush: the second edit must schedule its own write.
        await vi.waitFor(() => {
            expect(saved.get(keyOf('alice', 'one'))).toEqual({ revision: 2, text: 'Typed just after acknowledgement', attachmentPath: 'latest.md' })
            expect(record.state.saving).toBe(false)
            expect(record.dirty).toBe(false)
        })
        expect(queued).toBe(true)
        expect(writes.map(value => [value.text, value.baseRevision])).toEqual([
            ['First save', 0], ['Typed just after acknowledgement', 1],
        ])
        expect(writes[1].requestId).not.toBe(writes[0].requestId)
    } finally { record.listeners.delete(onState) }
})

test('a lost save acknowledgement retries the exact UUID and CAS before saving a newer edit', async () => {
    const record = drafts.desktopDraftRecord('alice', 'one')
    await drafts.saveDesktopDraft(record)
    let receipt: DesktopComposerDraft | undefined
    write = async (key, body) => {
        if (writes.length === 1) {
            commit(key, body); receipt = saved.get(key)
            throw new Error('Acknowledgement lost')
        }
        if (writes.length === 2) return Response.json({ draft: receipt })
        return commit(key, body)
    }
    drafts.updateDesktopDraft(record, { text: 'Accepted draft' })
    await drafts.saveDesktopDraft(record)
    expect(record.state.error).toBe('Acknowledgement lost')
    drafts.updateDesktopDraft(record, { text: 'Newer local draft' })
    await drafts.saveDesktopDraft(record)
    expect(writes).toHaveLength(3)
    expect(writes[1]).toEqual(writes[0])
    expect(writes[2]).toMatchObject({ text: 'Newer local draft', baseRevision: 1 })
    expect(writes[2].requestId).not.toBe(writes[0].requestId)
    expect(record.state.error).toBeUndefined()
    expect(saved.get(keyOf('alice', 'one'))?.text).toBe('Newer local draft')
})

test.each([404, 409, 413, 415])('an explicit attachment refusal (%s) permits correction with unchanged text and a fresh request', async status => {
    const record = drafts.desktopDraftRecord('alice', 'one')
    await drafts.saveDesktopDraft(record)
    write = async (key, body) => writes.length === 1
        ? Response.json({ error: 'Remove unavailable attachment', code: 'draft_attachment_rejected' }, { status })
        : commit(key, body)
    drafts.updateDesktopDraft(record, { text: 'Keep all my text', attachmentPaths: ['good.md', 'bad.md'] })
    await drafts.saveDesktopDraft(record)
    expect(record.state).toMatchObject({ text: 'Keep all my text', attachmentRejected: true, conflict: false, saving: false })
    expect(saved.has(keyOf('alice', 'one'))).toBe(false)
    drafts.updateDesktopDraft(record, { text: record.state.text, attachmentPath: 'good.md' })
    await vi.waitFor(() => expect(saved.get(keyOf('alice', 'one'))).toEqual({ revision: 1, text: 'Keep all my text', attachmentPath: 'good.md' }))
    expect(writes).toHaveLength(2)
    expect(writes[1].requestId).not.toBe(writes[0].requestId)
    expect(writes.map(value => value.baseRevision)).toEqual([0, 0])
    expect(record.state).toMatchObject({ attachmentRejected: false, conflict: false, attachmentPaths: undefined })
    expect(record.state.error).toBeUndefined()
})

test.each([404, 413, 500])('an untyped HTTP %s failure still replays the exact multi-file attempt before a newer edit', async status => {
    const record = drafts.desktopDraftRecord('alice', 'one')
    await drafts.saveDesktopDraft(record)
    let receipt: DesktopComposerDraft | undefined
    write = async (key, body) => {
        if (writes.length === 1) {
            commit(key, body); receipt = saved.get(key)
            return Response.json({ error: 'Uncertain response' }, { status })
        }
        if (writes.length === 2) return Response.json({ draft: receipt })
        return commit(key, body)
    }
    drafts.updateDesktopDraft(record, { text: 'Preserve this', attachmentPaths: ['first.md', 'second.md'] })
    await drafts.saveDesktopDraft(record)
    expect(record.state.attachmentRejected).not.toBe(true)
    drafts.updateDesktopDraft(record, { text: 'Newer edit', attachmentPath: 'first.md' })
    await drafts.saveDesktopDraft(record)
    expect(writes).toHaveLength(3)
    expect(writes[1]).toEqual(writes[0])
    expect(writes[2]).toMatchObject({ baseRevision: 1, text: 'Newer edit', attachmentPath: 'first.md' })
    expect(writes[2].requestId).not.toBe(writes[0].requestId)
})

test('accepting an older send never clears a newer composer edit or its attachment', async () => {
    const record = drafts.desktopDraftRecord('alice', 'one')
    await drafts.saveDesktopDraft(record)
    drafts.updateDesktopDraft(record, { text: 'Submitted', attachmentPath: 'first.md' })
    await drafts.saveDesktopDraft(record)
    const submittedVersion = record.state.version
    drafts.updateDesktopDraft(record, { text: 'Next message', attachmentPath: 'second.md' })
    expect(drafts.clearDesktopDraft(record, submittedVersion)).toBe(false)
    await drafts.saveDesktopDraft(record)
    expect(saved.get(keyOf('alice', 'one'))).toMatchObject({ text: 'Next message', attachmentPath: 'second.md' })
    expect(drafts.clearDesktopDraft(record, record.state.version)).toBe(true)
    await drafts.saveDesktopDraft(record)
    expect(saved.get(keyOf('alice', 'one'))).toEqual({ revision: 3, text: '' })
})

test('a conflicting writer requires an explicit keep with the newest comparison revision', async () => {
    const record = drafts.desktopDraftRecord('alice', 'one')
    await drafts.saveDesktopDraft(record)
    saved.set(keyOf('alice', 'one'), { revision: 4, text: 'Other view' })
    drafts.updateDesktopDraft(record, { text: 'My local edit' })
    await drafts.saveDesktopDraft(record)
    expect(record.state).toMatchObject({ text: 'My local edit', conflict: true })
    expect(await drafts.flushDesktopDrafts()).toBe(false)
    expect(drafts.isDesktopQuitting()).toBe(true)
    drafts.cancelDraftShutdown()
    saved.set(keyOf('alice', 'one'), { revision: 5, text: 'Even newer other view' })
    await drafts.keepDesktopDraft(record)
    expect(writes.at(-1)).toMatchObject({ text: 'My local edit', baseRevision: 5 })
    expect(record.state).toMatchObject({ text: 'My local edit', conflict: false })
    expect(saved.get(keyOf('alice', 'one'))).toEqual({ revision: 6, text: 'My local edit' })
})

test('reload uses the saved conflict version without writing over it', async () => {
    const record = drafts.desktopDraftRecord('alice', 'one')
    await drafts.saveDesktopDraft(record)
    saved.set(keyOf('alice', 'one'), { revision: 2, text: 'Other view', attachmentPath: 'other.md' })
    drafts.updateDesktopDraft(record, { text: 'Local conflict' })
    await drafts.saveDesktopDraft(record)
    await drafts.reloadDesktopDraft(record)
    expect(writes).toHaveLength(1)
    expect(record.state).toMatchObject({ text: 'Other view', attachmentPath: 'other.md', conflict: false, error: undefined })
})

test('coworkers and tabs stay isolated, and forgetting a tab ignores its late read', async () => {
    const late = deferred<Response>()
    const old = drafts.desktopDraftRecord('alice', 'same-tab')
    read = key => key === keyOf('alice', 'same-tab') ? late.promise : Promise.resolve(Response.json({ draft: saved.get(key) ?? empty() }))
    const oldRead = drafts.saveDesktopDraft(old)
    await Promise.resolve()
    const bob = drafts.desktopDraftRecord('bob', 'same-tab')
    const otherTab = drafts.desktopDraftRecord('alice', 'other-tab')
    await Promise.all([drafts.saveDesktopDraft(bob), drafts.saveDesktopDraft(otherTab)])
    drafts.updateDesktopDraft(bob, { text: 'Bob only' })
    drafts.updateDesktopDraft(otherTab, { text: 'Other tab only' })
    await Promise.all([drafts.saveDesktopDraft(bob), drafts.saveDesktopDraft(otherTab)])
    drafts.forgetDesktopDraft('alice', 'same-tab')
    const reopened = drafts.desktopDraftRecord('alice', 'same-tab')
    expect(reopened).not.toBe(old)
    late.resolve(Response.json({ draft: { revision: 9, text: 'Late closed tab' } })); await oldRead
    expect(reopened.state).toMatchObject({ text: '', loaded: false })
    drafts.forgetCoworkerDrafts('alice')
    expect(drafts.desktopDraftRecord('bob', 'same-tab')).toBe(bob)
    expect(saved.get(keyOf('bob', 'same-tab'))?.text).toBe('Bob only')
    expect(saved.get(keyOf('alice', 'other-tab'))?.text).toBe('Other tab only')
})

test('quit waits for send admission and its durable clear, then stays frozen until cancellation', async () => {
    const record = drafts.desktopDraftRecord('alice', 'one')
    await drafts.saveDesktopDraft(record)
    drafts.updateDesktopDraft(record, { text: 'Accepted by the engine' })
    await drafts.saveDesktopDraft(record)
    const release = drafts.holdDraftAdmission()
    const notifications: boolean[] = []
    const unsubscribe = drafts.subscribeDraftShutdown(() => notifications.push(drafts.isDesktopQuitting()))
    let done = false
    const quitting = drafts.flushDesktopDrafts().then(value => { done = true; return value })
    expect(drafts.isDesktopQuitting()).toBe(true)
    await Promise.resolve(); expect(done).toBe(false)
    drafts.clearDesktopDraft(record, record.state.version)
    release()
    expect(await quitting).toBe(true)
    expect(saved.get(keyOf('alice', 'one'))?.text).toBe('')
    expect(drafts.isDesktopQuitting()).toBe(true)
    drafts.cancelDraftShutdown()
    expect(notifications).toEqual([true, false])
    unsubscribe()
})

test('a save failure refuses quit and remains frozen until Stay, then explicit retry can succeed', async () => {
    const record = drafts.desktopDraftRecord('alice', 'one')
    await drafts.saveDesktopDraft(record)
    write = async () => { throw new Error('Offline') }
    drafts.updateDesktopDraft(record, { text: 'Keep this' })
    await drafts.saveDesktopDraft(record)
    expect(await drafts.flushDesktopDrafts()).toBe(false)
    expect(drafts.isDesktopQuitting()).toBe(true)
    expect(record.state.text).toBe('Keep this')
    drafts.cancelDraftShutdown()
    write = async (key, body) => commit(key, body)
    await drafts.saveDesktopDraft(record)
    expect(await drafts.flushDesktopDrafts()).toBe(true)
    expect(saved.get(keyOf('alice', 'one'))?.text).toBe('Keep this')
})
