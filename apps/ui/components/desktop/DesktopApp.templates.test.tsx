// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MotionConfig } from 'motion/react'
import { DesktopApp } from './DesktopApp'
import { DesktopSetupGate } from './setup/DesktopSetupGate'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'
import { createDesktopRecentFixture } from '@/test/desktop-recent-fixture'
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
import type { DesktopBoardState } from '@/lib/desktop/spaces'

const owner = '33333333-3333-4333-8333-333333333333'
const first = '44444444-4444-4444-8444-444444444444'
const second = '55555555-5555-4555-8555-555555555555'
vi.mock('@rerun/ui/foreman', () => ({ Orb: () => null }))
vi.mock('./templates/DesktopTemplateNavigation', () => ({
    DesktopTemplateNavigation: ({ open, onOpenChange, onInstalled }: ComponentProps<typeof import('./templates/DesktopTemplateNavigation').DesktopTemplateNavigation>) =>
        <div data-library-open={String(open)}><button onClick={() => onOpenChange(true)}>Open test library</button>{open && <button onClick={() => onInstalled({ receiptId: 'receipt', coworkers: [{ id: first, name: 'First installed' }, { id: second, name: 'Second installed' }] })}>Acknowledge installation</button>}</div>,
}))
vi.mock('./DesktopChatTabs', () => ({
    DesktopChatTabs: ({ agent }: ComponentProps<typeof import('./DesktopChatTabs').DesktopChatTabs>) => <div data-selected-import={agent.id}>
        <DesktopSetupGate agentId={agent.id} agentName={agent.name} apps={[]} onOpenSetupChat={() => { throw new Error('Opening a template must not start setup') }} />
    </div>,
}))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
})

it('closes the library and opens the first acknowledged coworker’s pending gate without a Start request', async () => {
    const box = '11111111-1111-4111-8111-111111111111'
    const original = { id: owner, name: 'Original', description: '', createdAt: '2026-01-01', updatedAt: '2026-01-01' }
    const installed = [
        { id: first, name: 'First installed', description: '', createdAt: '2026-01-02', updatedAt: '2026-01-02' },
        { id: second, name: 'Second installed', description: '', createdAt: '2026-01-02', updatedAt: '2026-01-02' },
    ]
    const board: DesktopBoardState = { revision: 2, spaces: [{ id: box, name: 'Team', col_start: 0, row_start: 0, col_end: 11, row_end: 7 }],
        placements: [{ agentId: owner, spaceId: box, col: 0, row: 0 }, { agentId: first, spaceId: box, col: 3, row: 0 }, { agentId: second, spaceId: box, col: 6, row: 0 }] }
    const writes: string[] = [], setupReads: string[] = []
    const drafts = createDesktopDraftFixture(), recent = createDesktopRecentFixture()
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const shared = recent.handle(url, init) ?? drafts.handle(url, init)
        if (shared) return shared
        if (init?.method && init.method !== 'GET') { writes.push(`${init.method} ${url}`); throw new Error('No setup/chat mutation is authorized by opening an installed coworker') }
        if (url === '/api/desktop/new-agent') return Response.json({ pending: null })
        if (url === '/api/desktop/agents') return Response.json({ agents: [original, installed[1], installed[0]] })
        if (url === '/api/desktop/spaces') return Response.json({ board })
        if (url === '/api/desktop/settings') return Response.json({ connections: [], default: null })
        if (url === '/api/desktop/board-activity') return Response.json({ agents: {} })
        if (url === '/api/desktop/pending-inbox') return Response.json({ items: [], unavailableAgentIds: [], checkedAt: '2026-11-05T00:00:00Z' })
        if (url === '/api/desktop/completions') return Response.json({ items: [], unavailableAgentIds: [], enabledAt: '2026-11-05T00:00:00Z', checkedAt: '2026-11-05T00:00:00Z', nextCursor: null })
        if (url === `/api/desktop/coworkers/${first}/setup`) {
            setupReads.push(url)
            return Response.json({ agentId: first, revision: 'pending-import', required: true, prompt: 'Set up the copied coworker.', completedAt: null, sessionId: null, pending: true, skipped: false, defaultPrompt: 'Safe setup' })
        }
        if (url.includes('/sessions')) return Response.json({ sessions: [] })
        const background = desktopBackgroundRead(url, init)
        if (background) return background
        throw new Error(`Unexpected read: ${url}`)
    }))
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<MotionConfig reducedMotion="always"><DesktopApp initialData={{ profile: { id: 1, displayName: 'Local' }, workspace: { id: 1, name: 'Workspace' }, theme: 'system', connections: [], default: null, agents: [original], board }} /></MotionConfig>))
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Open test library')!.click() })
    await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Acknowledge installation')!.click() })
    await act(async () => {})
    expect(document.querySelector('[data-library-open]')?.getAttribute('data-library-open')).toBe('false')
    expect(document.querySelector('[data-selected-import]')?.getAttribute('data-selected-import')).toBe(first)
    expect(document.body.textContent).toContain('Install First installed')
    expect(setupReads.length).toBeGreaterThan(0)
    expect(writes).toEqual([])
})
