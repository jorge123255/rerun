// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import type { DesktopTeamChange, DesktopTeamChanges } from '@rerun/contracts'
import type { TeamChangesAnswer, TeamChangesPorts } from '@/lib/desktop/team-changes-client'
import { DesktopForemanTeamChanges } from './DesktopForemanTeamChanges'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren() })
const chat = { workspaceId: '1', chatId: 'fmc_teamcard00001' }
const change = (key: string, label: string, extra: Partial<DesktopTeamChange> = {}): DesktopTeamChange => ({
    key, action: 'switch_on', agentId: key, coworker: 'Dev', permission: null, connectionId: null, model: null, effort: null, label, caution: null, result: null, ...extra,
})
function fake(card: DesktopTeamChanges | null) {
    const state = { answer: { changes: card } as TeamChangesAnswer, calls: [] as string[] }
    const ports = {
        read: async () => state.answer,
        settle: async (id, kind, results) => {
            state.calls.push(`settle ${kind} ${results.map(result => result.key).join(',')}`)
            state.answer = { changes: { ...card!, state: kind, changes: card!.changes.map(item => { const result = results.find(row => row.key === item.key); return result ? { ...item, result: { ok: result.ok, message: result.message } } : item }) } }
            return state.answer
        },
        setEnabled: async (id, enabled) => { if (id === 'change-1') throw new Error('This coworker is being deleted.'); state.calls.push(`enabled ${id} ${enabled}`) },
    } as Partial<TeamChangesPorts> as TeamChangesPorts
    return { ports, state }
}
async function render(ports: TeamChangesPorts) {
    root ??= createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopForemanTeamChanges chat={chat} ports={ports} />))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
}
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
const card = (): DesktopTeamChanges => ({ id: 'ftc_12345678', summary: 'Get the team ready', state: 'shown', createdAt: 'now', changes: [
    change('change-0', 'Switch on Tuner Developer'), change('change-1', 'Switch on Server Developer'), change('change-2', 'Give Dev your GitHub sign-in', { caution: 'It also reaches Gmail.' }),
] })

it('shows nothing when no changes were proposed', async () => {
    await render(fake(null).ports)
    expect(document.querySelector('[data-foreman-team-changes]')).toBeNull()
})

it('applies only what stays ticked, after one click, and says how each line went', async () => {
    const { ports, state } = fake(card())
    await render(ports)
    const section = () => document.querySelector('[data-foreman-team-changes]')!
    expect(section().textContent).toContain('Get the team ready')
    expect(section().textContent).toContain('It also reaches Gmail.')
    expect(section().textContent).toContain('Nothing changes until you apply.')
    // Nothing was done by showing the card.
    expect(state.calls).toEqual([])
    await act(async () => document.querySelector<HTMLInputElement>('[data-team-change="change-2"] input')!.click())
    const apply = document.querySelector<HTMLButtonElement>('[data-team-changes-apply]')!
    expect(apply.textContent).toBe('Apply 2 of 3')
    await act(async () => apply.click())
    await settle()
    expect(state.calls).toEqual(['enabled change-0 true', 'settle applied change-0,change-1'])
    expect(section().getAttribute('data-foreman-team-changes')).toBe('applied')
    expect(section().textContent).toContain('1 applied, 1 could not be applied')
    expect(section().textContent).toContain('This coworker is being deleted.')
    expect(document.querySelector('[data-team-change="change-2"]')!.textContent).toContain('Left out.')
    expect(document.querySelector('[data-team-changes-apply]')).toBeNull()
})

it('dismisses a card without changing anything', async () => {
    const { ports, state } = fake(card())
    await render(ports)
    await act(async () => document.querySelector<HTMLButtonElement>('[data-team-changes-dismiss]')!.click())
    await settle()
    expect(state.calls).toEqual(['settle dismissed '])
    expect(document.querySelector('[data-foreman-team-changes]')).toBeNull()
})
