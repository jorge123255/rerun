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
            : def.name === 'create_agent' ? def.description + ' Local creation starts its first chat and additionally requires runs:send. Creation uses workspace defaults; model and reply settings can be changed afterward with update_agent; tool grants and self-improvement stay on the Mac Tools panel.' : def.description
        const inputSchema = def.name === 'attach_connector'
            ? { ...def.inputSchema, properties: { ...def.inputSchema.properties, authMethodId: { type: 'string', description: 'Exact locally supported authentication method ID.' }, values: { type: 'object', additionalProperties: { type: 'string' }, description: 'Explicit setup values; never reads an existing stored secret.' } }, additionalProperties: false }
            : def.name === 'read_skill_file'
            ? { ...def.inputSchema, properties: { ...def.inputSchema.properties, offset: { type: 'integer', const: 0 } }, additionalProperties: false }
            : { ...def.inputSchema, additionalProperties: false }
        return { name: def.name, description, inputSchema, scope, effect }
    })
}
