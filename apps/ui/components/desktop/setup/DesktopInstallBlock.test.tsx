// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopInstallBlock } from './DesktopInstallBlock'

// Loading a hosted owner store is itself a regression: the desktop has no Supabase session.
vi.mock('@/stores/board.store', () => { throw new Error('Desktop install guide imported the hosted board store') })
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => {
    if (root) act(() => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
})

it('keeps the original divider and guide dialog without hosted state or automatic requests', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopInstallBlock agentId="local-owner" agentName="Local Coworker" installing guide="## Check your files\nRead the workspace instructions." />))
    expect(document.body.textContent).toContain('Install started')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'View guide')!.click() })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Local Coworker install guide')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Check your files')
    expect(fetch).not.toHaveBeenCalled()
    await act(async () => root!.render(<DesktopInstallBlock agentId="local-owner" agentName="Renamed Coworker" guide="## Check your files\nRead the workspace instructions." />))
    expect(document.body.textContent).toContain('Install complete')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Renamed Coworker install guide')
})

it('uses the desktop guide policy for links and remote images', async () => {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopInstallBlock agentName="Local" guide={'[Safe](https://example.com/help)\n\n[Local file](file:///tmp/private)\n\n![Remote image](https://example.com/private.png)'} />))
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'View guide')!.click() })
    const dialog = document.querySelector('[role="dialog"]')!
    expect([...dialog.querySelectorAll('a')].map(link => link.getAttribute('href'))).toEqual(['https://example.com/help'])
    expect(dialog.querySelector('img')).toBeNull()
    expect(dialog.textContent).toContain('Remote image')
})
