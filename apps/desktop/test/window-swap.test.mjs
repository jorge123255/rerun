import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { swapWorkspaceWindow } from '../src/main/window-swap.mjs'

function win(bounds, flags = {}) {
    return Object.assign(new EventEmitter(), { bounds, shown: false, hidden: false, focused: false, ...flags,
        isDestroyed() { return !!this.destroyed }, isFullScreen() { return !!this.fullScreen }, isMinimized() { return !!this.minimized },
        getBounds() { return this.bounds }, setBounds(next) { this.bounds = next }, show() { this.shown = true; this.hidden = false }, hide() { this.hidden = true }, focus() { this.focused = true }, restore() { this.minimized = false } })
}

test('the window being shown takes the place of the one being left, which is hidden and not closed', () => {
    const cloud = win({ x: 40, y: 60, width: 1300, height: 820 }), local = win({ x: 0, y: 0, width: 900, height: 600 })
    assert.equal(swapWorkspaceWindow(cloud, local), true)
    assert.deepEqual(local.bounds, { x: 40, y: 60, width: 1300, height: 820 })
    assert.equal(local.shown && local.focused, true)
    assert.equal(cloud.hidden, true)
    assert.equal(cloud.isDestroyed(), false)
})

test('a full-screen or minimized window keeps its own place; nothing to leave just shows the window', () => {
    const local = win({ x: 0, y: 0, width: 900, height: 600 })
    swapWorkspaceWindow(win({ x: 5, y: 5, width: 500, height: 500 }, { minimized: true }), local)
    assert.deepEqual(local.bounds, { x: 0, y: 0, width: 900, height: 600 })
    const alone = win({ x: 1, y: 2, width: 3, height: 4 })
    assert.equal(swapWorkspaceWindow(null, alone), true)
    assert.equal(alone.shown, true)
    assert.equal(swapWorkspaceWindow(alone, alone), true)
    assert.equal(alone.hidden, false)
    assert.equal(swapWorkspaceWindow(alone, win({}, { destroyed: true })), false)
})
