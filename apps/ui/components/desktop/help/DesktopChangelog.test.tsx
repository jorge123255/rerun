// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopChangelog, useDesktopChangelog } from './DesktopChangelog'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@rerun/ui/steps', async importOriginal => ({
    ...await importOriginal<typeof import('@rerun/ui/steps')>(),
    StepTransition: ({ children }: { children: React.ReactNode }) => children,
}))

const newest = { slug: 'new-release', title: 'New release', publishedAt: new Date(Date.now() - 1000).toISOString(), body: 'A new feature', image: null, darkImage: null, imageAlt: '' }
const older = { ...newest, slug: 'older-release', title: 'Earlier release', publishedAt: new Date(Date.now() - 10_000).toISOString() }
const button = (name: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === name)
const click = async (name: string) => {
    const target = button(name)
    expect(target, name).toBeDefined()
    await act(async () => { target!.click() })
}
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
const dialog = () => document.querySelector('[role="dialog"]')
function Harness({ ready }: { ready: boolean }) {
    const state = useDesktopChangelog('exact-launch', ready)
    return <><button type="button" onClick={state.show}>Show updates</button><DesktopChangelog state={state} /></>
}
let root: Root | undefined
async function mount(ready: boolean) {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root!.render(<Harness ready={ready} />) })
}
afterEach(async () => {
    await act(async () => { root?.unmount() })
    root = undefined
    document.body.replaceChildren()
    vi.unstubAllGlobals()
})

test('waits for the board, opens unread slides once, and acknowledges the exact newest entry', async () => {
    vi.stubGlobal('desktopApp', { getStatus: () => {} })
    const fetcher = vi.fn(async (_input: string, init?: RequestInit) => init?.method === 'PATCH'
        ? Response.json({ seenAt: newest.publishedAt })
        : Response.json({ entries: [newest, older], seenAt: older.publishedAt, stale: false }))
    vi.stubGlobal('fetch', fetcher)
    await mount(false)
    await flush()
    expect(dialog()).toBeNull()
    await act(async () => { root!.render(<Harness ready />) })
    await flush()
    expect(dialog()?.textContent).toContain('New release')
    expect(button('Next')).toBeUndefined()
    await click('Done')
    await flush()
    expect(dialog()).toBeNull()
    expect(fetcher).toHaveBeenCalledWith('/api/desktop/changelog', expect.objectContaining({
        method: 'PATCH', body: JSON.stringify({ slug: newest.slug, publishedAt: newest.publishedAt }),
    }))

    await click('Show updates')
    await click('Next')
    expect(dialog()?.textContent).toContain('Earlier release')
    expect(dialog()?.querySelector('a')?.getAttribute('href')).toBe('https://rerun.build/changelog#older-release')
    await click('Back')
    expect(dialog()?.textContent).toContain('New release')
})

test('offers retry and the official changelog link when the local feed is unavailable', async () => {
    const fetcher = vi.fn()
        .mockResolvedValueOnce(Response.json({ entries: [], seenAt: older.publishedAt, stale: true }))
        .mockResolvedValueOnce(Response.json({ entries: [newest], seenAt: older.publishedAt, stale: false }))
    vi.stubGlobal('fetch', fetcher)
    await mount(true)
    expect(fetcher).not.toHaveBeenCalled()
    await click('Show updates')
    await flush()
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain('Try again')
    expect(dialog()?.querySelector('a')?.getAttribute('href')).toBe('https://rerun.build/changelog')
    await click('Try again')
    await flush()
    expect(dialog()?.textContent).toContain('New release')
})
