import { expect, it } from 'vitest'
import { ACCOUNT_TOOL_DEFS } from '@/lib/mcp/account-tools'
import { EXTERNAL_MCP_TOOL_SCOPES, externalMcpToolRegistrations } from './catalog'

it('pairs every bound tool with a B scope and effect flag that match', () => {
    for (const tool of externalMcpToolRegistrations({ servicesBound: true })) {
        const scope = EXTERNAL_MCP_TOOL_SCOPES[tool.name as keyof typeof EXTERNAL_MCP_TOOL_SCOPES]
        expect(tool.scope).toBe(scope)
        expect(tool.effect).toBe(scope !== 'mcp:read')
        const original = ACCOUNT_TOOL_DEFS.find(def => def.name === tool.name)
        expect(original?.description).toBeTruthy()
        expect(tool.description.startsWith(original!.description.slice(0, 20)) || tool.description === original!.description || tool.name === 'read_skill_file').toBe(true)
    }
})

it('preserves original account-tool order for bound registrations', () => {
    const bound = new Set(Object.keys(EXTERNAL_MCP_TOOL_SCOPES))
    const expected = ACCOUNT_TOOL_DEFS.map(def => def.name).filter(name => bound.has(name))
    expect(externalMcpToolRegistrations({ servicesBound: true }).map(tool => tool.name)).toEqual(expected)
})
