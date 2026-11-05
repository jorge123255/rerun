// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'

// A regression guard for the production dependency boundary, not a fake hosted store.
// Importing the hosted renderer from the Mac path must fail this test immediately.
vi.mock('@/stores/board.store', () => { throw new Error('Desktop routine prompt imported the hosted board store') })
import { DesktopScheduledRunBlock } from './DesktopScheduledRunBlock'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

test('uses the original divider and prompt dialog without hosted initialization or remote images', async () => {
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    try {
        await act(async () => { root.render(<DesktopScheduledRunBlock run={{ slug: 'daily', name: 'Daily notes', prompt: 'Read **today’s notes**.\n\n![tracker](https://example.invalid/private.png)\n\n[Website](https://example.com/)\n\n[Local file](file:///private/notes.md)' }} />) })
        expect(container.textContent).toContain('Scheduled run')
        expect(container.textContent).toContain('Daily notes')
        expect(document.querySelector('[role="dialog"]')).toBeNull()
        const button = [...container.querySelectorAll('button')].find(item => item.textContent === 'View prompt')!
        expect(button).toBeDefined()
        await act(async () => { button.click() })
        const dialog = document.querySelector('[role="dialog"]')!
        expect(dialog.textContent).toContain('Daily notes prompt')
        expect(dialog.textContent).toContain('today’s notes')
        expect(dialog.querySelector('img')).toBeNull()
        expect(dialog.querySelector('a[href^="file:"]')).toBeNull()
        expect(dialog.querySelector('a[href="https://example.com/"]')?.getAttribute('rel')).toBe('noopener noreferrer')
    } finally { await act(async () => { root.unmount() }); container.remove() }
})
