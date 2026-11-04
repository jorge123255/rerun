// @vitest-environment happy-dom
// Real IsoGrid pointer handlers; root executes this regression before changing the shared grid.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { GRID_SIZE, IsoGrid, TILE_H, TILE_W, isoPosition, type Container, type Tile } from '@rerun/ui/iso-grid'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots = new Set<ReturnType<typeof createRoot>>()
const width = 1200
const height = 900
const pointerId = 7
const source: Container = { id: 'review', label: 'Review', color: '#808080', col_start: 0, row_start: 0, col_end: 5, row_end: 5 }
const destination: Container = { id: 'project', label: 'Project', color: '#808080', col_start: 8, row_start: 0, col_end: 13, row_end: 5 }
const coworker: Tile = { id: 'coworker', position: { col: 1, row: 1 }, span: 2, containerId: source.id, style: { color: '#808080' } }

beforeEach(() => {
    // Geometry and capture are browser facilities happy-dom does not lay out or implement.
    // The grid, coordinate conversion, threshold, collision checks and event handlers stay real.
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(width)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(height)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}),
    })
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})

afterEach(async () => {
    await act(async () => { for (const root of roots) root.unmount() })
    roots.clear()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

// At zoom 1/pan 0, choose an interior point of the requested anchor, away from floor boundaries.
// It is also inside that grid cell for the Box grab path.
function point(col: number, row: number) {
    const anchor = isoPosition(col, row)
    const center = isoPosition(GRID_SIZE / 2, GRID_SIZE / 2)
    return { x: width / 2 + anchor.left + TILE_W / 2 - center.left,
        y: height / 2 + anchor.top + TILE_H * 0.75 - center.top }
}

function send(grid: HTMLElement, type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', at: { x: number; y: number }) {
    grid.dispatchEvent(new PointerEvent(type, {
        pointerId, pointerType: 'mouse', isPrimary: true, button: 0,
        buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
        clientX: at.x, clientY: at.y, bubbles: true, cancelable: true,
    }))
}

async function mount() {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    roots.add(root)
    const onTileMove = vi.fn()
    const onContainerMove = vi.fn()
    const onTileSelect = vi.fn()
    const onContainerSelect = vi.fn()
    await act(async () => {
        root.render(<IsoGrid tiles={[coworker]} containers={[source, destination]}
            initialCamera={{ zoom: 1, pan: { x: 0, y: 0 } }} scrollGestures={false} paused
            onTileMove={onTileMove} onContainerMove={onContainerMove}
            onTileSelect={onTileSelect} onContainerSelect={onContainerSelect} />)
    })
    const grid = host.querySelector<HTMLElement>('[aria-label="Coworker board"]')!
    expect(grid).not.toBeNull()
    const captures = new Set<number>()
    const capture = vi.fn((id: number) => { captures.add(id) })
    Object.defineProperties(grid, {
        setPointerCapture: { configurable: true, value: capture },
        hasPointerCapture: { configurable: true, value: (id: number) => captures.has(id) },
        releasePointerCapture: { configurable: true, value: (id: number) => { captures.delete(id) } },
    })
    return { grid, onTileMove, onContainerMove, onTileSelect, onContainerSelect, capture, captures }
}

function expectSettled(grid: HTMLElement) {
    expect(grid.querySelector('.iso-tile.cursor-grabbing')).toBeNull()
    expect(grid.querySelector('polygon[stroke-dasharray="4 3"]')).toBeNull()
    expect(grid.querySelector('.iso-space-dash-ghost')).toBeNull()
}

test('one cross-Box move and release in the same batch commits the coworker exactly once', async () => {
    const ui = await mount()
    await act(async () => {
        send(ui.grid, 'pointerdown', point(1, 1))
        send(ui.grid, 'pointermove', point(9, 1))
        send(ui.grid, 'pointerup', point(9, 1))
    })
    expect(ui.capture).toHaveBeenCalledWith(pointerId)
    expect(ui.onTileMove).toHaveBeenCalledExactlyOnceWith(coworker.id, { col: 9, row: 1 }, destination.id)
    expect(ui.onTileSelect).not.toHaveBeenCalled()
    expect(ui.onContainerMove).not.toHaveBeenCalled()
    expect(ui.captures.size).toBe(0)
    expectSettled(ui.grid)
})

test('an established coworker drag uses the final cross-Box move when move and release are batched', async () => {
    const ui = await mount()
    await act(async () => {
        send(ui.grid, 'pointerdown', point(1, 1))
        send(ui.grid, 'pointermove', point(2, 1))
    })
    expect(ui.grid.querySelector('.iso-tile.cursor-grabbing')).not.toBeNull()
    await act(async () => {
        send(ui.grid, 'pointermove', point(9, 1))
        send(ui.grid, 'pointerup', point(9, 1))
    })
    expect(ui.onTileMove).toHaveBeenCalledExactlyOnceWith(coworker.id, { col: 9, row: 1 }, destination.id)
    expect(ui.onTileSelect).not.toHaveBeenCalled()
    expect(ui.captures.size).toBe(0)
    expectSettled(ui.grid)
})

test('cancelling a coworker drag clears its ghost without moving or opening it', async () => {
    const ui = await mount()
    await act(async () => {
        send(ui.grid, 'pointerdown', point(1, 1))
        send(ui.grid, 'pointermove', point(2, 1))
    })
    await act(async () => { send(ui.grid, 'pointermove', point(9, 1)) })
    expect(ui.grid.querySelector('.iso-tile.cursor-grabbing')).not.toBeNull()
    await act(async () => { send(ui.grid, 'pointercancel', point(9, 1)) })
    expect(ui.onTileMove).not.toHaveBeenCalled()
    expect(ui.onTileSelect).not.toHaveBeenCalled()
    expect(ui.captures.size).toBe(0)
    expectSettled(ui.grid)
})

test('one Box move and release in the same batch commits the final rectangle exactly once', async () => {
    const ui = await mount()
    await act(async () => {
        send(ui.grid, 'pointerdown', point(4, 4))
        send(ui.grid, 'pointermove', point(4, 12))
        send(ui.grid, 'pointerup', point(4, 12))
    })
    expect(ui.capture).toHaveBeenCalledWith(pointerId)
    expect(ui.onContainerMove).toHaveBeenCalledExactlyOnceWith(source.id, { col_start: 0, row_start: 8, col_end: 5, row_end: 13 })
    expect(ui.onContainerSelect).not.toHaveBeenCalled()
    expect(ui.onTileMove).not.toHaveBeenCalled()
    expect(ui.captures.size).toBe(0)
    expectSettled(ui.grid)
})

test('an established Box drag uses its final move when move and release are batched', async () => {
    const ui = await mount()
    await act(async () => {
        send(ui.grid, 'pointerdown', point(4, 4))
        send(ui.grid, 'pointermove', point(4, 5))
    })
    expect(ui.grid.querySelector('.iso-space-dash-ghost')).not.toBeNull()
    await act(async () => {
        send(ui.grid, 'pointermove', point(4, 12))
        send(ui.grid, 'pointerup', point(4, 12))
    })
    expect(ui.onContainerMove).toHaveBeenCalledExactlyOnceWith(source.id, { col_start: 0, row_start: 8, col_end: 5, row_end: 13 })
    expect(ui.onContainerSelect).not.toHaveBeenCalled()
    expect(ui.captures.size).toBe(0)
    expectSettled(ui.grid)
})

test('cancelling an established Box drag returns its members without committing a move', async () => {
    const ui = await mount()
    const tile = ui.grid.querySelector<HTMLElement>('[data-tile-id="coworker"]')!
    const original = { left: tile.style.left, top: tile.style.top }
    await act(async () => {
        send(ui.grid, 'pointerdown', point(4, 4))
        send(ui.grid, 'pointermove', point(4, 5))
    })
    await act(async () => { send(ui.grid, 'pointermove', point(4, 12)) })
    expect(tile.style.top).not.toBe(original.top)
    await act(async () => { send(ui.grid, 'pointercancel', point(4, 12)) })
    expect(ui.onContainerMove).not.toHaveBeenCalled()
    expect(ui.onContainerSelect).not.toHaveBeenCalled()
    expect(tile.style.left).toBe(original.left)
    expect(tile.style.top).toBe(original.top)
    expect(ui.captures.size).toBe(0)
    expectSettled(ui.grid)
})
