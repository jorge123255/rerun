/** Dedicated Mac grant. Not hosted `tools.team` (that flag defaults on) and not callAgent, scheduleManage, trigger, or mcp:read. */
export const DESKTOP_TEAM_READ_GRANT_ID = 'teamRead' as const

export const DESKTOP_TEAM_READ_TOOL_NAMES = ['team_status', 'team_list_schedules', 'team_list_triggers', 'team_list_runs', 'team_get_run'] as const
export type DesktopTeamReadToolName = (typeof DESKTOP_TEAM_READ_TOOL_NAMES)[number]

export const DESKTOP_TEAM_READ_FIELD_LIMIT = 2_000
export const DESKTOP_TEAM_READ_RESPONSE_LIMIT = 200_000
export const DESKTOP_TEAM_READ_RUN_LIMIT_DEFAULT = 20
export const DESKTOP_TEAM_READ_RUN_LIMIT_MAX = 200

export const DESKTOP_TEAM_MEMBER_STATUSES = ['switched_off', 'unconfigured', 'offline', 'working', 'waiting_human', 'error', 'idle'] as const
export type DesktopTeamMemberStatus = (typeof DESKTOP_TEAM_MEMBER_STATUSES)[number]

/** Same waiting set as hosted team status. Any other session status is not waiting on a person. */
export const DESKTOP_TEAM_WAITING_SESSION_STATUSES = ['waiting_human', 'awaiting_question', 'awaiting_approval', 'awaiting_connector', 'awaiting_ack'] as const
export type DesktopTeamWaitingSessionStatus = (typeof DESKTOP_TEAM_WAITING_SESSION_STATUSES)[number]

export const DESKTOP_TEAM_READ_MESSAGES = {
    switchedOff: 'Reading other coworkers is switched off for this coworker.',
    unbound: 'Team reads are not wired on this Mac yet.',
    workspaceUnbound: "This coworker's workspace is not bound.",
    otherWorkspace: 'That coworker is not in this workspace.',
    notFound: 'That coworker was not found in this workspace.',
    runNotFound: 'That run was not found for this coworker.',
    unavailable: 'That coworker read is unavailable. It was not retried.',
    runClosed: 'This run can no longer read other coworkers.',
    malformed: 'That coworker id is not valid.',
} as const

export const DESKTOP_TEAM_READ_DESCRIPTIONS = {
    team_status: 'See every coworker of the workspace right now: id, name, handle, status (working, waiting_human, error, idle, offline, switched_off, unconfigured), runs in flight, conversations waiting on a person, and the last finished run with its error. Start here to audit the team. Read-only.',
    team_list_schedules: "Read another coworker's scheduled tasks in full: name, instruction, cron or date, enabled state and last run. Read-only.",
    team_list_triggers: "Read another coworker's webhook triggers: name, instruction, methods, enabled state, fire count and last fire. Read-only, the webhook URLs are not shared.",
    team_list_runs: "Another coworker's recent runs, newest first: status, what triggered them, start and end, model, cost and error. Use it to check that a scheduled task ran. A run marked done only ended without a technical error: read its output with team_get_run before saying the task worked. Read-only.",
    team_get_run: 'One run of another coworker: final output, status, error and cost. Set includeToolCalls only to diagnose a failure: it adds every tool the coworker called, each input and result cut at 2,000 characters, and can carry data from its connected apps. Read-only.',
} as const

export const DESKTOP_TEAM_READ_AGENT_ID = 'The coworker id, as team_status returns it.'
export const DESKTOP_TEAM_READ_AGENT_FILTER = 'Optional: restrict to one coworker.'
export const DESKTOP_TEAM_READ_LIMIT = 'Default 20, max 200.'

/** Display labels from hosted chat-tool-display. */
export const DESKTOP_TEAM_READ_LABELS = {
    team_status: 'Team Status',
    team_list_schedules: "List a Coworker's Schedules",
    team_list_triggers: "List a Coworker's Triggers",
    team_list_runs: "List a Coworker's Runs",
    team_get_run: "Read a Coworker's Run",
} as const

