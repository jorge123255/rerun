// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopFileCard } from './DesktopFileCard'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

const card = { kind: 'file' as const, files: [
    { path: 'reports/summary.md', name: 'summary.md', size: 7, scope: 'agent' as const },
    { path: 'reports/notes.txt', name: 'notes.txt', size: 5, scope: 'agent' as const },
] }

test('draws the original file tiles and keeps them openable for a trusted coworker', async () => {
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    try {
        await act(async () => root.render(<DesktopFileCard agentId="agent-1" card={card} />))
        const tiles = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Open "]'))
        expect(tiles.map(tile => tile.getAttribute('aria-label'))).toEqual(['Open summary.md', 'Open notes.txt'])
        expect(tiles.every(tile => !tile.disabled)).toBe(true)
        expect(document.querySelector('[data-file-card]')).not.toBeNull()
        expect(document.querySelector('a[download]')).toBeNull()
    } finally { await act(async () => root.unmount()) }
})

test('shows the same inert tiles when no trusted coworker id is available', async () => {
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    try {
        await act(async () => root.render(<DesktopFileCard card={card} />))
        const tiles = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Open "]'))
        expect(tiles).toHaveLength(2)
        expect(tiles.every(tile => tile.disabled)).toBe(true)
    } finally { await act(async () => root.unmount()) }
})
