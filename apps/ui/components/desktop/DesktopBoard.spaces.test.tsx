// @vitest-environment happy-dom

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { IsoGridProps } from '@rerun/ui/iso-grid'
import { templateAgentSchema } from '@rerun/contracts'
import type { DesktopTemplatePlacement } from './templates/useDesktopTemplatePlacement'
import { emptyBoardAttention } from '@/lib/desktop/board-activity'
import { cancelDraftShutdown, flushDesktopDrafts } from '@/lib/desktop/draft-writes'
import type { DesktopBoardState, DesktopSpaceCommand } from '@/lib/desktop/spaces'
import { freeRectOnSide } from '@/lib/board/space-layout'
import { DesktopBoard } from './DesktopBoard'
import { useBoardCoverStore } from '@/stores/board-cover.store'
import { desktopSpaceLabel, desktopSpaceRectAllowed, firstDesktopSpacePosition } from './desktop-space-layout'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Exercise the adapter's gesture boundaries independently of pointer geometry. Root's real-App
// integration and native checks own the actual IsoGrid gestures and original NewBoxForm rendering.
const rendered = vi.hoisted(() => ({ grid: undefined as IsoGridProps | undefined }))
vi.mock('@rerun/ui/iso-grid', async importOriginal => {
    const actual = await importOriginal<typeof import('@rerun/ui/iso-grid')>()
    return { ...actual, IsoGrid(props: IsoGridProps) {
        rendered.grid = props
        return <div aria-label="Test grid">
            {props.containers.map(container => <button key={container.id} aria-label={container.ariaLabel ?? container.placeholderLabel} onClick={() => props.onContainerSelect?.(container.id)}>{container.label}</button>)}
            {props.tiles.map(tile => <button key={tile.id} data-tile-id={tile.id} aria-label={tile.ariaLabel} onClick={() => props.onTileSelect?.(tile.id)}>{tile.id}</button>)}
        </div>
    } }
})
vi.mock('@/components/dialogs/new-box/NewBoxForm', async () => {
    const React = await import('react')
    return { NewBoxForm({ onCreate, controls }: { onCreate: (name: string) => Promise<void>; controls?: ReactNode }) {
        const [name, setName] = React.useState(''), [error, setError] = React.useState('')
        return <form onSubmit={event => { event.preventDefault(); void onCreate(name).catch(error => setError(error.message)) }}>
            <input aria-label="Box name" value={name} onChange={event => setName(event.target.value)} />
            <button type="submit">Create {name || 'Box'}</button>{controls}{error && <p role="alert">{error}</p>}
        </form>
    } }
})

const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222'
const owner = '33333333-3333-4333-8333-333333333333'
const agent = { id: owner, name: 'Researcher', description: '', createdAt: '', updatedAt: '', position: { col: 999, row: 999 } }
const initial = (): DesktopBoardState => ({ revision: 1, spaces: [
    { id: a, name: 'Research', col_start: 0, row_start: 0, col_end: 7, row_end: 7 },
    { id: b, name: 'Studio', col_start: 12, row_start: 0, col_end: 19, row_end: 7 },
], placements: [{ agentId: owner, spaceId: a, col: 1, row: 2 }] })
const roots: Root[] = []
const deferred = () => { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]')
const button = (label: string, parent: ParentNode = document) => [...parent.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === label)!
const click = async (target: HTMLElement) => { await act(async () => { target.click() }) }
const enter = async (input: HTMLInputElement, value: string) => { await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
}) }
async function openMenu(label: string, action: string) {
    const target = [...document.querySelectorAll<HTMLElement>('[aria-label]')].find(element => element.getAttribute('aria-label') === label)!
    await act(async () => { target.focus(); target.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })) })
    const entry = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === action)!
    expect(entry).toBeTruthy()
    await click(entry)
}
async function mount(patch: Partial<ComponentProps<typeof DesktopBoard>> = {}) {
    const onBoardCommand = vi.fn(async (_command: DesktopSpaceCommand) => {})
    let props: ComponentProps<typeof DesktopBoard> = { board: initial(), agents: [agent], workspaceName: 'Workspace', onOpen: vi.fn(), onCreate: vi.fn(),
        activitySnapshot: { statuses: { [owner]: 'idle' }, attention: emptyBoardAttention() }, onBoardCommand, ...patch }
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container); roots.push(root)
    const render = async (next: Partial<typeof props> = {}) => { props = { ...props, ...next }; await act(async () => { root.render(<DesktopBoard {...props} />) }) }
    await render()
    return { onBoardCommand, render, container }
}
afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount(); cancelDraftShutdown() })
    rendered.grid = undefined; document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals()
})