/** Activity lines that exist on the hosted display map. Schedules and triggers have none there. */
export const DESKTOP_TEAM_READ_ACTIVITY = {
    team_status: 'Checking the team',
    team_list_runs: "Reading a coworker's runs",
    team_get_run: "Reading a coworker's run",
} as const

/** Icon component names from hosted tool-meta. Root maps them to the icon imports. */
export const DESKTOP_TEAM_READ_ICONS = {
    team_status: 'ActivityIcon',
    team_list_schedules: 'CalendarIcon',
    team_list_triggers: 'WebhookIcon',
    team_list_runs: 'HistoryIcon',
    team_get_run: 'HistoryIcon',
} as const

export const DESKTOP_TEAM_READ_PERMISSION = {
    id: DESKTOP_TEAM_READ_GRANT_ID,
    icon: 'ActivityIcon',
    label: 'See other coworkers',
    blurb: 'Read their routines and runs',
    help: "Lets the coworker check the other coworkers of the workspace: their status, scheduled tasks, triggers and recent runs, with the tools each run called when it needs to understand a failure. It cannot change anything. A run can hold data from the other coworker's connected apps.",
} as const

export const DESKTOP_TEAM_READ_PROMPT = 'team_status, team_list_schedules, team_list_triggers, team_list_runs and team_get_run read coworkers in this workspace only when See other coworkers is on for this coworker. Call coworkers, routines, triggers, and external mcp:read do not turn these on. They change nothing. Webhook URLs and tokens are not included. A run marked done only ended without a technical error. team_get_run with includeToolCalls can include data from that coworker\'s connected apps. If a read is unavailable, say so and do not retry it.'

/**
 * Workspace directory for the local desktop_agents table (workspace_id is the caller's row).
 * Root runs these. A row whose workspace_id differs is a refusal, not an empty team.
 * If lookup returns more than one row, treat it as unavailable rather than picking one.
 */
export const DESKTOP_TEAM_DIRECTORY_CALLER_SQL = `SELECT a.id, a.workspace_id, a.engine_agent_id
FROM desktop_agents a
WHERE a.engine_agent_id = ? AND a.enabled = 1
  AND NOT EXISTS(SELECT 1 FROM desktop_deletions d WHERE d.agent_id = a.id)`

export const DESKTOP_TEAM_DIRECTORY_MEMBER_SQL = `SELECT a.id, a.workspace_id, a.engine_agent_id, a.name, a.enabled,
       c.handle AS handle,
       p.space_id AS space_id,
       EXISTS(SELECT 1 FROM desktop_deletions d WHERE d.agent_id = a.id) AS deleting
FROM desktop_agents a
LEFT JOIN desktop_rename_checks c ON c.agent_id = a.id
LEFT JOIN desktop_space_placements p ON p.agent_id = a.id
WHERE a.workspace_id = ?
ORDER BY a.created_at, a.id`

export const DESKTOP_TEAM_DIRECTORY_LOOKUP_SQL = `SELECT a.id, a.workspace_id, a.engine_agent_id, a.name, a.enabled,
       c.handle AS handle,
       p.space_id AS space_id,
       EXISTS(SELECT 1 FROM desktop_deletions d WHERE d.agent_id = a.id) AS deleting
FROM desktop_agents a
LEFT JOIN desktop_rename_checks c ON c.agent_id = a.id
LEFT JOIN desktop_space_placements p ON p.agent_id = a.id
WHERE a.id = ? OR a.engine_agent_id = ?`

/** True only for the dedicated flag. Hosted family switches and unrelated Mac grants stay off. */
export function desktopTeamReadGrantOn(config: unknown): boolean {
    if (!config || typeof config !== 'object') return false
    const tools = (config as { tools?: unknown }).tools
    if (!tools || typeof tools !== 'object') return false
    const grants = (tools as { desktopToolGrants?: unknown }).desktopToolGrants
    if (!grants || typeof grants !== 'object' || Array.isArray(grants)) return false
    return (grants as Record<string, unknown>).teamRead === true
}

export function desktopTeamReadTooLarge(name: string, size: number, limit = DESKTOP_TEAM_READ_RESPONSE_LIMIT): string {
    return `${name} produced ${size} characters, over the ${limit} limit for one tool result. Narrow the request (fewer rows, a single item, or drop includeToolCalls) rather than retrying as is.`
}
