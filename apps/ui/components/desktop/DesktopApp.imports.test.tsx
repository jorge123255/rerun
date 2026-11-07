// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopApp } from './DesktopApp'
import type { DesktopBoardState } from '@/lib/desktop/spaces'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'
import { createDesktopRecentFixture } from '@/test/desktop-recent-fixture'
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
import * as draftWrites from '@/lib/desktop/draft-writes'

const ownerId = '33333333-3333-4333-8333-333333333333'
const importedId = '44444444-4444-4444-8444-444444444444'
const boxId = '11111111-1111-4111-8111-111111111111'
const original = { id: ownerId,name: 'Original',description: 'Existing work',enabled: true,createdAt: '2026-01-01',updatedAt: '2026-01-01' }
const imported = { id: importedId,name: 'Offline copy',description: 'Imported notes',enabled: false,createdAt: '2026-01-02',updatedAt: '2026-01-02' }

vi.mock('@rerun/ui/foreman', () => ({ PARKED_ORB_SIZE: 40,PARKED_ORB_SIZE_MOBILE: 40,Orb: () => null }))
// The native picker/import flow has separate tests. This boundary emits its accepted
// outcome and closes exactly as Done does; the App and its canonical refresh stay real.
vi.mock('./DesktopWorkspaceDialogs', async importOriginal => {
    const actual = await importOriginal<typeof import('./DesktopWorkspaceDialogs')>()
    return { ...actual,DesktopPortableCoworkerImport: ({ workspaceId,onImported,onClose }: ComponentProps<typeof actual.DesktopPortableCoworkerImport>) => <div role="dialog" aria-label="Fixture offline import" data-import-workspace={workspaceId}>
        <button type="button" onClick={() => { void onImported?.(importedId) }}>Acknowledge import</button>
        <button type="button" onClick={() => { void onImported?.(importedId) }}>Acknowledge recovered import</button>
        <button type="button" onClick={onClose}>Done importing</button>
        <button type="button" onClick={onClose}>Cancel importing</button>
    </div> }
})
vi.mock('./DesktopChatTabs', () => ({ DesktopChatTabs: ({ agent }: ComponentProps<typeof import('./DesktopChatTabs').DesktopChatTabs>) => <div data-import-test-chat={agent.id}>
    <textarea aria-label="Existing chat draft" defaultValue="Keep this unsent draft" />
</div> }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

const initialBoard = (): DesktopBoardState => ({ revision: 1,spaces: [{ id: boxId,name: 'Team',col_start: 0,row_start: 0,col_end: 10,row_end: 7 }],placements: [{ agentId: ownerId,spaceId: boxId,col: 0,row: 0 }] })
const importedBoard = (): DesktopBoardState => ({ ...initialBoard(),revision: 2,placements: [...initialBoard().placements,{ agentId: importedId,spaceId: boxId,col: 3,row: 0 }] })
const button = (label: string) => {
    const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === label)
    if (!result) throw new Error(`Missing button: ${label}`)
    return result
}
const click = async (node: HTMLElement) => { await act(async () => node.click()) }
const cameraTransform = () => {
    const layer = [...document.querySelectorAll<HTMLElement>('[aria-label="Team board"] [style]')].find(element => element.style.transform.startsWith('scale('))
    if (!layer) throw new Error('The real board camera layer is missing')
    return layer.style.transform
}

async function mount() {
    let releaseAgents!: (response: Response) => void
    const deferredAgents = new Promise<Response>(resolve => { releaseAgents = resolve })
    const requests: { url: string; method: string }[] = []
    const unexpected: string[] = []
    const drafts = createDesktopDraftFixture(), recent = createDesktopRecentFixture()
    const flush = vi.spyOn(draftWrites,'flushDesktopDrafts')
    vi.stubGlobal('fetch',vi.fn(async (input: RequestInfo | URL,init?: RequestInit) => {
        const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
        const method = init?.method ?? 'GET'
        requests.push({ url,method })
        const shared = recent.handle(input,init) ?? drafts.handle(input,init)
        if (shared) return shared
        if (method !== 'GET') { unexpected.push(`${method} ${url}`); throw new Error('Import acknowledgement cannot send, enable, edit or move anything') }
        if (url === '/api/desktop/agents') return deferredAgents
        if (url === '/api/desktop/spaces') return Response.json({ board: importedBoard() })
        if (url === '/api/desktop/settings') return Response.json({ connections: [],default: null,runtimeWorkspaceId: 2 })
        if (url === '/api/desktop/workspaces/2/board-camera') return Response.json({ workspaceId: 2, revision: 0, camera: { pan: { x: 0, y: 0 }, zoom: 1 } })
        if (url === '/api/desktop/board-activity') return Response.json({ agents: {} })
        if (url === '/api/desktop/pending-inbox') return Response.json({ items: [],unavailableAgentIds: [],checkedAt: '2026-11-06T00:00:00Z' })
        if (url === '/api/desktop/completions') return Response.json({ items: [],unavailableAgentIds: [],enabledAt: '2026-11-06T00:00:00Z',checkedAt: '2026-11-06T00:00:00Z',nextCursor: null })
        if (/^\/api\/desktop\/agents\/[^/]+\/sessions$/.test(url)) return Response.json({ sessions: [] })
        const background = desktopBackgroundRead(input,init)
        if (background) return background
        unexpected.push(`${method} ${url}`)
        throw new Error(`Unexpected read: ${url}`)
    }))
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<MotionConfig reducedMotion="always"><DesktopApp initialData={{ profile: { id: 1,displayName: 'Local' },workspace: { id: 1,name: 'Second workspace' },runtimeWorkspaceId: 2,theme: 'system',connections: [],default: null,agents: [original],board: initialBoard() }} /></MotionConfig>))
    return { requests,unexpected,flush,releaseAgents: async () => { await act(async () => releaseAgents(Response.json({ agents: [original,imported] }))) } }
}

