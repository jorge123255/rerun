/** Read-only Foreman views of the local workspace catalog. Not teamRead, skills, db, or a file grant. */
export const FOREMAN_WORKSPACE_READ_TOOL_NAMES = ['list_spaces', 'list_agents', 'list_schedules', 'list_triggers'] as const
export type ForemanWorkspaceReadToolName = (typeof FOREMAN_WORKSPACE_READ_TOOL_NAMES)[number]

export const FOREMAN_WORKSPACE_READ_ROW_LIMIT = 50
export const FOREMAN_WORKSPACE_READ_DESCRIPTION_LIMIT = 240

/** In-file desktop_agents.workspace_id. The Foreman binding carries the runtime workspace id instead. */
export const FOREMAN_WORKSPACE_CATALOG_ID = '1'

export const FOREMAN_WORKSPACE_READ_MESSAGES = {
    refused: 'Reading this workspace is switched off for Foreman.',
    unbound: 'Foreman workspace reads are not wired on this Mac yet.',
    otherWorkspace: 'That coworker is not in this workspace.',
    notFound: 'That coworker was not found in this workspace.',
    stale: 'That workspace revision is stale. Read it again.',
    unavailable: 'That workspace read is unavailable. It was not retried.',
    malformed: 'That workspace read is not valid.',
    limit: 'Too many rows for one workspace read. Narrow the request.',
    runClosed: 'This Foreman run can no longer read the workspace.',
} as const

export const FOREMAN_WORKSPACE_READ_DESCRIPTIONS = {
    list_spaces: 'List the Boxes of this workspace: id, name, and how many coworkers sit in each. Read-only. Pass revision from a previous answer to pin that board version; a different version is refused.',
    list_agents: 'List the coworkers of this workspace: id, name, handle, description, Box, and whether they are enabled. Read-only. An optional spaceId restricts the list to one Box from list_spaces.',
    list_schedules: "Read one coworker's routines in this workspace: name, instruction, cron or date, enabled state, and last run time. Read-only. Does not run them.",
    list_triggers: "Read one coworker's webhook triggers in this workspace: name, instruction, methods, enabled state, fire count, and last fire. Read-only. Webhook URLs and tokens are not included.",
} as const

export type ForemanWorkspaceRosterRow = {
    id: string
    workspaceId: string
    name: string
    handle: string | null
    description: string
    spaceId: string | null
    enabled: boolean
    deleting: boolean
}

export type ForemanWorkspaceBoxRow = { id: string; name: string }

export type ForemanWorkspaceSnapshot =
    | {
          kind: 'ready'
          workspaceId: string
          catalogWorkspaceId: string
          revision: number
          boxes: ForemanWorkspaceBoxRow[]
          roster: ForemanWorkspaceRosterRow[]
          foreignIds: string[]
      }
    | { kind: 'missing' }
    | { kind: 'other-workspace' }
    | { kind: 'uncertain' }
    | { kind: 'revoked' }
