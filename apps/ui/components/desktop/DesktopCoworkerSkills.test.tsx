// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopCoworkerSkills } from './DesktopCoworkerSkills'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const coworker = (id: string) => ({ id, name: id, description: '', createdAt: '', updatedAt: '' })

const skill = (slug: string, overrides: Partial<{ name: string; description: string; body: string; files: string[]; fromConnector: boolean }> = {}) => ({
    slug,
    name: slug,
    description: `About ${slug}`,
    body: `# ${slug}\n\nDo the thing.`,
    files: [],
    fromConnector: false,
    ...overrides,
})

const proposal = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    sessionId: 'session-1',
    toolCallId: `tc-${id}`,
    mode: 'create',
    slug: null,
    title: 'Keep a rule',
    summary: 'Keep the review rules',
    instructions: [],
    status: 'proposed',
    appliedSlug: null,
    error: null,
    createdAt: '2026-11-04T00:00:00.000Z',
    ...overrides,
})

const click = async (text: string) => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text || b.getAttribute('aria-label') === text)
    expect(button, text).toBeDefined()
    await act(async () => { button!.click() })
}

// A panel row carries its title, description and badges in one button; match on any part.
const clickRow = async (text: string) => {
    const row = [...document.querySelectorAll('button')].find(b => b.textContent?.includes(text))
    expect(row, text).toBeDefined()
    await act(async () => { row!.click() })
}

const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

// A stub of the authenticated desktop routes behind the panel: the shelf, create, and the
// proposal list/decide endpoints. The connector read-only refusal lives on the server, so the
// component test only exercises what the panel itself does with the rows it is given. The shelf
// array is mutable: a create lands in it, so the panel's reload shows the new row.
function skillsFetcher(options: { skills?: unknown[]; proposals?: unknown[] } = {}) {
    const proposals = options.proposals ?? []
    const skills = [...(options.skills ?? [])]
    const created: Record<string, unknown>[] = []
    const decided: Array<{ id: string; decision: string }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://127.0.0.1')
        const rest = url.pathname.split('/').filter(Boolean).slice(4) // after the agent id
        if (init?.method === 'POST' && rest[1] === 'proposals') {
            const body = JSON.parse(String(init.body)) as { decision: 'accept' | 'dismiss' }
            decided.push({ id: rest[2], decision: body.decision })
            const index = proposals.findIndex(p => (p as { id: string }).id === rest[2])
            const updated = index !== -1 ? { ...proposals[index], status: body.decision === 'accept' ? 'accepted' : 'dismissed' } : null
            if (index !== -1) proposals[index] = updated!
            return Response.json({ proposal: updated })
        }
        if (init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as Record<string, unknown>
            created.push(body)
            const newSkill = skill(String(body.name ?? 'imported'), { name: String(body.name ?? 'imported'), description: String(body.description ?? ''), body: String(body.body ?? '') })
            skills.push(newSkill)
            return Response.json({ skill: newSkill }, { status: 201 })
        }
        if (rest[1] === 'proposals') return Response.json({ availability: 'complete', proposals })
        if (rest[1]) return Response.json({ skill: skills.find(row => (row as { slug: string }).slug === rest[1]) })
        return Response.json({ skills })
    })
    return { fetcher, created, decided }
}

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

async function mountPanel(options: { skills?: unknown[]; proposals?: unknown[] } = {}) {
    const { fetcher, created, decided } = skillsFetcher(options)
    vi.stubGlobal('fetch', fetcher)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<DesktopCoworkerSkills agent={coworker('alice')} />) })
    await click('Skills')
    await flush()
    return { fetcher, created, decided, root }
}

test('lists the shelf, badges connector-owned skills, and opens them read-only', async () => {
    const { fetcher, root } = await mountPanel({
        skills: [skill('local', { name: 'Local skill' }), skill('app-skill', { name: 'App skill', fromConnector: true })],
    })
    expect(fetcher).toHaveBeenCalledWith('/api/desktop/agents/alice/skills', expect.anything())
    expect(document.body.textContent).toContain('Local skill')
    expect(document.body.textContent).toContain('App skill')
    // The connector-owned row wears the App badge inside its own row.
    expect([...document.querySelectorAll('button')].some(b => b.textContent?.includes('App skill') && b.textContent?.includes('App'))).toBe(true)

    await clickRow('App skill')
    await flush()
    expect(document.body.textContent).toContain('This skill is provided by an app and is managed automatically.')
    expect([...document.querySelectorAll('button')].some(b => b.getAttribute('aria-label') === 'Delete skill' || b.textContent?.trim() === 'Save changes')).toBe(false)
    act(() => root.unmount())
})

test('create flow posts the skill, returns to the shelf and the new row appears', async () => {
    const { created, root } = await mountPanel({ skills: [] })
    await click('New')
    await flush()

    const input = (placeholder: string) => [...document.querySelectorAll('input')].find(i => i.placeholder === placeholder)!
    const setValue = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
        const proto = element instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
        act(() => {
            setter.call(element, value)
            element.dispatchEvent(new Event('input', { bubbles: true }))
        })
    }
    setValue(input('Web Research'), 'Web Research')
    setValue(input('How to research a topic'), 'Find and summarize sources')
    setValue(document.querySelector('textarea')!, '1. Identify sources\n2. Fetch\n3. Summarize')
    await flush()
    await click('Create skill')
    await flush()

    expect(created).toEqual([{ kind: 'create', name: 'Web Research', description: 'Find and summarize sources', body: '1. Identify sources\n2. Fetch\n3. Summarize' }])
    // Back on the shelf, which reloads and now shows the created skill.
    expect(document.body.textContent).not.toContain('No skills yet')
    expect(document.body.textContent).toContain('Web Research')
    act(() => root.unmount())
})

test('proposal review pins a pending row and accept posts the decision', async () => {
    const { fetcher, decided, root } = await mountPanel({ proposals: [proposal('p1')] })
    expect(document.body.textContent).toContain('Proposed changes')
    expect(document.body.textContent).toContain('Remember this?')
    await click('Remember')
    await flush()
    expect(decided).toEqual([{ id: 'p1', decision: 'accept' }])
    expect(fetcher).toHaveBeenCalledWith('/api/desktop/agents/alice/skills/proposals/p1', expect.objectContaining({ method: 'POST' }))
    act(() => root.unmount())
})

test('an accepted proposal stays pinned while it is written, without decision buttons', async () => {
    const { root } = await mountPanel({ proposals: [proposal('p1')] })
    await click('Remember')
    await flush()
    // The row moved to accepted, stays pinned (never released mid-write), and reports the writing
    // state with no Remember/No buttons left to click.
    expect(document.body.textContent).toContain('Proposed changes')
    expect(document.body.textContent).toContain('Remembering')
    expect([...document.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Remember' || b.textContent?.trim() === 'No')).toBe(false)
    act(() => root.unmount())
})
