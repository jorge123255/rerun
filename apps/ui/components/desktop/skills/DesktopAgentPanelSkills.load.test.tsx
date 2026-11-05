// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({ proposals: new Map(), refresh: vi.fn(), decide: vi.fn() }))
vi.mock('@/lib/desktop/use-coworker-skill-proposals', () => ({ useCoworkerSkillProposals: () => ({ proposals: state.proposals, pinned: [], pendingId: null, unavailable: false, refresh: state.refresh, decide: state.decide }) }))
vi.mock('@/components/ui/panel-steps', () => ({ PanelSteps: ({ children }: { children: ReactNode }) => <>{children}</> }))
import { DesktopAgentPanelSkills } from './DesktopAgentPanelSkills'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const skill = { slug: 'notes', name: 'Saved notes', description: 'Review the saved notes', body: 'Read the notes first.', files: [], fromConnector: false, identity: 'saved-version' }
let root: ReturnType<typeof createRoot>, container: HTMLDivElement, fail: boolean
beforeEach(() => {
    state.proposals = new Map(); fail = true
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/skills')
        ? fail ? Response.json({ error: 'A previous Skills change needs recovery.' }, { status: 409 }) : Response.json({ skills: [skill] })
        : Response.json({ skill })))
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
const retry = () => [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Retry loading skills')!

test('a failed initial shelf keeps the requested skill until Retry succeeds instead of claiming the shelf is empty', async () => {
    const consumed = vi.fn()
    await act(async () => { root.render(<DesktopAgentPanelSkills agentId="alice" focusSlug="notes" onFocusConsumed={consumed} />) })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('needs recovery')
    expect(container.textContent).not.toContain('No skills yet')
    expect(container.textContent).not.toContain('Skill not found')
    expect(consumed).not.toHaveBeenCalled()
    fail = false
    await act(async () => { retry().click() })
    expect(consumed).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Edit skill')
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Read the notes first.')
    expect(container.querySelector('[role="alert"]')).toBeNull()
})

test('a failed same-owner refresh preserves visible saved rows and Retry replaces only a successful snapshot', async () => {
    fail = false
    const render = () => act(async () => { root.render(<DesktopAgentPanelSkills agentId="alice" />) })
    await render()
    const savedRow = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Saved notes'))!
    expect(savedRow).toBeDefined()
    fail = true
    state.proposals = new Map([['applied', { id: 'applied', status: 'applied' }]])
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('needs recovery')
    expect(container.textContent).not.toContain('No skills yet')
    expect([...container.querySelectorAll('button')].find(button => button.textContent?.includes('Saved notes'))).toBe(savedRow)
    fail = false
    await act(async () => { retry().click() })
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).toContain('Saved notes')
})
