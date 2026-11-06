// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { templateAgentSchema } from '@rerun/contracts'
import type { DesktopTemplatesClient } from '@/lib/desktop/templates-client'
import type { DesktopBoardState } from '@/lib/desktop/spaces'
import { cancelDraftShutdown } from '@/lib/desktop/draft-writes'
import { firstDesktopSpacePosition } from '../desktop-space-layout'
import type { DesktopTemplateDetail } from './types'
import { templatePlacementBoard, useDesktopTemplatePlacement } from './useDesktopTemplatePlacement'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const firstBox = '11111111-1111-4111-8111-111111111111'
const qaBox = '22222222-2222-4222-8222-222222222222'
const board: DesktopBoardState = { revision: 1, spaces: [
    { id: firstBox, name: 'Full first Box', col_start: 0, row_start: 0, col_end: 3, row_end: 3 },
    { id: qaBox, name: 'QA Box', col_start: 10, row_start: 0, col_end: 17, row_end: 7 },
], placements: [0, 2].flatMap(col => [0, 2].map(row => ({ agentId: `occupied-${col}-${row}`, spaceId: firstBox, col, row }))) }
const template: DesktopTemplateDetail = {
    templateId: 'a'.repeat(32), revision: 'b'.repeat(64), title: 'QA team', tagline: '', category: 'other', updatedAt: '',
    description: '', capturedAt: '2026-11-05T00:00:00Z', exclusions: [], unsupportedEntries: [],
    agents: ['Ada', 'Ben'].map((name, index) => templateAgentSchema.parse({ key: `c0${index}`, name, description: '', setupRequired: false, skills: [] })),
}
const receipt = { receiptId: 'receipt', coworkers: [{ id: 'copy-ada', name: 'Ada' }, { id: 'copy-ben', name: 'Ben' }] }
let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; cancelDraftShutdown(); vi.restoreAllMocks() })

async function mount(install = vi.fn<DesktopTemplatesClient['install']>().mockResolvedValue(receipt)) {
    const disposed = vi.fn(), onInstalled = vi.fn(async () => {})
    const client = { install, dispose: disposed } as unknown as DesktopTemplatesClient
    const factory = () => client
    let api!: ReturnType<typeof useDesktopTemplatePlacement>
    function Probe() { api = useDesktopTemplatePlacement(onInstalled, factory); return null }
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
    return { api: () => api, install, onInstalled, disposed }
}

it('begin, partial placement and Cancel make no install request or reservation', async () => {
    const h = await mount()
    await act(async () => { expect(h.api().begin(template, false)).toBe(true) })
    expect(firstDesktopSpacePosition(templatePlacementBoard(board, h.api().placement!))?.spaceId).toBe(qaBox)
    await act(async () => { await h.api().place({ col: 11, row: 1 }, board) })
    expect(h.api().placement).toMatchObject({ spaceId: qaBox, positions: [{ col: 11, row: 1 }], submitted: false })
    expect(h.install).not.toHaveBeenCalled()
    await act(async () => { h.api().cancel() })
    expect(h.api().placement).toBeNull()
    expect(h.install).not.toHaveBeenCalled()
    expect(h.onInstalled).not.toHaveBeenCalled()
})

it('keeps each ghost occupied and admits the complete team only on its final drop in the first chosen Box', async () => {
    const h = await mount()
    await act(async () => { h.api().begin(template, false) })
    await act(async () => { await h.api().place({ col: 11, row: 1 }, board) })
    await act(async () => { await h.api().place({ col: 12, row: 2 }, board) })
    expect(h.install).not.toHaveBeenCalled()
    expect(h.api().placement?.positions).toEqual([{ col: 11, row: 1 }])
    const anotherBox = { ...board, placements: [] }
    await act(async () => { await h.api().place({ col: 0, row: 0 }, anotherBox) })
    expect(h.install).not.toHaveBeenCalled()
    await act(async () => { await h.api().place({ col: 14, row: 4 }, board) })
    expect(h.install).toHaveBeenCalledExactlyOnceWith(template, { target: { spaceId: qaBox, positions: [{ col: 11, row: 1 }, { col: 14, row: 4 }] } })
    expect(h.onInstalled).toHaveBeenCalledExactlyOnceWith(receipt)
    expect(h.api().placement).toBeNull()
})

it('lost acknowledgement freezes every destination and retries it even if the next click names another Box', async () => {
    const install = vi.fn<DesktopTemplatesClient['install']>().mockRejectedValueOnce(new Error('Lost acknowledgement')).mockResolvedValue(receipt)
    const h = await mount(install)
    await act(async () => { h.api().begin(template, true) })
    await act(async () => { await h.api().place({ col: 11, row: 1 }, board); await h.api().place({ col: 14, row: 4 }, board) })
    expect(h.api().placement).toMatchObject({ submitted: true, saving: false, error: 'Lost acknowledgement' })
    await act(async () => { h.api().cancel() })
    expect(h.api().placement).not.toBeNull()
    await act(async () => { await h.api().place({ col: 0, row: 0 }, { ...board, revision: 2 }) })
    expect(install).toHaveBeenCalledTimes(2)
    expect(install.mock.calls[1]).toEqual(install.mock.calls[0])
    expect(install.mock.calls[0][1]?.again).toBe(true)
    expect(h.onInstalled).toHaveBeenCalledOnce()
})

it('a stale board before the last drop cannot reserve changed placement and can still be cancelled', async () => {
    const h = await mount()
    await act(async () => { h.api().begin(template, false); await h.api().place({ col: 11, row: 1 }, board) })
    const occupied = { ...board, revision: 2, placements: [...board.placements, { agentId: 'new-neighbor', spaceId: qaBox, col: 11, row: 1 }] }
    await act(async () => { await h.api().place({ col: 14, row: 4 }, occupied) })
    expect(h.install).not.toHaveBeenCalled()
    expect(h.api().placement?.submitted).toBe(false)
    await act(async () => { h.api().cancel() })
    expect(h.api().placement).toBeNull()
})

it('reviewing an uncertain install returns its exact template without another request', async () => {
    const h = await mount(vi.fn<DesktopTemplatesClient['install']>().mockRejectedValue(new Error('Unknown')))
    await act(async () => { h.api().begin(template, false); await h.api().place({ col: 11, row: 1 }, board); await h.api().place({ col: 14, row: 4 }, board) })
    await act(async () => { expect(h.api().review()).toEqual({ templateId: template.templateId, revision: template.revision }) })
    expect(h.api().placement).toBeNull()
    expect(h.install).toHaveBeenCalledOnce()
    expect(h.onInstalled).not.toHaveBeenCalled()
})

it('a delayed completion cannot open a chat after its placement owner unmounts', async () => {
    let finish!: (value: typeof receipt) => void
    const h = await mount(vi.fn<DesktopTemplatesClient['install']>().mockImplementation(() => new Promise(resolve => { finish = resolve })))
    let pending!: Promise<void>
    await act(async () => { h.api().begin(template, false); await h.api().place({ col: 11, row: 1 }, board); pending = h.api().place({ col: 14, row: 4 }, board) })
    await act(async () => root!.unmount()); root = undefined
    await act(async () => { finish(receipt); await pending })
    expect(h.disposed).toHaveBeenCalledOnce()
    expect(h.onInstalled).not.toHaveBeenCalled()
})
