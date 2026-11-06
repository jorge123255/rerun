import { ACCOUNT_TOOL_DEFS } from '@/lib/mcp/account-tools'

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

const reads = new Set(['list_spaces', 'list_agents', 'get_team_status', 'get_agent', 'list_ai_connections', 'list_skills', 'get_skill', 'read_skill_file', 'list_schedules', 'list_triggers', 'list_runs', 'get_run', 'list_tables', 'db_query', 'list_space_tables', 'space_db_query', 'search_connectors', 'list_connectors', 'list_agent_connectors'])

/** Source inventory only. These definitions MUST NOT be registered as executable tools. */
export function externalMcpSourceInventory() {
    return ACCOUNT_TOOL_DEFS.map(definition => ({
        definition,
        family: Object.entries(families).find(([, names]) => (names as readonly string[]).includes(definition.name))?.[0] ?? 'sharing_or_templates',
        readOnlyCandidate: reads.has(definition.name),
        implemented: false as const,
        blockedBy: 'B published principal/grant/dispatch contract is required before adapter implementation.',
    }))
}