test('template placement uses original board ghosts, fixes the first Box and discards stale drop callbacks', async () => {
    const templatePlacement: DesktopTemplatePlacement = {
        id: 'template-placement', again: false, positions: [], submitted: false, saving: false,
        template: { templateId: 'a'.repeat(32), revision: 'b'.repeat(64), title: 'Team', tagline: '', category: 'other', updatedAt: '', capturedAt: '2026-11-05T00:00:00Z', description: '', exclusions: [], unsupportedEntries: [],
            agents: ['Ada', 'Ben'].map((name, index) => templateAgentSchema.parse({ key: `c0${index}`, name, description: '', skills: [], setupRequired: false })) },
    }
    const onPlaceTemplate = vi.fn<NonNullable<ComponentProps<typeof DesktopBoard>['onPlaceTemplate']>>().mockResolvedValue(undefined)
    const onCancelTemplate = vi.fn(), onReviewTemplate = vi.fn()
    const h = await mount({ templatePlacement, onPlaceTemplate, onCancelTemplate, onReviewTemplate })
    expect(rendered.grid!.placing).toBe(true)
    expect(rendered.grid!.placementContainerId).toBeNull()
    expect(document.body.textContent).toContain('1 of 2 coworkers')
    const firstDrop = rendered.grid!.onConfirmPlacement!
    await act(async () => { await firstDrop({ col: 13, row: 1 }) })
    expect(onPlaceTemplate).toHaveBeenCalledWith({ col: 13, row: 1 }, initial())
    await h.render({ templatePlacement: { ...templatePlacement, spaceId: b, positions: [{ col: 13, row: 1 }] } })
    expect(rendered.grid!.placementContainerId).toBe(b)
    expect(rendered.grid!.tiles).toContainEqual(expect.objectContaining({ position: { col: 13, row: 1 }, containerId: b, ariaLabel: 'Placed Ada in this template' }))
    expect(document.body.textContent).toContain('2 of 2 coworkers')
    await act(async () => { await firstDrop({ col: 15, row: 4 }) })
    expect(onPlaceTemplate).toHaveBeenCalledOnce()
    await click(button('Cancel'))
    expect(onCancelTemplate).toHaveBeenCalledOnce()
    await h.render({ templatePlacement: { ...templatePlacement, spaceId: b, positions: [{ col: 13, row: 1 }, { col: 15, row: 4 }], submitted: true, error: 'Unknown acknowledgement' } })
    expect(rendered.grid!.placing).toBe(false)
    expect(button('Cancel')).toBeUndefined()
    await click(button('Review installation'))
    expect(onReviewTemplate).toHaveBeenCalledOnce()
})

test('saved Boxes and membership replace legacy positions and empty Box selection recruits into that Box', async () => {
    const onCreate = vi.fn(), onOpen = vi.fn()
    await mount({ onCreate, onOpen })
    expect(rendered.grid!.containers.map(box => [box.id, box.label])).toEqual([[a, 'Research'], [b, 'Studio']])
    expect(rendered.grid!.tiles[0]).toMatchObject({ id: owner, containerId: a, position: { col: 1, row: 2 } })
    await act(async () => { rendered.grid!.onContainerSelect?.(b) })
    expect(onCreate).toHaveBeenCalledWith(b)
    expect(rendered.grid!.selectedContainerId).toBe(b)
    await act(async () => { rendered.grid!.onTileSelect?.(owner) })
    expect(onOpen).toHaveBeenCalledWith(owner)
})

test('side Add uses the original free-rectangle preview and carries its exact source and side into creation', async () => {
    const h = await mount()
    expect(rendered.grid!.containerAddLabel).toBe('Add a Box on this side')
    expect(rendered.grid!.containerAddPreview?.(a, 'top-left')).toEqual(freeRectOnSide(initial().spaces[0], 'top-left', initial().spaces))
    await act(async () => { rendered.grid!.onContainerAdd?.(a, 'top-left') })
    expect(dialog()?.textContent).toContain('New Box')
    await enter(dialog()!.querySelector('input')!, 'Marketing')
    await click(button('Create Marketing', dialog()!))
    expect(h.onBoardCommand).toHaveBeenCalledWith({ kind: 'create', name: 'Marketing', sourceId: a, side: 'top-left' })
    expect(dialog()).toBeNull()
})

