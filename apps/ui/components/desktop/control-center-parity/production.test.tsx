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
const mount = (onTemplates: () => void, open = true) => act(async () => root.render(<DesktopControlCenter open={open} runtimeWorkspaceId={1} coworkers={[agent]} board={board} selectedCoworkerId={null} onOpenConversation={() => {}} onAddCoworker={() => {}} onModelSettings={() => {}} onBackToBoard={() => {}} onTemplates={onTemplates} />))
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

it('exposes API keys & MCP through a bound callback in runtime workspace two after an observational recheck', async () => {
    const externalMcp = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/agents') ? { agents: [agent] } : { board })))
    await act(async () => root.render(<DesktopControlCenter open coworkers={[agent]} board={board} runtimeWorkspaceId={2} selectedCoworkerId={null} onOpenConversation={() => {}} onAddCoworker={() => {}} onModelSettings={() => {}} onBackToBoard={() => {}} onExternalMcp={externalMcp} />))
    const button = [...host.querySelectorAll('button')].find(button => button.textContent === 'API keys & MCP')!
    expect(button).toBeTruthy()
    await act(async () => { button.click() })
    expect(externalMcp).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
})

it('shows Servers only when bound and refuses a retained selection after the palette closes', async () => {
    const servers = vi.fn()
    const render = (open: boolean) => act(async () => root.render(<DesktopControlCenter open={open} runtimeWorkspaceId={1} coworkers={[agent]} board={board} runtimeWorkspaceId={2} selectedCoworkerId={null} onOpenConversation={() => {}} onAddCoworker={() => {}} onModelSettings={() => {}} onBackToBoard={() => {}} onServers={servers} />))
    await render(true)
    const button = [...host.querySelectorAll('button')].find(button => button.textContent === 'Servers')!
    expect(button).toBeTruthy()
    await render(false)
    await act(async () => { button.click() })
    expect(servers).not.toHaveBeenCalled()
})

it('does not dispatch a pending template navigation into a replacement workspace with the same board revision', async () => {
    let release!: (response: Response) => void
    const pending = new Promise<Response>(resolve => { release = resolve })
    vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/agents') ? pending : Promise.resolve(Response.json({ board }))))
    const templates = vi.fn()
    await mount(templates)
    await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === 'Browse templates')!.click() })
    await act(async () => root.render(<DesktopControlCenter open coworkers={[agent]} board={board} runtimeWorkspaceId={2} selectedCoworkerId={null} onOpenConversation={() => {}} onAddCoworker={() => {}} onModelSettings={() => {}} onBackToBoard={() => {}} onTemplates={templates} />))
    await act(async () => { release(Response.json({ agents: [agent] })) })
    expect(templates).not.toHaveBeenCalled()
})

it('performs one observational recheck for a double-clicked Servers row and refuses denied access after the await', async () => {
    let release!: (response: Response) => void
    const pending = new Promise<Response>(resolve => { release = resolve })
    vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/agents') ? pending : Promise.resolve(Response.json({ board }))))
    const servers = vi.fn()
    const render = (disabled = false) => act(async () => root.render(<DesktopControlCenter open disabled={disabled} coworkers={[agent]} board={board} runtimeWorkspaceId={1} selectedCoworkerId={null} onOpenConversation={() => {}} onAddCoworker={() => {}} onModelSettings={() => {}} onBackToBoard={() => {}} onServers={servers} />))
    await render()
    await act(async () => { const button = [...host.querySelectorAll('button')].find(button => button.textContent === 'Servers')!; button.click(); button.click() })
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/agents'))).toHaveLength(1)
    await render(true)
    await act(async () => { release(Response.json({ agents: [agent] })) })
    expect(servers).not.toHaveBeenCalled()
})

it('preserves an unrelated mounted draft and delegates the existing settings callback once', async () => {
    const settings = vi.fn(), conversation = vi.fn(), boardNavigation = vi.fn()
    await act(async () => root.render(<><textarea aria-label="Unsent draft" defaultValue="Keep **Markdown** and selection" /><DesktopControlCenter open coworkers={[agent]} board={board} runtimeWorkspaceId={1} selectedCoworkerId="a" onOpenConversation={conversation} onAddCoworker={() => {}} onModelSettings={settings} onBackToBoard={boardNavigation} /></>))
    const draft = host.querySelector('textarea')!
    draft.setSelectionRange(5, 15)
    await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === 'AI providers')!.click() })
    expect(settings).toHaveBeenCalledOnce()
    expect(conversation).not.toHaveBeenCalled(); expect(boardNavigation).not.toHaveBeenCalled()
    expect(host.querySelector('textarea')).toBe(draft)
    expect(draft.value).toBe('Keep **Markdown** and selection')
    expect(draft.selectionStart).toBe(5); expect(draft.selectionEnd).toBe(15)
})

it('shows an unavailable workspace explanation for Servers instead of adopting workspace one', async () => {
    const servers = vi.fn()
    await act(async () => root.render(<DesktopControlCenter open coworkers={[agent]} board={board} selectedCoworkerId={null} onOpenConversation={() => {}} onAddCoworker={() => {}} onModelSettings={() => {}} onBackToBoard={() => {}} onServers={servers} />))
    await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === 'Servers')!.click() })
    expect(servers).not.toHaveBeenCalled()
})
