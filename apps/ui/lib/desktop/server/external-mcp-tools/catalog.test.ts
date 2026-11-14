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
        if (tool.name === 'create_agent' || tool.name === 'update_agent') {
            expect(tool.description).toBe(tool.name === 'create_agent'
                ? 'Create a coworker from its name and soul. Local creation uses workspace defaults and also requires runs:send. Tool grants and self-improvement are not accepted on this call; they stay on the Mac Tools panel.'
                : 'Update a coworker’s name, description, soul, handle, Box, verbosity, or model. Tool grants and self-improvement are not accepted on this call.')
            const schema = tool.inputSchema as { properties?: Record<string, unknown>; additionalProperties?: boolean }
            expect(schema.additionalProperties).toBe(false)
            for (const field of ['tools', 'selfImprovement', 'mcpServers', 'desktopToolGrants', 'desktopCodexGrants', 'desktopWorkspaceRead']) expect(schema.properties).not.toHaveProperty(field)
        } else if (tool.name === 'read_skill_file') {
            expect(tool.description).toBe(original!.description + ' Local adapter accepts offset 0 only.')
        } else if (tool.name === 'upload_workspace_file') {
            // The Mac's import is narrower than the hosted upload: text only, no replacing, no new folders.
            expect(tool.description).toMatch(/^Write one text or Markdown file \(\.txt or \.md, up to 1 MB\)/)
            expect(tool.description.length).toBeLessThanOrEqual(1024)
        } else {
            expect(tool.description).toBe(original!.description)
        }
    }
})

it('preserves original account-tool order for bound registrations', () => {
    const bound = new Set(Object.keys(EXTERNAL_MCP_TOOL_SCOPES))
    const expected = ACCOUNT_TOOL_DEFS.map(def => def.name).filter(name => bound.has(name))
    expect(externalMcpToolRegistrations({ servicesBound: true }).map(tool => tool.name)).toEqual(expected)
})
