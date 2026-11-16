import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { prefersReducedMotion, swapWorkspaceWindow } from '../src/main/window-swap.mjs'

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

// A window that records every opacity it was given, and timers the test advances by hand.
function fading(bounds, flags = {}) {
    return Object.assign(win(bounds, flags), { opacity: 1, opacities: [],
        setOpacity(value) { this.opacity = value; this.opacities.push(value) },
        isVisible() { return this.shown && !this.hidden } })
}
function fakeTimers() {
    const pending = new Map()
    let next = 1
    return { pending, setInterval(run) { pending.set(next, run); return next++ }, clearInterval(id) { pending.delete(id) },
        tick(times = 1) { for (let i = 0; i < times; i++) for (const run of [...pending.values()]) run() } }
}
const place = { x: 40, y: 60, width: 1300, height: 820 }

test('with fade, the shown window fades in over the one being left, which is hidden only when the fade ends', () => {
    const cloud = Object.assign(fading(place), { shown: true }), local = fading({ x: 0, y: 0, width: 900, height: 600 }), timers = fakeTimers()
    assert.equal(swapWorkspaceWindow(cloud, local, { fade: true, timers }), true)
    assert.deepEqual(local.bounds, place)
    assert.deepEqual(local.opacities, [0])
    assert.equal(local.shown && local.focused, true)
    assert.equal(cloud.hidden, false)
    timers.tick(3)
    assert.equal(local.opacity > 0 && local.opacity < 1, true)
    assert.deepEqual(local.opacities, [...local.opacities].sort((a, b) => a - b))
    assert.equal(cloud.hidden, false)
    timers.tick(20)
    assert.equal(local.opacity, 1)
    assert.equal(cloud.hidden, true)
    assert.equal(cloud.opacity, 1)
    assert.deepEqual(cloud.opacities, [])
    assert.equal(timers.pending.size, 0)
})

test('the fade lasts about 150 ms', () => {
    const cloud = Object.assign(fading(place), { shown: true }), local = fading(place), timers = fakeTimers()
    swapWorkspaceWindow(cloud, local, { fade: true, timers })
    timers.tick(8)
    assert.equal(cloud.hidden, false)
    timers.tick(1)
    assert.equal(cloud.hidden, true)
    assert.equal(local.opacity, 1)
})

test('Reduce motion swaps instantly and never touches opacity', () => {
    const cloud = Object.assign(fading(place), { shown: true }), local = fading(place), timers = fakeTimers()
    const reduce = prefersReducedMotion({ nativeTheme: { prefersReducedMotion: true } })
    assert.equal(swapWorkspaceWindow(cloud, local, { fade: !reduce, timers }), true)
    assert.deepEqual(local.opacities, [])
    assert.equal(local.shown, true)
    assert.equal(cloud.hidden, true)
    assert.equal(timers.pending.size, 0)
})

test('Reduce motion is read from either Electron setting, and an unreadable one counts as reduce', () => {
    assert.equal(prefersReducedMotion({ nativeTheme: { prefersReducedMotion: false }, systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: false }) } }), false)
    assert.equal(prefersReducedMotion({ nativeTheme: {}, systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: true }) } }), true)
    assert.equal(prefersReducedMotion({ nativeTheme: { prefersReducedMotion: true } }), true)
    assert.equal(prefersReducedMotion({ systemPreferences: { getAnimationSettings() { throw new Error('unavailable') } } }), true)
    assert.equal(prefersReducedMotion(), false)
})

test('a fade that fails part-way ends with the shown window opaque and the other hidden', () => {
    const cloud = Object.assign(fading(place), { shown: true }), local = fading(place), timers = fakeTimers()
    const set = local.setOpacity
    let calls = 0
    local.setOpacity = function (value) { calls += 1; if (calls === 3) throw new Error('opacity failed'); set.call(this, value) }
    swapWorkspaceWindow(cloud, local, { fade: true, timers })
    timers.tick(1)
    assert.equal(local.opacity > 0 && local.opacity < 1, true)
    timers.tick(1)
    assert.equal(local.opacity, 1)
    assert.equal(cloud.hidden, true)
    assert.equal(timers.pending.size, 0)
})

test('a fade that cannot start shows the window opaque at once', () => {
    const cloud = Object.assign(fading(place), { shown: true }), local = fading(place), timers = fakeTimers()
    let calls = 0
    local.setOpacity = function (value) { calls += 1; if (calls === 1) throw new Error('opacity failed'); this.opacity = value }
    assert.equal(swapWorkspaceWindow(cloud, local, { fade: true, timers }), true)
    assert.equal(local.shown, true)
    assert.equal(local.opacity, 1)
    assert.equal(cloud.hidden, true)
    assert.equal(timers.pending.size, 0)
})

test('the shown window closing mid-fade leaves the other window on screen, untouched', () => {
    const cloud = Object.assign(fading(place), { shown: true }), local = fading(place), timers = fakeTimers()
    swapWorkspaceWindow(cloud, local, { fade: true, timers })
    timers.tick(2)
    local.destroyed = true
    const seen = local.opacities.length
    timers.tick(5)
    assert.equal(local.opacities.length, seen)
    assert.equal(cloud.hidden, false)
    assert.equal(cloud.opacity, 1)
    assert.equal(timers.pending.size, 0)
})

test('the window being left closing mid-fade still ends with the shown window opaque', () => {
    const cloud = Object.assign(fading(place), { shown: true }), local = fading(place), timers = fakeTimers()
    swapWorkspaceWindow(cloud, local, { fade: true, timers })
    timers.tick(2)
    cloud.destroyed = true
    timers.tick(1)
    assert.equal(local.opacity, 1)
    assert.equal(cloud.hidden, false)
    assert.equal(timers.pending.size, 0)
})

test('swapping back during a fade settles it first: no window is left half transparent', () => {
    const cloud = Object.assign(fading(place), { shown: true }), local = fading(place), timers = fakeTimers()
    swapWorkspaceWindow(cloud, local, { fade: true, timers })
    timers.tick(2)
    assert.equal(swapWorkspaceWindow(local, cloud, { fade: true, timers }), true)
    assert.equal(local.opacity, 1)
    assert.deepEqual(cloud.opacities, [0])
    timers.tick(20)
    assert.equal(cloud.opacity, 1)
    assert.equal(local.opacity, 1)
    assert.equal(local.hidden, true)
    assert.equal(cloud.shown && !cloud.hidden, true)
    assert.equal(timers.pending.size, 0)
})

test('a window already on screen, a full-screen one or one with nothing to leave is not faded', () => {
    const timers = fakeTimers()
    const visible = Object.assign(fading(place), { shown: true })
    swapWorkspaceWindow(Object.assign(fading(place), { shown: true }), visible, { fade: true, timers })
    const alone = fading(place)
    swapWorkspaceWindow(null, alone, { fade: true, timers })
    const full = fading(place, { fullScreen: true })
    swapWorkspaceWindow(Object.assign(fading(place), { shown: true }), full, { fade: true, timers })
    assert.deepEqual([visible.opacities, alone.opacities, full.opacities], [[], [], []])
    assert.equal(alone.shown && full.shown, true)
    assert.equal(timers.pending.size, 0)
})
