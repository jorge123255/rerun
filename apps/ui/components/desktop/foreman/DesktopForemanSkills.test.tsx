// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { SkillProposal } from '@rerun/contracts'
import { DesktopForemanSkills } from './DesktopForemanSkills'
import { useDesktopForemanSkills } from './useDesktopForemanSkills'

const chat = { workspaceId: '1', chatId: 'fmc_00000000-0000-4000-8000-000000000000' }
const sessionId = 'engine-chief-home'
const candidate = (id: string): SkillProposal & { revision: string } => ({
    id, sessionId, toolCallId: 'call-' + id, mode: 'create', slug: null, title: 'Procedure ' + id, summary: 'Details',
    instructions: ['Keep the ' + id + ' rule'], status: 'proposed', appliedSlug: null, error: null,
    createdAt: '2026-11-18T12:00:00Z', revision: (id === 'alpha' ? 'a' : 'b').repeat(64),
})
function Fixture() {
    const model = useDesktopForemanSkills(chat, sessionId, true, 'idle')
    const [slug, open] = useState<string | null>(null)
    return <DesktopForemanSkills chat={chat} model={model} slug={slug} open={open} close={() => {}} />
}
let root: Root | undefined
async function mount() {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => { root!.render(<Fixture />) })
}
afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals()
})
async function press(label: string, index = 0) {
    const buttons = [...document.querySelectorAll('button')].filter(button => button.textContent === label)
    expect(buttons.length).toBeGreaterThan(index)
    await act(async () => buttons[index].click())
}

it('binds Remember and No to the shown revisions, then reopens the saved decisions and approved body', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const rows = [candidate('alpha'), candidate('beta')]
    const posts: unknown[] = []
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
            const body = JSON.parse(String(init.body))
            posts.push(body)
            const row = rows.find(r => r.id === body.proposalId)!
            row.status = body.decision === 'accept' ? 'applied' : 'dismissed'
            row.appliedSlug = row.status === 'applied' ? row.id : null
            return Response.json({ chat, proposal: row })
        }
        const query = new URL(url, 'http://localhost').searchParams
        expect(query.get('workspaceId')).toBe(chat.workspaceId)
        expect(query.get('chatId')).toBe(chat.chatId)
        const skills = rows.filter(row => row.status === 'applied').map(row => ({slug: row.id, name: row.title, description: row.summary}))
        if (query.has('slug')) return Response.json({chat, skill: {...skills[0], body: 'The saved alpha instructions.'}})
        return Response.json({ chat, skills, proposals: rows })
    })
    vi.stubGlobal('fetch', fetcher)
    await mount()
    expect(document.querySelector('[data-foreman-skill-shelf]')?.textContent).toContain('No skills yet')
    await press('Remember')
    await press('No')
    expect(posts).toEqual([{ chat, proposalId: 'alpha', decision: 'accept', revision: 'a'.repeat(64) }, { chat, proposalId: 'beta', decision: 'dismiss', revision: 'b'.repeat(64) }])
    await act(async () => root!.unmount())
    await mount()
    expect(document.querySelector('[data-foreman-skill-decisions]')?.textContent).toContain('RememberedProcedure alpha')
    expect(document.querySelector('[data-foreman-skill-decisions]')?.textContent).toContain('Not rememberedProcedure beta')
    const shelf = document.querySelector('[data-foreman-skill-shelf]')?.textContent
    expect(shelf).toContain('Procedure alpha')
    expect(shelf).not.toContain('Procedure beta')
    await press('View')
    expect(document.querySelector('[role=dialog] article')?.textContent).toContain('The saved alpha instructions.')
})

it('withholds foreign-session rows and refreshes the exact chat after an uncertain decision', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    let changed = false
    let writes = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') { writes++; changed = true; return Response.json({}, { status: 409 }) }
        const row = candidate('alpha')
        return Response.json({ chat, skills: [], proposals: [changed ? { ...row, sessionId: 'another-chat', title: 'Private proposal' } : row] })
    }))
    await mount()
    await press('Remember')
    expect(writes).toBe(1)
    expect(document.querySelector('[role=alert]')?.textContent).toContain('Could not confirm the skill decision')
    expect(document.body.textContent).not.toContain('Private proposal')
    expect(document.querySelector('[data-foreman-skill-decisions]')).toBeNull()
})
