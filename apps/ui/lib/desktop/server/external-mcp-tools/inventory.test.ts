import { expect, it } from 'vitest'
import { ACCOUNT_TOOL_DEFS } from '@/lib/mcp/account-tools'
import { externalMcpBoundToolNames, externalMcpToolRegistrations } from './catalog'
import { externalMcpCatalogCounts, externalMcpSourceInventory } from './inventory'

it('retains original ordering, descriptions and schemas', () => {
    const rows = externalMcpSourceInventory()
    expect(rows.map(row => row.definition)).toEqual(ACCOUNT_TOOL_DEFS)
})

it('does not label run starts, token rotation, schedules or SQL writes as observational reads', () => {
    for (const name of ['send_message', 'run_schedule_now', 'test_trigger', 'rotate_trigger_token', 'db_execute', 'space_db_execute']) {
        expect(externalMcpSourceInventory().find(row => row.definition.name === name)?.readOnlyCandidate).toBe(false)
    }
})

it('marks share and template tools unsupported and does not register them', () => {
    const rows = externalMcpSourceInventory()
    expect(rows.filter(row => row.status === 'unsupported').every(row => !row.implemented)).toBe(true)
    const names = new Set(externalMcpToolRegistrations().map(tool => tool.name))
    expect(names.has('plan_agent_share')).toBe(false)
    expect(names.has('create_template')).toBe(false)
})

it('keeps connector install/remove dependent until services authority is injected', () => {
    expect(externalMcpSourceInventory({ servicesBound: false }).find(row => row.definition.name === 'attach_connector')?.status).toBe('dependent')
    expect(externalMcpSourceInventory({ servicesBound: true }).find(row => row.definition.name === 'attach_connector')?.status).toBe('implemented')
    expect(externalMcpToolRegistrations({ servicesBound: false }).some(tool => tool.name === 'attach_connector')).toBe(false)
    expect(externalMcpToolRegistrations({ servicesBound: true }).some(tool => tool.name === 'attach_connector')).toBe(true)
})

it('counts the bound local catalog honestly', () => {
    const unbound = externalMcpCatalogCounts({ servicesBound: false })
    expect(unbound.original).toBe(ACCOUNT_TOOL_DEFS.length)
    expect(unbound.implemented).toBe(externalMcpBoundToolNames().length - 3)
    expect(unbound.dependent).toBe(3)
    expect(unbound.implemented + unbound.dependent + unbound.unsupported).toBe(unbound.original)
    const bound = externalMcpCatalogCounts({ servicesBound: true })
    expect(bound.dependent).toBe(0)
    expect(bound.implemented).toBe(externalMcpBoundToolNames().length)
})
