import { ACCOUNT_TOOL_DEFS } from '@/lib/mcp/account-tools'
import { EXTERNAL_MCP_TOOL_SCOPES, type ExternalMcpBoundToolName } from './catalog'

const families = {
    agents: ['list_spaces', 'list_agents', 'get_team_status', 'get_agent', 'create_agent', 'update_agent', 'delete_agent'],
    models: ['list_ai_connections', 'set_default_model'],
    skills: ['list_skills', 'get_skill', 'read_skill_file', 'upsert_skill', 'delete_skill'],
    routines: ['list_schedules', 'upsert_schedule', 'run_schedule_now', 'delete_schedule'],
    triggers: ['list_triggers', 'upsert_trigger', 'test_trigger', 'rotate_trigger_token', 'delete_trigger'],
    runs: ['send_message', 'list_runs', 'get_run'],
    tables: ['list_tables', 'db_query', 'db_execute', 'list_space_tables', 'space_db_query', 'space_db_execute'],
    connectors: ['search_connectors', 'list_connectors', 'list_agent_connectors', 'attach_connector', 'detach_connector'],
} as const

const SHARE = new Set(['plan_agent_share', 'create_agent_share', 'list_agent_shares', 'revoke_agent_share'])
const reads = new Set(Object.entries(EXTERNAL_MCP_TOOL_SCOPES).filter(([, scope]) => scope === 'mcp:read').map(([name]) => name))

const DEPENDENT = {
    list_agent_connectors: 'Requires root-injected ExternalMcpServicesAuthority from LocalServices.',
    attach_connector: 'Requires root-injected ExternalMcpServicesAuthority; authMethodId+values required. OAuth/browser methods stay local UI.',
    detach_connector: 'Requires root-injected ExternalMcpServicesAuthority with revisioned remove.',
} as const

export type ExternalMcpInventoryStatus = 'implemented' | 'dependent' | 'unsupported'

/** Source inventory + live catalog status. Not itself a tools/list response. */
export function externalMcpSourceInventory(options?: { servicesBound?: boolean }) {
    const servicesBound = options?.servicesBound === true
    return ACCOUNT_TOOL_DEFS.map(definition => {
        const family = Object.entries(families).find(([, names]) => (names as readonly string[]).includes(definition.name))?.[0]
            ?? (SHARE.has(definition.name) ? 'sharing' : 'templates')
        const bound = definition.name in EXTERNAL_MCP_TOOL_SCOPES
        const dependent = definition.name in DEPENDENT
        let status: ExternalMcpInventoryStatus
        let blockedBy: string | null = null
        let implemented = false
        if (!bound) {
            status = 'unsupported'
            blockedBy = SHARE.has(definition.name)
                ? 'Round36 share lane owns local share authority; not registered on the external catalog.'
                : 'Template authoring/publishing is unsupported on local external keys.'
        } else if (dependent && !servicesBound) {
            status = 'dependent'
            blockedBy = DEPENDENT[definition.name as keyof typeof DEPENDENT]
            implemented = false
        } else {
            status = 'implemented'
            implemented = true
        }
        return {
            definition,
            family,
            readOnlyCandidate: reads.has(definition.name),
            scope: bound ? EXTERNAL_MCP_TOOL_SCOPES[definition.name as ExternalMcpBoundToolName] : null,
            status,
            implemented,
            blockedBy,
        }
    })
}

export function externalMcpCatalogCounts(options?: { servicesBound?: boolean }) {
    const rows = externalMcpSourceInventory(options)
    return {
        original: rows.length,
        implemented: rows.filter(row => row.status === 'implemented').length,
        dependent: rows.filter(row => row.status === 'dependent').length,
        unsupported: rows.filter(row => row.status === 'unsupported').length,
    }
}
