import { z } from 'zod'

export const desktopRerunGrantIds = ['workspaceRead', 'workspaceList', 'workspaceSearch', 'memoryRecall', 'memoryWrite', 'memoryDelete'] as const
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

export type DesktopToolCatalogEntry = { id: string; label: string; description: string; tools: string[]; available: boolean; unavailableReason?: string }
const supported = (id: string, label: string, description: string, ...tools: string[]): DesktopToolCatalogEntry =>
    ({ id, label, description, tools, available: true })
const pending = (id: string, label: string, description: string, unavailableReason: string, ...tools: string[]): DesktopToolCatalogEntry =>
    ({ id, label, description, tools, available: false, unavailableReason })

export const desktopRerunToolCatalog: DesktopToolCatalogEntry[] = [
    supported('workspaceRead', 'Read workspace files', 'Read a visible text file in this coworker’s Files panel.', 'fs_read'),
    supported('workspaceList', 'List workspace files', 'List visible files and folders belonging to this coworker.', 'fs_list'),
    supported('workspaceSearch', 'Search workspace files', 'Find matching text in this coworker’s visible files.', 'fs_search'),
    supported('memoryRecall', 'Search memories', 'Find notes in this coworker’s Memories. Requires Use saved memories in chat.', 'memory_recall'),
    supported('memoryWrite', 'Write memories', 'Create or update this coworker’s notes. Requires Learn from replies.', 'memory_write'),
    supported('memoryDelete', 'Delete memories', 'Remove a specific note from this coworker’s Memories using its last known text.', 'memory_delete'),
    pending('filesystem', 'Edit workspace files', 'Create and change workspace documents.', 'Requires conflict-safe writes in the workspace editor.', 'fs_write', 'fs_edit'),
    pending('shared', 'Shared files', 'Work on files visible to multiple coworkers.', 'Requires a shared workspace and its access controls.', 'shared_read', 'shared_write'),
    pending('shell', 'Run commands', 'Run Rerun shell commands in a workspace.', 'Requires a confined engine command runner.', 'shell_exec'),
    pending('web', 'Use the web', 'Search, fetch or download content.', 'Requires outbound request controls and a configured search provider.', 'web_search', 'web_fetch', 'download'),
    pending('db', 'Private database', 'Work with structured records in a coworker database.', 'Requires confined database access and bounded queries.', 'db_query', 'db_execute'),
    pending('sharedDb', 'Shared database', 'Work on records accessible across coworkers.', 'Requires shared table ownership and permissions.', 'shared_db_query'),
    pending('brain', 'Company brain', 'Search or propose changes to the team’s knowledge.', 'Requires a team knowledge store and proposal review.'),
    pending('skills', 'Skills', 'Create and use reusable procedures.', 'Requires a scoped skills store and a proposal review flow.'),
    pending('schedule', 'Schedules', 'Run coworker routines on a schedule.', 'Requires a local scheduling and restart policy.'),
    pending('trigger', 'Triggers', 'Start a routine from an external event.', 'Requires an authenticated webhook service.'),
    pending('delegate', 'Delegate tasks', 'Spawn a worker for a task.', 'Requires isolated child runs and cancellation.'),
    pending('callAgent', 'Call coworkers', 'Ask another coworker to do work.', 'Requires target selection and scoped access to sibling runs.'),
    pending('browser', 'Use a browser', 'Operate a browser and hand it to a person.', 'Requires an isolated browser and a takeover view.'),
    pending('vision', 'Vision', 'Inspect images and screenshots.', 'Requires an image input path and a model with vision.'),
    pending('computer', 'Computer control', 'Interact with a desktop.', 'Requires an isolated desktop with screen and input permissions.'),
    pending('notify', 'Send notifications', 'Deliver a coworker notification.', 'Requires a Mac notification destination and user permission.'),
    pending('hub', 'Service catalog', 'Discover and configure Rerun services.', 'Requires an authenticated Rerun hub.'),
    pending('paidData', 'Paid data', 'Search external datasets.', 'Requires a configured provider and billing controls.'),
    pending('cards', 'Result cards', 'Show files and structured results in chat.', 'Requires safe file or table previews in the chat panel.'),
    pending('quickReplies', 'Quick replies', 'Suggest one-click responses below a coworker reply.', 'Requires quick reply buttons in the Mac chat panel.'),
    pending('askUser', 'Ask the user', 'Ask a question and resume work after an answer.', 'Requires a resumable question card.'),
    pending('requestApproval', 'Request approval', 'Pause for a person to approve an action.', 'Requires resumable approvals in chat.'),
    pending('suggestService', 'Suggest services', 'Suggest a connection for the user to configure.', 'Requires the service connection flow.'),
    pending('requestSecret', 'Request a secret', 'Request a credential through a secure field.', 'Requires a secure entry and credential storage flow.'),
    pending('self', 'Self-improvement', 'Update instructions or install tools.', 'Requires a review flow and isolated installation.'),
    pending('mcp', 'Custom MCP servers', 'Add external tool servers.', 'Requires credential management and scoped server execution.'),
    pending('foreman', 'Foreman', 'Build a team and work across coworkers.', 'Requires the board’s Foreman runtime and workspace authorization.'),
]

export const desktopCodexToolCatalog: DesktopToolCatalogEntry[] = [
    pending('workspaceRead', 'Read files', 'Let the Codex runner inspect its coworker workspace.', 'Requires a verified per-coworker runner sandbox.'),
    pending('workspaceWrite', 'Write files', 'Let the Codex runner edit its coworker workspace.', 'Requires a confined writable workspace.'),
    pending('shell', 'Run shell commands', 'Use the Codex shell.', 'Requires an isolated command environment.'),
    supported('webSearch', 'Search the web', 'Use the Codex provider’s native web search.', 'web_search'),
    supported('codeMode', 'Code mode', 'Run JavaScript calculations in the bundled Codex host and call the Rerun tools granted to this coworker.', 'functions.exec'),
    pending('browser', 'Browser and computer', 'Use a browser or desktop from Codex.', 'Requires an isolated browser or desktop and its permissions.'),
    pending('connectors', 'External connectors', 'Connect external services and servers.', 'Requires configured accounts and scoped credentials.'),
]