test('zero Boxes offers creation and Cancel never writes', async () => {
    const interaction = vi.fn(), h = await mount({ board: { revision: 3, spaces: [], placements: [] }, agents: [], onBoardInteractionChange: interaction })
    expect(rendered.grid!.containers[0].placeholderLabel).toBe('Create your first Box')
    await act(async () => { rendered.grid!.onContainerSelect?.('desktop-empty-box') })
    expect(interaction).toHaveBeenLastCalledWith(true)
    await click(button('Cancel', dialog()!))
    expect(dialog()).toBeNull(); expect(h.onBoardCommand).not.toHaveBeenCalled()
    expect(interaction).toHaveBeenLastCalledWith(false)
    await click(button('Add Box'))
    expect(dialog()?.textContent).toContain('New Box')
})

test('rename keeps its original dialog and typed draft after failure, then waits for the successful retry', async () => {
    const pending = deferred()
    const save = vi.fn<(_command: DesktopSpaceCommand) => Promise<void>>().mockRejectedValueOnce(new Error('Cannot save right now')).mockImplementationOnce(() => pending.promise)
    await mount({ onBoardCommand: save })
    await openMenu(desktopSpaceLabel(initial().spaces[0], 0, 2), 'Rename')
    expect(dialog()?.textContent).toContain('The name you read on the board. Nothing else depends on it.')
    await enter(dialog()!.querySelector('input')!, 'Renamed Research')
    await click(button('Rename', dialog()!))
    expect(dialog()?.textContent).toContain('Cannot save right now')
    expect(rendered.grid!.containers[0].label).toBe('Research')
    await click(button('Rename', dialog()!))
    expect(button('Cancel', dialog()!).disabled).toBe(true)
    expect(dialog()).not.toBeNull()
    await act(async () => { pending.resolve() })
    expect(dialog()).toBeNull()
    expect(save.mock.calls.map(([command]) => command)).toEqual([
        { kind: 'rename', spaceId: a, name: 'Renamed Research' }, { kind: 'rename', spaceId: a, name: 'Renamed Research' },
    ])
})

test('delete blocks occupied Boxes and rechecks live membership before accepting a typed empty-Box deletion', async () => {
    const h = await mount()
    await openMenu(desktopSpaceLabel(initial().spaces[0], 0, 2), 'Delete')
    expect(dialog()?.textContent).toContain('This Box still holds 1 coworker. Move it to another Box or delete it first.')
    expect(button('Delete', dialog()!).disabled).toBe(true)
    await click(button('Cancel', dialog()!))
    await openMenu(desktopSpaceLabel(initial().spaces[1], 1, 2), 'Delete')
    await enter(dialog()!.querySelector('input')!, 'Wrong name')
    expect(button('Delete', dialog()!).disabled).toBe(true)
    await enter(dialog()!.querySelector('input')!, 'Studio')
    expect(button('Delete', dialog()!).disabled).toBe(false)
    await h.render({ board: { ...initial(), revision: 2, placements: [{ agentId: owner, spaceId: b, col: 13, row: 1 }] } })
    expect(button('Delete', dialog()!).disabled).toBe(true)
    expect(h.onBoardCommand).not.toHaveBeenCalled()
})

test('an empty Box deletion stays open through the write and never changes its sibling locally', async () => {
    const pending = deferred(), save = vi.fn(() => pending.promise)
    await mount({ onBoardCommand: save })
    await openMenu(desktopSpaceLabel(initial().spaces[1], 1, 2), 'Delete')
    await enter(dialog()!.querySelector('input')!, 'Studio')
    await click(button('Delete', dialog()!))
    expect(save).toHaveBeenCalledWith({ kind: 'delete', spaceId: b, confirmationName: 'Studio' })
    expect(dialog()).not.toBeNull(); expect(button('Cancel', dialog()!).disabled).toBe(true)
    expect(rendered.grid!.containers).toHaveLength(2)
    await act(async () => { pending.reject(new Error('Reservation pending')) })
    expect(dialog()?.textContent).toContain('Reservation pending')
    expect(dialog()!.querySelector<HTMLInputElement>('input')!.value).toBe('Studio')
    expect(rendered.grid!.tiles[0].containerId).toBe(a)
})

