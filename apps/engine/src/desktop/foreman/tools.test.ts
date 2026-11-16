import { expect, test } from 'vitest'
import { FOREMAN_FORBIDDEN_TOOL_NAMES, foremanTools, type ForemanToolPorts } from './tools.js'

const binding = { workspaceId: 'ws-1', chatId: 'fmc_chat-0001', runId: 'run-1', model: { connectionId: 'conn-1', model: 'model-a' } }
const options = { messages: [], toolCallId: 'call-7' }

function ports(overrides: Partial<ForemanToolPorts> = {}) {
    const seen: unknown[] = []
    const value: ForemanToolPorts = {
        binding,
        reportShownPlan: async input => (seen.push(input), { ok: true }),
        navigate: async input => (seen.push(input), { ok: true }),
        discover: null,
        ...overrides,
    }
    return { value, seen }
}

test('no trusted binding means no Foreman tools at all', () => {
    expect(foremanTools(ports({ binding: null }).value)).toEqual({})
})

test('no tool can confirm, build, start setup or grant', () => {
    const names = Object.keys(foremanTools(ports().value))
    for (const forbidden of FOREMAN_FORBIDDEN_TOOL_NAMES) expect(names).not.toContain(forbidden)
    expect(names).toEqual(['show_plan', 'open_panel'])
})

test('show_plan forwards the exact binding and tool call id', async () => {
    const { value, seen } = ports()
    const plan = { title: 'Team', boxes: [], items: [{ kind: 'agent', name: 'Enquiries', role: 'Answers enquiries' }] }
    await foremanTools(value).show_plan!.execute!(plan as never, options)
    expect(seen).toEqual([{ binding, toolCallId: 'call-7', input: plan }])
})

test('the discovery tool only exists when root wires an authorized collector', () => {
    expect(Object.keys(foremanTools(ports({ discover: async () => ({}) }).value))).toContain('read_company')
})

test('team changes are only ever proposed: the tool hands the app a proposal and changes nothing itself', async () => {
    const proposed: unknown[] = []
    const { value } = ports({ proposeTeamChanges: async input => (proposed.push(input), { shown: 1, refused: [] }) })
    const tools = foremanTools(value)
    const names = Object.keys(tools)
    expect(names).toEqual(['show_plan', 'open_panel', 'propose_team_changes'])
    for (const forbidden of FOREMAN_FORBIDDEN_TOOL_NAMES) expect(names).not.toContain(forbidden)
    const input = { summary: 'Switch the developer on', changes: [{ action: 'switch_on', coworker: 'Tuner Developer' }] }
    expect(await tools.propose_team_changes!.execute!(input as never, options)).toEqual({ shown: 1, refused: [] })
    expect(proposed).toEqual([{ binding, toolCallId: 'call-7', input }])
    // Without the port the tool does not exist.
    expect(Object.keys(foremanTools(ports().value))).not.toContain('propose_team_changes')
})
