import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { createBoardWindows } from '../src/main/board-windows.mjs'

const boardUrl = 'http://127.0.0.1:8123/desktop'
const startupUrl = 'file:///startup.html'
const runtime = { workspaceId: 1 }

function fixture() {
    const registry = createBoardWindows({ startupUrl, isDesktopPage: url => url === boardUrl || url.startsWith(boardUrl + '?') })
    function create(primary = false, url = boardUrl) {
        const messages = [], navigations = []
        const contents = Object.assign(new EventEmitter(), {
            mainFrame: { url },
            isDestroyed: () => destroyed,
            isCrashed: () => crashed,
            send: (...args) => messages.push(args),
        })
        let destroyed = false
        let crashed = false
        contents.reload = () => {
            navigations.push(contents.mainFrame.url)
            contents.emit('did-finish-load')
        }
        const window = { webContents: contents, isDestroyed: () => destroyed }
        const entry = registry.register(window, { primary })
        entry.runtime = runtime
        return {
            entry, messages, navigations,
            event: (frame = contents.mainFrame) => ({ sender: contents, senderFrame: frame }),
            destroy: () => { destroyed = true; contents.emit('destroyed') },
            crash: () => { crashed = true; contents.emit('render-process-gone') },
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

test('a crashed document cannot use board IPC or acknowledge a draft drain', async () => {
    const { registry, create } = fixture()
    const board = create(true)
    board.crash()
    assert.equal(registry.ready(board.entry, runtime), false)
    assert.throws(() => registry.trusted(board.event(), runtime), /Untrusted/)
    assert.equal(await registry.flush(board.entry, runtime), false)
})

test('a recovery page grants only recovery IPC to the managed main frame of that workspace runtime', () => {
    const { registry, create } = fixture()
    for (const primary of [true, false]) {
        const board = create(primary, startupUrl)
        assert.equal(registry.recoveryPage(board.event(), runtime), null)
        board.entry.rendererFailure = runtime
        assert.equal(registry.recoveryPage(board.event(), runtime), board.entry)
        assert.throws(() => registry.trusted(board.event(), runtime), /Untrusted/)
        assert.equal(registry.recoveryPage(board.event(), { workspaceId: 1 }), null)
        assert.equal(registry.recoveryPage(board.event({ url: startupUrl }), runtime), null)
        board.crash()
        assert.equal(registry.recoveryPage(board.event(), runtime), null)
    }
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

test('Reload waits for the initiating board to drain and keeps its exact page', async () => {
    const { registry, create } = fixture()
    const other = create(true)
    const address = boardUrl + '?view=focus#chat'
    const target = create(false, address)
    other.entry.drafts.register('other-board')
    target.entry.drafts.register('target-board')
    const reloaded = registry.reload(target.entry, runtime, () => assert.fail('already saved'), () => assert.fail('still reloading'))
    assert.deepEqual(other.messages, [])
    assert.deepEqual(target.navigations, [])
    const [channel, request] = target.messages[0]
    assert.equal(channel, 'desktop:before-quit')
    target.entry.drafts.acknowledge({ ...request, saved: true })
    assert.equal(await reloaded, true)
    assert.deepEqual(target.navigations, [address])
    assert.deepEqual(other.navigations, [])
})

test('Stay resumes the old board and stale discard approval cannot reload a new document', async () => {
    const { registry, create } = fixture()
    const target = create()
    target.entry.drafts.register('target-board')
    let resumed = 0
    const reload = confirm => {
        const reloaded = registry.reload(target.entry, runtime, confirm, () => { resumed++ })
        const [, request] = target.messages.at(-1)
        target.entry.drafts.acknowledge({ ...request, saved: false })
        return reloaded
    }
    assert.equal(await reload(() => false), false)
    assert.equal(resumed, 1)
    assert.deepEqual(target.navigations, [])
    assert.equal(await reload(() => {
        registry.invalidate(target.entry)
        return true
    }), false)
    assert.equal(resumed, 1)
    assert.deepEqual(target.navigations, [])
})

test('a reload blocked by the original document releases its draft freeze', async () => {
    const { registry, create } = fixture()
    const target = create()
    target.entry.contents.reload = () => target.entry.contents.emit('will-prevent-unload')
    target.entry.drafts.register('target-board')
    let resumed = false
    const reloaded = registry.reload(target.entry, runtime, () => assert.fail('already saved'), () => { resumed = true })
    const [, request] = target.messages[0]
    target.entry.drafts.acknowledge({ ...request, saved: true })
    assert.equal(await reloaded, false)
    assert.equal(resumed, true)
    assert.equal(target.entry.contents.listenerCount('did-finish-load'), 0)
})
