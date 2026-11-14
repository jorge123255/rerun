import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { atomicPrivateJSON, readJSON } from './workspaces/paths.mjs'

const defaultSize = { width: 1220, height: 820 }
export const macWorkspaceMinimumSize = { minWidth: 360, minHeight: 480 }

function validBounds(bounds) {
    return bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger)
        && bounds.width > 0 && bounds.height > 0
}

export function captureWindowPlacement(window) {
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return null
    const bounds = window.getNormalBounds()
    return validBounds(bounds) ? { bounds, maximized: window.isMaximized() } : null
}

export function restoreWindowZoom(window, maximized) {
    if (maximized) window.once('show', () => window.maximize())
}

export function createWindowPlacements({ dataRoot, screen }) {
    const pending = new Map()
    let timer
    let writes = Promise.resolve()
    const pathFor = scope => join(dataRoot, `window-placement-${createHash('sha256').update(scope).digest('hex')}.json`)

    function flush() {
        clearTimeout(timer)
        for (const [path, placement] of pending) {
            writes = writes.then(() => atomicPrivateJSON(path, { version: 1, ...placement })).catch(() => {
                console.warn('Could not save the Rerun window position.')
            })
        }
        pending.clear()
        return writes
    }

    return {
        flush,
        async restore(scope) {
            await flush()
            const saved = await readJSON(pathFor(scope)).catch(() => null)
            const bounds = saved?.version === 1 && validBounds(saved.bounds) ? saved.bounds : null
            const display = bounds && screen.getDisplayMatching(bounds)
            const area = display?.workArea
            // The title bar must intersect a current work area to reuse the position.
            const visible = area && bounds.x < area.x + area.width && bounds.x + bounds.width > area.x
                && bounds.y < area.y + area.height && bounds.y + 40 > area.y
            const work = visible ? area : screen.getPrimaryDisplay().workArea
            const width = Math.min((bounds ?? defaultSize).width, work.width)
            const height = Math.min((bounds ?? defaultSize).height, work.height)
            return {
                bounds: visible ? {
                    x: Math.max(work.x, Math.min(bounds.x, work.x + work.width - width)),
                    y: Math.max(work.y, Math.min(bounds.y, work.y + work.height - height)),
                    width, height,
                } : { width, height },
                maximized: !!bounds && saved.maximized === true,
            }
        },
        track(scope, window) {
            const path = pathFor(scope)
            const capture = () => {
                const placement = captureWindowPlacement(window)
                if (placement) pending.set(path, placement)
            }
            const later = () => {
                capture()
                clearTimeout(timer)
                timer = setTimeout(flush, 400)
            }
            for (const event of ['move', 'resize', 'maximize', 'unmaximize']) window.on(event, later)
            return capture
        },
    }
}
