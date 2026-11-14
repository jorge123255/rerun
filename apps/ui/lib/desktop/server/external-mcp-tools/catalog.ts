import type { ExternalMcpScope, ExternalMcpToolRegistration } from '@rerun/contracts'
import { ACCOUNT_TOOL_DEFS } from '@/lib/mcp/account-tools'

/** Scope for each original account tool that this package can bind. Share/template tools stay unsupported. */
export const EXTERNAL_MCP_TOOL_SCOPES = {
    list_spaces: 'mcp:read',
    list_agents: 'mcp:read',
    get_team_status: 'mcp:read',
    get_agent: 'mcp:read',
    create_agent: 'coworkers:write',
    update_agent: 'coworkers:write',
    delete_agent: 'coworkers:write',
    list_ai_connections: 'mcp:read',
    set_default_model: 'coworkers:write',
    list_skills: 'mcp:read',
    get_skill: 'mcp:read',
    read_skill_file: 'mcp:read',
    upsert_skill: 'coworkers:write',
    write_memory: 'coworkers:write',
    upload_workspace_file: 'coworkers:write',
    delete_skill: 'coworkers:write',
    list_schedules: 'mcp:read',
    upsert_schedule: 'schedules:write',
    run_schedule_now: 'schedules:write',
    delete_schedule: 'schedules:write',
    list_triggers: 'mcp:read',
    upsert_trigger: 'triggers:write',
    test_trigger: 'triggers:write',
    rotate_trigger_token: 'triggers:write',
    delete_trigger: 'triggers:write',
    send_message: 'runs:send',
    list_runs: 'mcp:read',
    get_run: 'mcp:read',
    list_tables: 'mcp:read',
    db_query: 'mcp:read',
    db_execute: 'data:write',
    list_space_tables: 'mcp:read',
    space_db_query: 'mcp:read',
    space_db_execute: 'data:write',
    search_connectors: 'mcp:read',
    list_connectors: 'mcp:read',
    list_agent_connectors: 'mcp:read',
    attach_connector: 'connectors:write',
    detach_connector: 'connectors:write',
} as const satisfies Record<string, ExternalMcpScope>

export type ExternalMcpBoundToolName = keyof typeof EXTERNAL_MCP_TOOL_SCOPES

const READ_ONLY_OFFSET_NOTE = ' Local adapter accepts offset 0 only.'
const AUTHORITY_ADVERTISED = ['tools', 'selfImprovement', 'mcpServers', 'desktopToolGrants', 'desktopCodexGrants', 'desktopWorkspaceRead'] as const

function projectedInputSchema(name: string, schema: { properties?: Record<string, unknown>; required?: readonly string[] }) {
    if (name !== 'create_agent' && name !== 'update_agent') return { ...schema, additionalProperties: false }
    const properties = { ...(schema.properties ?? {}) }
    for (const key of AUTHORITY_ADVERTISED) delete properties[key]
    const required = (schema.required ?? []).filter(key => !AUTHORITY_ADVERTISED.includes(key as typeof AUTHORITY_ADVERTISED[number]))
    return { ...schema, properties, required, additionalProperties: false }
}

export function assertExternalMcpCatalogOmitsAuthorityFields(registrations: ExternalMcpToolRegistration[] = externalMcpToolRegistrations()): void {
    for (const registration of registrations) {
        if (registration.name !== 'create_agent' && registration.name !== 'update_agent') continue
        const properties = (registration.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
        for (const key of AUTHORITY_ADVERTISED) {
            if (Object.prototype.hasOwnProperty.call(properties, key)) throw new Error(`External catalog still advertises ${key} on ${registration.name}. No changes were applied.`)
        }
    }
}

export function externalMcpBoundToolNames(): ExternalMcpBoundToolName[] {
    return Object.keys(EXTERNAL_MCP_TOOL_SCOPES) as ExternalMcpBoundToolName[]
}

/** Registrations advertised by the live factory. Only names in EXTERNAL_MCP_TOOL_SCOPES. */
export function externalMcpToolRegistrations(options?: { servicesBound?: boolean }): ExternalMcpToolRegistration[] {
    const servicesBound = options?.servicesBound !== false
    const skip = new Set<string>(servicesBound ? [] : ['list_agent_connectors', 'attach_connector', 'detach_connector'])
    return ACCOUNT_TOOL_DEFS.filter(def => def.name in EXTERNAL_MCP_TOOL_SCOPES && !skip.has(def.name)).map(def => {
        const scope = EXTERNAL_MCP_TOOL_SCOPES[def.name as ExternalMcpBoundToolName]
        const effect = scope !== 'mcp:read'
        const description = def.name === 'read_skill_file' ? def.description + READ_ONLY_OFFSET_NOTE
            : def.name === 'create_agent' ? 'Create a coworker from its name and soul. Local creation uses workspace defaults and also requires runs:send. Tool grants and self-improvement are not accepted on this call; they stay on the Mac Tools panel.'
            : def.name === 'upload_workspace_file' ? 'Write one text or Markdown file (.txt or .md, up to 1 MB) into the coworker’s own Files. `path` is relative to its workspace, e.g. "notes/clients.md". A file already at that path is never replaced, and a folder that does not exist yet is not created: the file is then written at the top level with the folders folded into its name.'
            : def.name === 'update_agent' ? 'Update a coworker’s name, description, soul, handle, Box, verbosity, or model. Tool grants and self-improvement are not accepted on this call.'
            : def.description
        const inputSchema = def.name === 'attach_connector'
            ? { ...def.inputSchema, properties: { ...def.inputSchema.properties, authMethodId: { type: 'string', description: 'Exact locally supported authentication method ID.' }, values: { type: 'object', additionalProperties: { type: 'string' }, description: 'Explicit setup values; never reads an existing stored secret.' } }, additionalProperties: false }
            : def.name === 'read_skill_file'
            ? { ...def.inputSchema, properties: { ...def.inputSchema.properties, offset: { type: 'integer', const: 0 } }, additionalProperties: false }
            : projectedInputSchema(def.name, def.inputSchema)
        return { name: def.name, description, inputSchema, scope, effect }
    })
}
