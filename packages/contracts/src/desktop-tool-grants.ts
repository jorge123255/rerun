import { z } from 'zod'

export const desktopRerunGrantIds = ['privateFileWrite', 'workspaceRead', 'workspaceList', 'workspaceSearch', 'sharedFilesRead', 'memoryRecall', 'memoryWrite', 'memoryDelete', 'askUser', 'requestApproval', 'cardFile', 'cardTable', 'selfInstruction', 'verbositySet', 'webFetch', 'db', 'sharedDb', 'schedule', 'mcp', 'skills'] as const
export const desktopCodexGrantIds = ['workspaceRead', 'workspaceWrite', 'shell', 'webSearch', 'codeMode'] as const
export type DesktopRerunGrantId = typeof desktopRerunGrantIds[number]
export type DesktopCodexGrantId = typeof desktopCodexGrantIds[number]
export const desktopRerunGrantsSchema = z.partialRecord(z.enum(desktopRerunGrantIds), z.boolean())
export const desktopCodexGrantsSchema = z.partialRecord(z.enum(desktopCodexGrantIds), z.boolean())
export type DesktopRerunGrants = z.infer<typeof desktopRerunGrantsSchema>
export type DesktopCodexGrants = z.infer<typeof desktopCodexGrantsSchema>

type StoredGrants = { desktopToolGrants?: DesktopRerunGrants; desktopWorkspaceRead?: boolean; desktopCodexGrants?: DesktopCodexGrants }

export function desktopRerunGrantsOf(tools: StoredGrants): Record<DesktopRerunGrantId, boolean> {
    const grants = { workspaceRead: tools.desktopWorkspaceRead, ...tools.desktopToolGrants }
    return Object.fromEntries(desktopRerunGrantIds.map(id => [id, grants[id] === true])) as Record<DesktopRerunGrantId, boolean>
}

export function desktopCodexGrantsOf(tools: StoredGrants): Record<DesktopCodexGrantId, boolean> {
    return Object.fromEntries(desktopCodexGrantIds.map(id => [id, tools.desktopCodexGrants?.[id] === true])) as Record<DesktopCodexGrantId, boolean>
}

export type DesktopToolCatalogEntry = { id: string; label: string; description: string; tools: string[]; available: boolean; unavailableReason?: string; parent?: string }
const supported = (id: string, label: string, description: string, ...tools: string[]): DesktopToolCatalogEntry =>
    ({ id, label, description, tools, available: true })
const nested = (parent: string, id: string, label: string, description: string, ...tools: string[]): DesktopToolCatalogEntry =>
    ({ id, label, description, tools, available: true, parent })
const pending = (id: string, label: string, description: string, unavailableReason: string, ...tools: string[]): DesktopToolCatalogEntry =>
    ({ id, label, description, tools, available: false, unavailableReason })

