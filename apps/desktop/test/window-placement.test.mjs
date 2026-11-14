import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWindowPlacements, restoreWindowZoom } from '../src/main/window-placement.mjs'

const primary = { workArea: { x: 0, y: 24, width: 1400, height: 900 } }
const left = { workArea: { x: -1600, y: 24, width: 1600, height: 980 } }

class Window extends EventEmitter {
    constructor(bounds) { super(); this.bounds = bounds }
    getNormalBounds() { return this.bounds }
    isDestroyed() { return false }
    isMinimized() { return !!this.minimized }
    isFullScreen() { return !!this.fullScreen }
    isMaximized() { return !!this.maximized }
    maximize() { this.maximized = true }
}

async function fixture(t) {
    const dataRoot = await mkdtemp(join(tmpdir(), 'rerun-window-placement-'))
    t.after(() => rm(dataRoot, { recursive: true, force: true }))
    const screen = { getPrimaryDisplay: () => primary, getDisplayMatching: () => left }
    return { dataRoot, screen, load: () => createWindowPlacements({ dataRoot, screen }) }
}

test('primary board and hub placements are independent and the newest geometry survives reopen', async t => {
    const { dataRoot, load } = await fixture(t)
    const boardBounds = { x: -1450, y: 75, width: 1100, height: 740 }
    const hubBounds = { x: -1300, y: 115, width: 940, height: 660 }
    const board = new Window({ ...boardBounds, x: -1425 })
    const hub = new Window(hubBounds)
    const store = load()
    store.track('local-board', board)
    store.track('https://hub.example', hub)
    board.emit('move')
    hub.maximize()
    hub.emit('maximize')
    board.bounds = boardBounds
    board.emit('resize')
    await store.flush()

    const reopened = load()
    assert.deepEqual(await reopened.restore('local-board'), { bounds: boardBounds, maximized: false })
    assert.deepEqual(await reopened.restore('https://hub.example'), { bounds: hubBounds, maximized: true })
    assert.deepEqual(await reopened.restore('https://other.example'), { bounds: { width: 1220, height: 820 }, maximized: false })
    assert.equal((await readdir(dataRoot)).length, 2)
    const restoredHub = new Window(hubBounds)
    restoreWindowZoom(restoredHub, true)
    assert.equal(restoredHub.isMaximized(), false)
    restoredHub.emit('show')
    assert.equal(restoredHub.isMaximized(), true)
    restoredHub.maximized = false
    restoredHub.emit('show')
    assert.equal(restoredHub.isMaximized(), false)
})

test('minimized or fullscreen snapshots cannot overwrite the last normal placement at close', async t => {
    const { load } = await fixture(t)
    const bounds = { x: -1400, y: 54, width: 950, height: 650 }
    const window = new Window(bounds)
    const store = load()
    const capture = store.track('local-board', window)
    window.emit('move')
    window.bounds = left.workArea
    window.fullScreen = true
    window.emit('resize')
    capture()
    await store.flush()
    window.fullScreen = false
    window.minimized = true
    capture()
    await store.flush()
    assert.deepEqual(await load().restore('local-board'), { bounds, maximized: false })
})

test('restoring window placement clamps a visible window and centers it when its display is gone', async t => {
    const { screen, load } = await fixture(t)
    const window = new Window({ x: -30, y: 54, width: 1050, height: 880 })
    const store = load()
    store.track('local-board', window)()
    await store.flush()
    assert.deepEqual(await store.restore('local-board'),
        { bounds: { x: -1050, y: 54, width: 1050, height: 880 }, maximized: false })

    window.bounds = { x: -1560, y: 54, width: 1520, height: 950 }
    store.track('local-board', window)()
    await store.flush()
    screen.getDisplayMatching = () => primary
    assert.deepEqual(await store.restore('local-board'),
        { bounds: { width: 1400, height: 900 }, maximized: false })
})

test('a corrupt preference falls back to a usable main window', async t => {
    const { dataRoot, load } = await fixture(t)
    const store = load()
    store.track('local-board', new Window({ x: -1400, y: 54, width: 950, height: 650 }))()
    await store.flush()
    const [name] = await readdir(dataRoot)
    const path = join(dataRoot, name)
    const saved = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...saved, bounds: { ...saved.bounds, width: -1 }, maximized: true }))
    assert.deepEqual(await load().restore('local-board'), { bounds: { width: 1220, height: 820 }, maximized: false })
})