test('dragging an agent sends its target Box and valid position without changing the persisted tile before acknowledgment', async () => {
    const pending = deferred(), save = vi.fn(() => pending.promise)
    const h = await mount({ onBoardCommand: save })
    await act(async () => { rendered.grid!.onTileMove?.(owner, { col: 100, row: 100 }, b) })
    expect(save).not.toHaveBeenCalled()
    await act(async () => { rendered.grid!.onTileMove?.(owner, { col: 13, row: 2 }, b) })
    expect(save).toHaveBeenCalledWith({ kind: 'move-agent', agentId: owner, spaceId: b, position: { col: 13, row: 2 } })
    expect(rendered.grid!.tiles[0].position).toEqual({ col: 1, row: 2 })
    await h.render({ board: { ...initial(), revision: 2, placements: [{ agentId: owner, spaceId: b, col: 13, row: 2 }] } })
    await act(async () => { pending.resolve() })
    expect(rendered.grid!.tiles[0]).toMatchObject({ containerId: b, position: { col: 13, row: 2 } })
})

test('whole-Box movement previews its members together, and a failed save restores the authoritative coordinates', async () => {
    const pending = deferred(), save = vi.fn(() => pending.promise)
    await mount({ onBoardCommand: save })
    const rect = { col_start: -10, row_start: -10, col_end: -3, row_end: -3 }
    await act(async () => { rendered.grid!.onContainerMove?.(a, rect) })
    expect(save).toHaveBeenCalledWith({ kind: 'move-space', spaceId: a, rect })
    expect(rendered.grid!.containers[0]).toMatchObject(rect)
    expect(rendered.grid!.tiles[0].position).toEqual({ col: -9, row: -8 })
    await act(async () => { pending.reject(new Error('Move rejected')) })
    expect(rendered.grid!.containers[0]).toMatchObject(initial().spaces[0])
    expect(rendered.grid!.tiles[0].position).toEqual({ col: 1, row: 2 })
    expect(document.body.textContent).toContain('Move rejected')
})

test('resize previews locally, preserves member positions and rejects overlap, removed membership or canceled pointers', async () => {
    const h = await mount()
    await act(async () => { rendered.grid!.onResizeContainerLocal?.(a, { col_end: 11 }) })
    expect(rendered.grid!.containers[0].col_end).toBe(11)
    await act(async () => { rendered.grid!.onResizeContainerCommit?.(a) })
    expect(h.onBoardCommand).not.toHaveBeenCalled()
    expect(rendered.grid!.containers[0].col_end).toBe(7)
    await act(async () => { rendered.grid!.onResizeContainerLocal?.(a, { row_end: 9 }) })
    expect(rendered.grid!.tiles[0].position).toEqual({ col: 1, row: 2 })
    await act(async () => { h.container.querySelector('section')!.dispatchEvent(new Event('pointercancel', { bubbles: true })) })
    await act(async () => { rendered.grid!.onResizeContainerCommit?.(a) })
    expect(h.onBoardCommand).not.toHaveBeenCalled()
    expect(rendered.grid!.containers[0].row_end).toBe(7)
})

test('a late failed resize cannot overwrite a newer board snapshot, and old gesture callbacks cannot write', async () => {
    const pending = deferred(), save = vi.fn(() => pending.promise)
    const h = await mount({ onBoardCommand: save })
    const staleMove = rendered.grid!.onContainerMove!
    await act(async () => { rendered.grid!.onResizeContainerLocal?.(a, { row_end: 9 }); rendered.grid!.onResizeContainerCommit?.(a) })
    const newer = initial(); newer.revision = 2; newer.spaces[0].row_end = 10
    await h.render({ board: newer })
    await act(async () => { pending.reject(new Error('Old request failed')) })
    expect(rendered.grid!.containers[0].row_end).toBe(10)
    await act(async () => { staleMove(a, { col_start: -10, row_start: -10, col_end: -3, row_end: -3 }) })
    expect(save).toHaveBeenCalledTimes(1)
})

test('modal, disabled-board and Quit states reject retained gestures without disturbing the board', async () => {
    const h = await mount(), stale = rendered.grid!.onTileMove!
    await click(button('Add Box'))
    await act(async () => { stale(owner, { col: 13, row: 2 }, b) })
    await click(button('Cancel', dialog()!))
    await act(async () => { stale(owner, { col: 13, row: 2 }, b) })
    const beforeDisabled = rendered.grid!.onTileMove!
    await h.render({ boardDisabled: true }); await h.render({ boardDisabled: false })
    await act(async () => { beforeDisabled(owner, { col: 13, row: 2 }, b); await flushDesktopDrafts() })
    expect(rendered.grid!.onTileMove).toBeUndefined()
    expect(h.onBoardCommand).not.toHaveBeenCalled()
})

