// @vitest-environment happy-dom
import { randomUUID } from 'node:crypto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { applyDesktopSidebarListChange, desktopSidebarListChangeSchema, emptyDesktopSidebarList, type DesktopSidebarList, type DesktopSidebarListChange } from '@/lib/desktop/workspace-view'
import { useDesktopSidebarList } from './useDesktopSidebarList'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

// The workspace's store, as the route keeps it: every change is checked and applied as the database does.
let saved: DesktopSidebarList, puts: DesktopSidebarListChange[], failNext = false
const [sales, support, gone] = [randomUUID(), randomUUID(), randomUUID()]
const [ann, bo, left] = [randomUUID(), randomUUID(), randomUUID()]
let root: Root, host: HTMLDivElement
let api: ReturnType<typeof useDesktopSidebarList>

type Props = Parameters<typeof useDesktopSidebarList>[0]
function Probe(props: Props) { api = useDesktopSidebarList(props); return null }
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
const render = async (props: Props) => { await act(async () => { root.render(<Probe {...props} />) }); await settle() }

beforeEach(() => {
    saved = emptyDesktopSidebarList(); puts = []; failNext = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe('/api/desktop/workspace-view/list')
        if (!init?.method) return Response.json(saved)
        if (failNext) { failNext = false; return Response.json({ error: 'no' }, { status: 500 }) }
        const change = desktopSidebarListChangeSchema.parse(JSON.parse(String(init.body)))
        puts.push(change)
        saved = applyDesktopSidebarListChange(saved, change)
        return Response.json(saved)
    }))
    host = document.body.appendChild(document.createElement('div')); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })

const homes = { [ann]: sales, [bo]: sales }

test('nothing is read until the Simple view shows, then the saved list is restored as it was left', async () => {
    saved = { collapsed: [support], boxes: { [support]: 1, [sales]: 2 }, agents: { [bo]: { box: sales, rank: 1 }, [ann]: { box: sales, rank: 2 } } }
    await render({ enabled: false, boxIds: [sales, support], homes })
    expect(fetch).not.toHaveBeenCalled()
    expect(api.list).toEqual(emptyDesktopSidebarList())
    await render({ enabled: true, boxIds: [sales, support], homes })
    expect(api.loaded).toBe(true)
    expect(api.list).toEqual(saved)
    // Nothing in it is gone: nothing is written.
    expect(puts).toEqual([])
})

test('folding a Box and arranging the list show at once and are saved; a save that fails is undone', async () => {
    await render({ enabled: true, boxIds: [sales, support], homes })
    await act(async () => { api.toggleBox(sales) })
    expect(api.list.collapsed).toEqual([sales])
    await settle()
    await act(async () => { api.orderBoxes([{ id: support, order: 1 }, { id: sales, order: 2 }]); api.orderAgents(sales, [{ id: bo, order: 0.5 }]) })
    await settle()
    expect(puts.map(put => put.kind)).toEqual(['collapsed', 'boxes', 'agents'])
    expect(saved).toEqual({ collapsed: [sales], boxes: { [support]: 1, [sales]: 2 }, agents: { [bo]: { box: sales, rank: 0.5 } } })
    expect(api.list).toEqual(saved)
    // An empty set of writes (a drop that changed nothing) asks nothing of the store.
    await act(async () => { api.orderBoxes([]); api.orderAgents(sales, []) })
    expect(puts).toHaveLength(3)
    failNext = true
    act(() => { api.toggleBox(sales) })
    expect(api.list.collapsed).toEqual([])
    await settle()
    expect(api.list.collapsed).toEqual([sales])
    expect(saved.collapsed).toEqual([sales])
})

test('what the saved list says about a Box or a coworker that is gone is forgotten, once', async () => {
    saved = { collapsed: [gone, sales], boxes: { [gone]: 1, [sales]: 2 }, agents: { [left]: { box: sales, rank: 1 }, [ann]: { box: support, rank: 3 }, [bo]: { box: sales, rank: 2 } } }
    // While the board cannot be read nothing is known to be gone: nothing is touched.
    await render({ enabled: true, boxIds: null, homes })
    expect(puts).toEqual([])
    await render({ enabled: true, boxIds: [sales, support], homes })
    // The deleted Box, the deleted coworker, and Ann's rank in a Box she is no longer in.
    expect(puts).toHaveLength(1)
    expect(puts[0]).toMatchObject({ kind: 'forget', boxes: [gone] })
    expect((puts[0] as { agents: string[] }).agents.sort()).toEqual([left, ann].sort())
    expect(saved).toEqual({ collapsed: [sales], boxes: { [sales]: 2 }, agents: { [bo]: { box: sales, rank: 2 } } })
    await render({ enabled: true, boxIds: [sales, support], homes: { ...homes } })
    expect(puts).toHaveLength(1)
})

test('a coworker dragged to another Box keeps the rank it was given there until the board has moved it', async () => {
    await render({ enabled: true, boxIds: [sales, support], homes })
    await act(async () => { api.arriveIn(ann, support, [{ id: ann, order: 1 }]) })
    await settle()
    // The board still has Ann in Sales: her rank in Support is not taken for a leftover.
    expect(puts.map(put => put.kind)).toEqual(['agents'])
    expect(saved.agents[ann]).toEqual({ box: support, rank: 1 })
    await render({ enabled: true, boxIds: [sales, support], homes: { ...homes, [ann]: support } })
    expect(puts.map(put => put.kind)).toEqual(['agents'])
    // Moved back by the board later, the rank in Support means nothing any more.
    await render({ enabled: true, boxIds: [sales, support], homes })
    expect(puts.map(put => put.kind)).toEqual(['agents', 'forget'])
    expect(saved.agents).toEqual({})
})

test('while the saved list could not be read nothing is written over it', async () => {
    saved = { collapsed: [support], boxes: { [support]: 1 }, agents: {} }
    vi.mocked(fetch).mockImplementationOnce(async () => Response.json({ error: 'no' }, { status: 500 }))
    await render({ enabled: true, boxIds: [sales, support], homes })
    expect(api.loaded).toBe(false)
    await act(async () => { api.toggleBox(sales); api.orderBoxes([{ id: sales, order: 1 }]) })
    await settle()
    expect(puts).toEqual([])
    expect(saved.collapsed).toEqual([support])
})