async function openOriginalChat() {
    const tile = document.querySelector<HTMLElement>('[aria-label="Open chat with Original"]')!
    await act(async () => { tile.focus(); tile.dispatchEvent(new KeyboardEvent('keydown',{ key: 'Enter',bubbles: true,cancelable: true })) })
    const draft = document.querySelector<HTMLTextAreaElement>('[aria-label="Existing chat draft"]')!
    expect(draft).not.toBeNull()
    draft.value = 'The exact existing unsent draft'
    return draft
}
async function openImport() {
    const trigger = document.querySelector<HTMLElement>('[aria-label="Workspace menu, Second workspace"]')!
    await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown',{ key: 'ArrowDown',bubbles: true,cancelable: true })) })
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(value => value.textContent?.trim() === 'Import coworker')!
    expect(item).not.toBeNull()
    await click(item)
    expect(document.querySelector('[data-import-workspace]')?.getAttribute('data-import-workspace')).toBe('2')
}

it.each(['Acknowledge import','Acknowledge recovered import'])('%s refreshes workspace two after Done without selecting a chat, moving the camera, or flushing its draft', async acknowledgement => {
    const fixture = await mount()
    const draft = await openOriginalChat(), camera = cameraTransform()
    const originalSessionReads = fixture.requests.filter(request => request.url.endsWith('/sessions')).length
    await openImport()
    await click(button(acknowledgement))
    expect(fixture.requests.filter(request => request.url === '/api/desktop/agents')).toHaveLength(1)
    expect(fixture.requests.filter(request => request.url === '/api/desktop/spaces')).toHaveLength(0)
    await click(button('Done importing'))
    expect(document.querySelector('[aria-label="Fixture offline import"]')).toBeNull()
    expect(document.querySelector(`[data-tile-id="${importedId}"]`)).toBeNull()
    await fixture.releaseAgents()
    expect(fixture.requests.filter(request => request.url === '/api/desktop/spaces')).toHaveLength(1)
    expect(document.querySelector(`[data-tile-id="${importedId}"]`)).not.toBeNull()
    expect(document.querySelector('[data-board-activity="Offline copy"]')?.getAttribute('data-status')).toBe('inactive')
    expect(document.querySelector('[data-import-test-chat]')?.getAttribute('data-import-test-chat')).toBe(ownerId)
    expect(document.querySelector('[aria-label="Existing chat draft"]')).toBe(draft)
    expect(draft.value).toBe('The exact existing unsent draft')
    expect(cameraTransform()).toBe(camera)
    expect(fixture.requests.filter(request => request.url.endsWith('/sessions'))).toHaveLength(originalSessionReads)
    expect(fixture.flush).not.toHaveBeenCalled()
    expect(fixture.requests.filter(request => request.method !== 'GET' && request.url.includes('/draft'))).toEqual([])
    expect(fixture.unexpected).toEqual([])
})

it('Cancel performs no canonical import refresh and preserves the selected chat and draft', async () => {
    const fixture = await mount(), draft = await openOriginalChat(), camera = cameraTransform()
    await openImport(); await click(button('Cancel importing'))
    expect(fixture.requests.filter(request => request.url === '/api/desktop/agents' || request.url === '/api/desktop/spaces')).toEqual([])
    expect(document.querySelector('[data-import-test-chat]')?.getAttribute('data-import-test-chat')).toBe(ownerId)
    expect(document.querySelector('[aria-label="Existing chat draft"]')).toBe(draft)
    expect(draft.value).toBe('The exact existing unsent draft')
    expect(cameraTransform()).toBe(camera)
    expect(fixture.flush).not.toHaveBeenCalled(); expect(fixture.unexpected).toEqual([])
})

it('ignores a canonical import refresh that returns after the workspace App unmounts', async () => {
    const fixture = await mount()
    await openImport(); await click(button('Acknowledge import'))
    expect(fixture.requests.filter(request => request.url === '/api/desktop/agents')).toHaveLength(1)
    await act(async () => root!.unmount()); root = undefined
    await fixture.releaseAgents()
    expect(fixture.requests.filter(request => request.url === '/api/desktop/spaces')).toEqual([])
    expect(document.querySelector(`[data-tile-id="${importedId}"]`)).toBeNull()
    expect(fixture.flush).not.toHaveBeenCalled(); expect(fixture.unexpected).toEqual([])
})
