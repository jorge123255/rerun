// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopForemanConversations } from './DesktopForemanConversations'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const home = { workspaceId: '1', chatId: 'fmc_00000000-0000-4000-8000-000000000000' }
const pricing = { workspaceId: '1', chatId: 'fmc_00000000-0000-4000-8000-000000000001' }
const rows = [{ chat: home, title: null, home: true }, { chat: pricing, title: 'Pricing page', home: false }, { chat: { workspaceId: '2', chatId: 'fmc_00000000-0000-4000-8000-000000000002' }, title: 'Other workspace', home: false }]
const roots: Root[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => { root.unmount() }); document.body.innerHTML = ''; vi.unstubAllGlobals() })
async function mount(node: React.ReactNode) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => { root.render(node) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1)) })
    return host
}
const openClock = async (host: HTMLElement) => {
    const clock = host.querySelector<HTMLButtonElement>('button[aria-label="Conversations"]')!
    clock.focus()
    await act(async () => { clock.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    return [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[]
}

test('General reads nothing until the clock opens, then lists General first and this workspace\'s threads', async () => {
    const fetched = vi.fn(async () => Response.json({ conversations: rows }))
    vi.stubGlobal('fetch', fetched)
    const onSelect = vi.fn(async () => {})
    const host = await mount(<DesktopForemanConversations chat={home} disabled={false} onSelect={onSelect} />)
    expect(fetched).not.toHaveBeenCalled()
    expect(host.querySelector('[data-foreman-thread-crumb]')).toBeNull()
    const items = await openClock(host)
    expect(fetched).toHaveBeenCalledOnce()
    expect(items.map(item => [item.textContent, item.getAttribute('aria-current')])).toEqual([['General', 'true'], ['Pricing page', null]])
    expect(document.body.textContent).toContain('New task')
    await act(async () => { items[1].click() })
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(pricing)
})

test('a thread names itself beside the way back to General', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ conversations: rows })))
    const onSelect = vi.fn(async () => {})
    const host = await mount(<DesktopForemanConversations chat={pricing} thread disabled={false} onSelect={onSelect} />)
    const crumb = host.querySelector('[data-foreman-thread-crumb]')!
    expect(crumb.textContent).toBe('General/Pricing page')
    await act(async () => { crumb.querySelector<HTMLButtonElement>('button[aria-label="Back to General"]')!.click() })
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(null)
})

test('a workspace with only General says there is no thread yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ conversations: [rows[0]] })))
    const host = await mount(<DesktopForemanConversations chat={home} disabled={false} onSelect={vi.fn(async () => {})} />)
    await openClock(host)
    expect(document.body.textContent).toContain('No thread yet.')
})