export const desktopRerunToolCatalog: DesktopToolCatalogEntry[] = [
    supported('workspaceRead', 'Read workspace files', 'Read a visible text file in this coworker’s Files panel.', 'fs_read'),
    supported('workspaceList', 'List workspace files', 'List visible files and folders belonging to this coworker.', 'fs_list'),
    supported('workspaceSearch', 'Search workspace files', 'Find matching text in this coworker’s visible files.', 'fs_search'),
    supported('memoryRecall', 'Search memories', 'Find notes in this coworker’s Memories. Requires Use saved memories in chat.', 'memory_recall'),
    supported('memoryWrite', 'Write memories', 'Create or update this coworker’s notes. Requires Learn from replies.', 'memory_write'),
    supported('memoryDelete', 'Delete memories', 'Remove a specific note from this coworker’s Memories using its last known text.', 'memory_delete'),
    supported('askUser', 'Ask the user', 'Ask questions in chat and continue after you answer.', 'ask_user'),
    supported('requestApproval', 'Request approval', 'Ask you to approve or decline proposed actions in chat.', 'request_approval'),
    supported('cardFile', 'Show result files', 'Show this coworker’s existing text, Markdown, static images, WAV/MP3 audio, MP4 video or PDF documents as preview tiles in chat.', 'card_file'),
    supported('privateFileWrite', 'Edit workspace files', 'Create new text or Markdown files and make exact, conflict-checked edits in this coworker’s private Files. Existing names are never replaced by create.', 'fs_write', 'fs_edit'),
    supported('sharedFilesRead', 'Read shared files', 'Read and list text and Markdown files in the workspace shared folder. Every coworker with this permission sees the same shared documents.', 'shared_read', 'shared_list'),
    pending('shell', 'Run commands', 'Run Rerun shell commands in a workspace.', 'Requires a confined engine command runner.', 'shell_exec'),
    supported('webFetch', 'Read public web pages', 'Read public HTTP(S) text and HTML pages without cookies or saved files.', 'web_fetch'),
    pending('web', 'Use the web', 'Search or download content.', 'Rerun web search needs a search provider; downloads and saved pages are unavailable.', 'web_search', 'download'),
    supported('db', 'Private database', 'Read and change structured records in this coworker’s private database.', 'db_query', 'db_execute', 'db_schema'),
    supported('sharedDb', 'Shared database', 'Read and change workspace shared records.', 'shared_db_query', 'shared_db_execute', 'shared_db_schema'),
    pending('brain', 'Company brain', 'Search or propose changes to the team’s knowledge.', 'Requires a team knowledge store and proposal review.'),
    supported('skills', 'Skills', 'Create and use reusable procedures. Proposed changes wait for your review.', 'skill_list', 'skill_read', 'skill_read_file', 'skill_write_file', 'skill_delete_file', 'skill_create', 'skill_import', 'skill_edit', 'skill_update', 'skill_delete', 'skill_propose'),
    supported('schedule', 'Schedules', 'Run this coworker’s routines while Rerun is open. Configure and test tasks in Routines.'),
    pending('trigger', 'Triggers', 'Start a routine from an external event.', 'Requires an authenticated webhook service.'),
    pending('delegate', 'Delegate tasks', 'Spawn a worker for a task.', 'Requires isolated child runs and cancellation.'),
    pending('callAgent', 'Call coworkers', 'Ask another coworker to do work.', 'Requires target selection and scoped access to sibling runs.'),
    pending('browser', 'Use a browser', 'Operate a browser and hand it to a person.', 'Requires an isolated browser and a takeover view.'),
    pending('vision', 'Vision', 'Inspect images and screenshots.', 'Requires an image input path and a model with vision.'),
    pending('computer', 'Computer control', 'Interact with a desktop.', 'Requires an isolated desktop with screen and input permissions.'),
    pending('notify', 'Send notifications', 'Deliver a coworker notification.', 'Requires a Mac notification destination and user permission.'),
    pending('hub', 'Service catalog', 'Discover and configure Rerun services.', 'Requires an authenticated Rerun hub.'),
    pending('paidData', 'Paid data', 'Search external datasets.', 'Requires a configured provider and billing controls.'),
    supported('cardTable', 'Show table cards', 'Show a frozen snapshot of a saved database view in chat. Requires the matching private or shared database permission.', 'card_table'),
    pending('suggestService', 'Suggest services', 'Suggest a connection for the user to configure.', 'Requires the service connection flow.'),
    pending('requestSecret', 'Request a secret', 'Request a credential through a secure field.', 'Requires a secure entry and credential storage flow.'),
    supported('self', 'Improve itself', 'Let this coworker refine its own instructions and how long its answers are over time.', 'soul_update', 'verbosity_set'),
    nested('self', 'selfInstruction', 'Edit own instructions', 'Let this coworker rewrite its own instructions — the identity at the top of its prompt — and have them take effect from the next message.', 'soul_update'),
    nested('self', 'verbositySet', 'Change reply length', 'Let this coworker durably change how long its answers are, from minimal to detailed.', 'verbosity_set'),
    supported('mcp', 'Custom MCP servers', 'Use tools from this coworker’s configured HTTPS MCP servers. Configure connections in MCP servers.'),
    pending('foreman', 'Foreman', 'Build a team and work across coworkers.', 'Requires the board’s Foreman runtime and workspace authorization.'),
]

export const desktopCodexToolCatalog: DesktopToolCatalogEntry[] = [
    supported('workspaceRead', 'Include workspace files', 'Copy bounded, visible workspace text files into this coworker’s temporary folder for native commands or edits.'),
    supported('workspaceWrite', 'Edit temporary files', 'Use native Codex edits in this turn’s temporary folder. Changes are discarded. Original workspace files are preserved.', 'apply_patch'),
    supported('shell', 'Run shell commands', 'Run supported commands in a private temporary folder. Changes are discarded at the end of the turn. Include workspace files to read copies of this coworker’s text files.', 'exec_command'),
    supported('webSearch', 'Search the web', 'Use the Codex provider’s native web search.', 'web_search'),
    supported('codeMode', 'Code mode', 'Run JavaScript calculations in the bundled Codex host and call the Rerun tools granted to this coworker.', 'functions.exec'),
    pending('browser', 'Browser and computer', 'Use a browser or desktop from Codex.', 'Requires an isolated browser or desktop and its permissions.'),
    pending('images', 'Image generation and editing', 'Generate or edit an image in a Codex chat.', 'Requires a scoped image output store and preview.'),
    pending('subagents', 'Delegate to subagents', 'Start or continue child agents.', 'Requires scoped child runs, cancellation and activity history.'),
    pending('voice', 'Voice', 'Use the Codex voice input and output tools.', 'Requires a Mac microphone and playback flow.'),
    pending('connectors', 'External connectors', 'Connect external services and servers.', 'Requires configured accounts and scoped credentials.'),
]
