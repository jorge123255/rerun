import { expect, it } from 'vitest'
import { ACCOUNT_TOOL_DEFS } from '@/lib/mcp/account-tools'
import { externalMcpSourceInventory } from './inventory'
it('retains original ordering, descriptions and schemas without advertising executable support', () => {
    const rows = externalMcpSourceInventory()
    expect(rows.map(row => row.definition)).toEqual(ACCOUNT_TOOL_DEFS)
    expect(rows.every(row => !row.implemented)).toBe(true)
})
it('does not label run starts, token rotation, schedules or SQL writes as observational reads', () => {
    for (const name of ['send_message', 'run_schedule_now', 'test_trigger', 'rotate_trigger_token', 'db_execute', 'space_db_execute']) {
        expect(externalMcpSourceInventory().find(row => row.definition.name === name)?.readOnlyCandidate).toBe(false)
    }
})
