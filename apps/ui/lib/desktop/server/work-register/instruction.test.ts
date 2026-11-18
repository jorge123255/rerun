import { expect, test, vi } from 'vitest'
import { DESKTOP_FOREMAN_INSTRUCTIONS_LIMIT, type DesktopWorkItem } from '@rerun/contracts'

vi.mock('server-only', () => ({}))
const { desktopWorkRegisterInstruction } = await import('./instruction')
const { fitForemanInstructions } = await import('../foreman/instructions-fit')

const item = (index: number, status: DesktopWorkItem['status']): DesktopWorkItem => ({
    id: `w_${index}`, project: `project-${index % 4}`, owner: { kind: 'coworker', id: 'a1', name: 'Tuner Developer' }, objective: `Objective number ${index} ${'x'.repeat(120)}`,
    status, dependencies: [], blockers: status === 'blocked' ? 'Waiting for CI' : null, important: false, nextAction: 'Next step', latestUpdate: null, updates: [], evidence: [],
    approval: status === 'waiting_approval' ? { required: 'Merge it', decides: 'person' } : null, source: { kind: 'chief', id: null, name: 'Chief of Staff' },
    revision: 1, createdAt: '2026-11-17T00:00:00.000Z', updatedAt: '2026-11-17T00:00:00.000Z',
})
const brief = {
    counts: { proposed: 30, accepted: 0, working: 12, blocked: 2, waiting_approval: 1, done: 0, dropped: 0 },
    items: [item(1, 'waiting_approval'), item(2, 'blocked'), item(3, 'blocked'), ...Array.from({ length: 5 }, (_, index) => item(index + 4, 'working'))],
}
const dataOf = (text: string) => JSON.parse(text.slice(text.indexOf('{')))

test('the section passes counts and the few most relevant items, never the whole table, and shrinks to its budget', () => {
    const full = desktopWorkRegisterInstruction(brief, 3_000)!
    expect(full).toContain('Before you assign or hand over work, read it with work_list. Never assign an objective an open item already covers')
    expect(full).toContain('approves nothing')
    const data = dataOf(full)
    expect(data.counts).toEqual({ proposed: 30, working: 12, blocked: 2, waiting_approval: 1 })
    expect(data.items.length).toBeLessThanOrEqual(8)
    expect(data.items[0]).toMatchObject({ id: 'w_1', approvalRequired: 'Merge it' })
    let previous = full.length
    for (const budget of [2_400, 1_600, 1_100]) {
        const text = desktopWorkRegisterInstruction(brief, budget)
        expect(text, String(budget)).not.toBeNull()
        expect(text!.length).toBeLessThanOrEqual(budget)
        expect(text!.length).toBeLessThanOrEqual(previous)
        previous = text!.length
        expect(dataOf(text!).counts.working).toBe(12)
    }
    // Too small for the rules and the counts: nothing is said rather than a cut sentence.
    expect(desktopWorkRegisterInstruction(brief, 300)).toBeNull()
})

test('inside the Chief of Staff\'s turn it fits beside large fixed parts, and drops whole when there is no room', () => {
    const role = 'r'.repeat(DESKTOP_FOREMAN_INSTRUCTIONS_LIMIT - 1_500)
    const fitted = fitForemanInstructions([role, (budget: number) => desktopWorkRegisterInstruction(brief, Math.min(budget, 3_000)), 'Closing rule.'])
    expect(fitted.length).toBeLessThanOrEqual(DESKTOP_FOREMAN_INSTRUCTIONS_LIMIT)
    expect(fitted).toContain('The work register.')
    expect(fitted).toContain('Closing rule.')
    const crowded = fitForemanInstructions(['r'.repeat(DESKTOP_FOREMAN_INSTRUCTIONS_LIMIT - 400), (budget: number) => desktopWorkRegisterInstruction(brief, Math.min(budget, 3_000))])
    expect(crowded.length).toBeLessThanOrEqual(DESKTOP_FOREMAN_INSTRUCTIONS_LIMIT)
    expect(crowded).not.toContain('work register')
    // An empty register still tells the rules.
    expect(desktopWorkRegisterInstruction({ counts: brief.counts, items: [] }, 3_000)).toContain('"counts"')
})
