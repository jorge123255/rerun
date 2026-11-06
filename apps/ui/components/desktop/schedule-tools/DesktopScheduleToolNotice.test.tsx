// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopScheduleToolNotice } from './DesktopScheduleToolNotice'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: ReturnType<typeof createRoot>, container: HTMLDivElement
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

test('a schedule tool notice shows the outcome and does not fetch or run a routine', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => { root.render(<DesktopScheduleToolNotice outcome="uncertain" text="Schedule change was not acknowledged. Retry the same change." />) })
    expect(container.querySelector('[data-outcome="uncertain"]')?.textContent).toContain('Uncertain.')
    expect(container.textContent).toContain('This does not run the routine.')
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
})
