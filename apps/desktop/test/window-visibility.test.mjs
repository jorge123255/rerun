import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { hideWorkspaceWindow, revealWorkspaceWindow } from '../src/main/window-visibility.mjs'

function fixture({ fullscreen = true, minimized = false } = {}) {
    const calls = []
    const window = Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        isFullScreen: () => fullscreen,
        isMinimized: () => minimized,
        setFullScreen: value => calls.push(['fullscreen', value]),
        hide: () => calls.push('hide'),
        restore: () => calls.push('restore'),
        show: () => calls.push('show'),
        focus: () => calls.push('focus'),
    })
    return { calls, window }
}

test('closing a fullscreen workspace exits its Space before hiding, even when Close is repeated', () => {
    const { calls, window } = fixture()
    hideWorkspaceWindow(window)
    hideWorkspaceWindow(window)
    assert.deepEqual(calls, [['fullscreen', false]])
    window.emit('leave-full-screen')
    window.emit('leave-full-screen')
    assert.deepEqual(calls, [['fullscreen', false], 'hide'])
})

test('reopening a workspace cancels the pending hide and restores minimized windows', () => {
    const { calls, window } = fixture({ minimized: true })
    hideWorkspaceWindow(window)
    revealWorkspaceWindow(window)
    window.emit('leave-full-screen')
    assert.deepEqual(calls, [['fullscreen', false], 'restore', 'show', 'focus'])
})

test('closing a windowed workspace hides it immediately', () => {
    const { calls, window } = fixture({ fullscreen: false })
    hideWorkspaceWindow(window)
    assert.deepEqual(calls, ['hide'])
})
