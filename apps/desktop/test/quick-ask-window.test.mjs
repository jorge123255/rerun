import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'
import { shellCopy } from '../src/main/shell-language.mjs'
import { createQuickAskWindow } from '../src/main/quick-ask-window.mjs'

test('Quick Ask is isolated and keeps one prompt identity through refusal and retry', async () => {
    let popup, shown = 0, language = 'fr'
    const copies = []
    class Window extends EventEmitter {
        constructor({ webPreferences }) {
            super()
            assert.deepEqual({ ...webPreferences, preload: Boolean(webPreferences.preload) }, {
                preload: true, partition: 'rerun-desktop-quick-ask', sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
            })
            popup = this
            this.webContents = Object.assign(new EventEmitter(), {
                mainFrame: {}, focus() {}, send(channel, value) { assert.equal(channel, 'desktop:quick-ask-focus'); copies.push(value) }, setWindowOpenHandler: handler => assert.deepEqual(handler(), { action: 'deny' }),
            })
        }
        setAlwaysOnTop() {}
        setVisibleOnAllWorkspaces() {}
        async loadFile(path) { this.webContents.mainFrame.url = pathToFileURL(path).href }
        setBounds() {}
        show() { this.visible = true }
        hide() { this.visible = false }
        focus() {}
        isDestroyed() { return this.destroyed === true }
        destroy() { this.destroyed = true; this.emit('closed') }
    }
    const deliveries = []
    const frame = { send: (channel, payload) => { assert.equal(channel, 'desktop:quick-ask-deliver'); deliveries.push(payload) } }
    const board = { mainFrame: frame }
    const sender = { sender: board, senderFrame: frame }
    const otherFrame = { send: () => assert.fail('A different board received the prompt') }
    const other = { mainFrame: otherFrame }
    const otherSender = { sender: other, senderFrame: otherFrame }
    let epoch = 'first'
    const quickAsk = createQuickAskWindow({ app: { focus() {} }, BrowserWindow: Window, showBoard: target => { assert.equal(target, board); shown++ },
        boardScope: target => target === board ? { epoch, contents: board, appearance: 'light' }
            : { epoch: 'other', contents: other, appearance: 'dark' },
        language: () => language,
        screen: { getCursorScreenPoint() {}, getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 900, height: 600 } }) } })
    quickAsk.toggle(board)
    assert.equal(popup, undefined)
    quickAsk.register(sender, { registrationId: '1' }, epoch)
    quickAsk.register(otherSender, { registrationId: '1' }, 'other')
    quickAsk.toggle(board)
    await Promise.resolve()
    assert.equal(popup.visible, true)
    assert.deepEqual(copies, [{ ...shellCopy('fr','quickAsk'), appearance: 'light' }])
    const event = { sender: popup.webContents, senderFrame: popup.webContents.mainFrame }
    assert.equal(await quickAsk.send({ ...event, senderFrame: {} }, 'Foreign frame'), false)
    assert.equal(await quickAsk.send(event, 'x'.repeat(4001)), false)
    const first = quickAsk.send(event, '  Original prompt  ')
    const saved = deliveries[0]
    assert.equal(saved.prompt, 'Original prompt')
    quickAsk.acknowledge(otherSender, { ...saved, accepted: true })
    assert.equal(popup.visible, true)
    quickAsk.acknowledge(sender, { ...saved, accepted: false })
    assert.equal(await first, false)
    assert.equal(popup.visible, true)
    const second = quickAsk.send(event, 'Original prompt')
    assert.deepEqual(deliveries[1], saved)
    quickAsk.acknowledge({ ...sender, senderFrame: {} }, { ...saved, accepted: true })
    quickAsk.acknowledge(sender, { ...saved, accepted: true })
    assert.equal(await second, true)
    assert.equal(shown, 1)
    assert.equal(popup.visible, false)
    language = 'de'
    quickAsk.toggle(board)
    assert.deepEqual(copies.at(-1), { ...shellCopy('de','quickAsk'), appearance: 'light' })
    const stale = quickAsk.send(event, 'Unacknowledged prompt')
    epoch = 'second'
    quickAsk.invalidate(other)
    assert.equal(popup.isDestroyed(), false)
    quickAsk.invalidate(board)
    assert.equal(await stale, false)
    assert.equal(popup.isDestroyed(), true)
    assert.equal(await quickAsk.send(event, 'Old workspace'), false)
})
