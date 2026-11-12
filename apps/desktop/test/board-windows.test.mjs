import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { createBoardWindows } from '../src/main/board-windows.mjs'

const boardUrl = 'http://127.0.0.1:8123/desktop'
const startupUrl = 'file:///startup.html'
const runtime = { workspaceId: 1 }

function fixture() {
    const registry = createBoardWindows({ startupUrl, isDesktopPage: url => url === boardUrl })
    function create(primary = false, url = boardUrl) {
        const messages = []
        const contents = Object.assign(new EventEmitter(), {
            mainFrame: { url },
            isDestroyed: () => destroyed,
            send: (...args) => messages.push(args),
        })
        let destroyed = false
        const window = { webContents: contents, isDestroyed: () => destroyed }
        const entry = registry.register(window, { primary })
        entry.runtime = runtime
        return {
            entry, messages,
            event: (frame = contents.mainFrame) => ({ sender: contents, senderFrame: frame }),
            destroy: () => { destroyed = true; contents.emit('destroyed') },
        }
    }
    return { registry, create }
}

test('native board requests require a managed main frame and its exact runtime', () => {
    const { registry, create } = fixture()
    const primary = create(true, startupUrl)
    const second = create()
    const unknown = { sender: {}, senderFrame: { url: boardUrl } }
    assert.equal(registry.trusted(primary.event(), null), primary.entry)
    assert.equal(registry.trusted(second.event(), runtime), second.entry)
    for (const [event, active] of [
        [unknown, runtime], [second.event({ url: boardUrl }), runtime],
        [second.event(), { workspaceId: 1 }], [second.event(), null],
    ]) assert.throws(() => registry.trusted(event, active), /Untrusted/)
    second.entry.contents.mainFrame.url = startupUrl
    assert.throws(() => registry.trusted(second.event(), runtime), /Untrusted/)
    second.destroy()
    assert.deepEqual(registry.list(), [primary.entry])
})

test('both boards must acknowledge a draft flush with their own request and registration', async () => {
    const { registry, create } = fixture()
    const first = create(true), second = create()
    first.entry.drafts.register('same-renderer-local-id')
    second.entry.drafts.register('same-renderer-local-id')
    const pending = registry.flushAll(runtime, true)
    const requestOf = fixture => fixture.messages[0][1]
    const primaryRequest = requestOf(first), secondaryRequest = requestOf(second)
    assert.notEqual(primaryRequest.requestId, secondaryRequest.requestId)
    assert.equal(second.entry.drafts.signalFor(primaryRequest), undefined)
    const secondSignal = second.entry.drafts.signalFor(secondaryRequest)
    first.entry.drafts.acknowledge({ ...primaryRequest, saved: true })
    assert.equal(secondSignal.aborted, false)
    second.entry.drafts.acknowledge({ ...secondaryRequest, saved: true })
    assert.equal(await pending, true)
})

test('navigation or destruction cancels only the affected board lease and refuses the switch', async () => {
    const { registry, create } = fixture()
    const first = create(true), second = create()
    first.entry.drafts.register('1')
    second.entry.drafts.register('1')
    const epoch = second.entry.epoch
    const pending = registry.flushAll(runtime, true)
    const [, primaryRequest] = first.messages[0]
    const [, secondaryRequest] = second.messages[0]
    registry.invalidate(second.entry)
    assert.notEqual(second.entry.epoch, epoch)
    assert.equal(second.entry.drafts.signalFor(secondaryRequest), undefined)
    first.entry.drafts.acknowledge({ ...primaryRequest, saved: true })
    assert.equal(await pending, false)
    assert.equal(await registry.flush(second.entry, runtime, true), false)
    second.entry.drafts.register('2')
    const closing = registry.flush(second.entry, runtime)
    second.destroy()
    assert.equal(await closing, false)
    assert.equal(first.entry.drafts.ready, true)
})