test('a retained new-coworker placement gesture cannot submit a replacement intent or a newer board', async () => {
    const first = { intent: { requestId: '44444444-4444-4444-8444-444444444444', name: 'First job', kickoff: 'Do the first job.', suggestionId: null, scheduled: false }, spaceId: a, submitted: false, saving: false }
    const place = vi.fn(async () => {})
    const h = await mount({ newCoworker: first, onPlaceCoworker: place })
    const oldIntent = rendered.grid!.onConfirmPlacement!
    const second = { ...first, intent: { ...first.intent, requestId: '55555555-5555-4555-8555-555555555555' }, spaceId: b }
    await h.render({ newCoworker: second })
    await act(async () => { await oldIntent({ col: 4, row: 4 }) })
    expect(place).not.toHaveBeenCalled()
    const oldBoard = rendered.grid!.onConfirmPlacement!
    await h.render({ board: { ...initial(), revision: 2 } })
    await act(async () => { await oldBoard({ col: 14, row: 2 }) })
    expect(place).not.toHaveBeenCalled()
    expect(rendered.grid!.placementContainerId).toBe(b)
    await act(async () => { await rendered.grid!.onConfirmPlacement!({ col: 14, row: 2 }) })
    expect(place).toHaveBeenCalledExactlyOnceWith({ col: 14, row: 2 }, b)
})

test('modal and disabled-board transitions invalidate retained creation placement gestures even after reopening', async () => {
    const pending = { intent: { requestId: '44444444-4444-4444-8444-444444444444', name: 'First job', kickoff: 'Do the first job.', suggestionId: null, scheduled: false }, spaceId: b, submitted: false, saving: false }
    const place = vi.fn(async () => {}), h = await mount({ newCoworker: pending, onPlaceCoworker: place })
    const beforeCover = rendered.grid!.onConfirmPlacement!
    let release!: () => void
    await act(async () => { release = useBoardCoverStore.getState().cover() })
    try { await act(async () => { await beforeCover({ col: 14, row: 2 }) }) }
    finally { await act(async () => { release() }) }
    await act(async () => { await beforeCover({ col: 14, row: 2 }) })
    const beforeDisable = rendered.grid!.onConfirmPlacement!
    await h.render({ boardDisabled: true }); await h.render({ boardDisabled: false })
    await act(async () => { await beforeDisable({ col: 14, row: 2 }) })
    expect(place).not.toHaveBeenCalled()
    await act(async () => { await rendered.grid!.onConfirmPlacement!({ col: 14, row: 2 }) })
    expect(place).toHaveBeenCalledExactlyOnceWith({ col: 14, row: 2 }, b)
})

test('Duplicate can choose another Box and retries the identical destination after an uncertain response', async () => {
    const duplicate = vi.fn<NonNullable<ComponentProps<typeof DesktopBoard>['onDuplicate']>>().mockRejectedValueOnce(new Error('No reply yet')).mockResolvedValueOnce('created')
    await mount({ onDuplicate: duplicate })
    await openMenu('Open chat with Researcher', 'Duplicate')
    await act(async () => { rendered.grid!.onConfirmPlacement?.({ col: 14, row: 3 }) })
    expect(duplicate).toHaveBeenCalledTimes(1)
    expect(duplicate.mock.calls[0]).toEqual([owner, expect.any(String), { col: 14, row: 3 }, b])
    await click(button('Retry'))
    expect(duplicate.mock.calls[1]).toEqual(duplicate.mock.calls[0])
    expect(rendered.grid!.placing).toBe(false)
})

test('placement and resize helpers respect full footprints, gaps and large free Boxes', () => {
    const board = initial()
    expect(firstDesktopSpacePosition(board, b)).toEqual({ spaceId: b, position: { col: 12, row: 0 } })
    expect(desktopSpaceRectAllowed(board, a, { col_start: 0, row_start: 0, col_end: 11, row_end: 7 }, false)).toBe(false)
    expect(desktopSpaceRectAllowed(board, a, { col_start: 3, row_start: 0, col_end: 7, row_end: 7 }, false)).toBe(false)
    board.spaces[1].col_end = 1_000_000; board.spaces[1].row_end = 1_000_000
    expect(firstDesktopSpacePosition(board, b)).toEqual({ spaceId: b, position: { col: 12, row: 0 } })
})
