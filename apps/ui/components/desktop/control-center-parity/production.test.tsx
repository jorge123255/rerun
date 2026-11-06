// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { ControlCenterView } from '@/components/control-center/ControlCenterView'
vi.mock('@/components/control-center/ControlCenterView', () => ({ ControlCenterView: (props: ComponentProps<typeof ControlCenterView>) => <div>{props.sections.flatMap(section => section.rows.map(row => <button key={row.id} onClick={row.onSelect}>{row.label}</button>))}</div> }))
vi.mock('@/lib/desktop/recent-coworkers', () => ({ useDesktopRecentCoworkers: () => ({ recentAgentIds: [], retry: () => {} }) }))
vi.mock('@/lib/desktop/use-control-center-chats', () => ({ useDesktopControlCenterChats: () => ({ loading: false, failed: false, refresh: async () => null }) }))
vi.mock('@/lib/desktop/control-center', async original => ({ ...await original<typeof import('@/lib/desktop/control-center')>(), useDesktopConversationSearch: () => ({ hits: [], loading: false, failed: false, hasMore: false, retry: () => {} }), useDesktopControlCenterKeys: () => {} }))
import { DesktopControlCenter } from '../DesktopControlCenter'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const agent = { id: 'a', name: 'Coworker', description: '', enabled: true, createdAt: 'now', updatedAt: 'now' }
const board = { revision: 1, spaces: [], placements: [] }
let root: ReturnType<typeof createRoot>, host: HTMLDivElement
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
const mount = (onTemplates: () => void, open = true) => act(async () => root.render(<DesktopControlCenter open={open} coworkers={[agent]} board={board} selectedCoworkerId={null} onOpenConversation={() => {}} onAddCoworker={() => {}} onModelSettings={() => {}} onBackToBoard={() => {}} onTemplates={onTemplates} />))
it('mounts Browse templates in the existing Control Center and revalidates canonical workspace before opening', async () => {
    const open = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/agents') ? { agents: [agent] } : { board })))
    await mount(open)
    const button = [...host.querySelectorAll('button')].find(button => button.textContent === 'Browse templates')!
    expect(button).toBeTruthy()
    await act(async () => { button.click() })
    expect(open).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})
it('closing the mounted palette cancels the outstanding current-workspace read before navigation', async () => {
    let release!: (response: Response) => void
    const pending = new Promise<Response>(resolve => { release = resolve })
    vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/agents') ? pending : Promise.resolve(Response.json({ board }))))
    const open = vi.fn(); await mount(open)
    await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === 'Browse templates')!.click() })
    await mount(open, false)
    await act(async () => { release(Response.json({ agents: [agent] })) })
    expect(open).not.toHaveBeenCalled()
})
