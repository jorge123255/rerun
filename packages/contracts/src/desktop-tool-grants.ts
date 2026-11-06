import { z } from 'zod'

export const desktopRerunGrantIds = ['privateFileWrite', 'workspaceRead', 'workspaceList', 'workspaceSearch', 'sharedFilesRead', 'memoryRecall', 'memoryWrite', 'memoryDelete', 'askUser', 'requestApproval', 'requestSecret', 'cardFile', 'cardTable', 'selfInstruction', 'verbositySet', 'webFetch', 'webSearch', 'db', 'sharedDb', 'schedule', 'scheduleManage', 'toolInstall', 'mcp', 'selfMcpRegister', 'localMcpStdio', 'nativeWriteback', 'brain', 'skills', 'services', 'suggestService', 'browser', 'computer', 'terminalLaunch', 'filesLaunch', 'callAgent', 'trigger', 'delegate'] as const
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
    supported('cardFile', 'Show result files', 'Show this coworker’s existing text, Markdown, PNG, JPEG, WebP, SVG, GIF and AVIF images, WAV/MP3/M4A/Ogg/FLAC audio, MP4/WebM/MOV/M4V video or PDF documents as preview tiles in chat.', 'card_file'),
    supported('privateFileWrite', 'Edit workspace files', 'Create new text or Markdown files and make exact, conflict-checked edits in this coworker’s private Files. Existing names are never replaced by create.', 'fs_write', 'fs_edit'),
    supported('sharedFilesRead', 'Read shared files', 'Read and list text and Markdown files in the workspace shared folder. Every coworker with this permission sees the same shared documents.', 'shared_read', 'shared_list'),
    pending('shell', 'Run commands', 'Run Rerun shell commands in a workspace.', 'Requires a confined engine command runner.', 'shell_exec'),
    supported('webFetch', 'Read public web pages', 'Read public HTTP(S) text and HTML pages without cookies or saved files.', 'web_fetch'),
    supported('webSearch', 'Search public web', 'Search with the Brave Search key in Settings. Separate from native Codex search.', 'web_search'),
    pending('web', 'Download files', 'Download remote content.', 'Requires a reviewed download destination.', 'download'),
    supported('db', 'Private database', 'Read and change structured records in this coworker’s private database.', 'db_query', 'db_execute', 'db_schema'),
    supported('sharedDb', 'Shared database', 'Read and change workspace shared records.', 'shared_db_query', 'shared_db_execute', 'shared_db_schema'),
    supported('brain', 'Company brain', 'Read and search shared company knowledge, and propose changes for your review.', 'brain_read', 'brain_search', 'brain_propose'),
    supported('skills', 'Skills', 'Create and use reusable procedures. Proposed changes wait for your review.', 'skill_list', 'skill_read', 'skill_read_file', 'skill_write_file', 'skill_delete_file', 'skill_create', 'skill_import', 'skill_edit', 'skill_update', 'skill_delete', 'skill_propose'),
    supported('schedule', 'Schedules', 'Run this coworker’s routines while Rerun is open. Configure and test tasks in Routines.'),
    supported('scheduleManage', 'Manage routines', 'Let this coworker read, create, edit and remove its scheduled tasks. Running routines uses the separate Schedules permission.', 'schedule_list', 'schedule_get', 'schedule_create', 'schedule_update', 'schedule_edit', 'schedule_delete'),
    supported('trigger', 'Triggers', 'Manage URLs that start this coworker while Rerun is open on this Mac.', 'trigger_list', 'trigger_get', 'trigger_create', 'trigger_update', 'trigger_rotate_token', 'trigger_delete'),
    supported('delegate', 'Delegate tasks', 'Run isolated workers on separate tasks, with read-only public web access when granted.', 'delegate_tasks'),
    supported('callAgent', 'Call coworkers', 'Ask an allowed coworker to work in its own new chat, using its own model and permissions.', 'call_agent'),
    supported('browser', 'Use a browser', 'Read pages in this coworker’s isolated browser and ask you to take over. Requires Docker Desktop and Computer control.', 'browser_navigate', 'request_takeover'),
    pending('vision', 'Vision', 'Inspect images and screenshots.', 'Requires an image input path and a model with vision.'),
    supported('computer', 'Computer control', 'See and drive this coworker’s isolated screen. Requires Docker Desktop and permission for the app in front.', 'computer', 'computer_open_app'),
    supported('terminalLaunch', 'Terminal', 'Open and drive Terminal inside this coworker’s isolated Linux screen. Requires Computer control. Commands can access the guest’s files and browser profile, not Mac files.'),
    supported('filesLaunch', 'Files', 'Open and drive the file manager inside this coworker’s isolated Linux screen. Requires Computer control. This does not open Finder or publish files to the Mac.'),
    pending('notify', 'Send notifications', 'Deliver a coworker notification.', 'Requires a Mac notification destination and user permission.'),
    supported('services', 'Apps', 'Use tools from apps you connect in this coworker’s Apps panel. Installing an app does not enable this permission.'),
    pending('hub', 'Service catalog', 'Discover and configure Rerun services.', 'Requires an authenticated Rerun hub.'),
    pending('paidData', 'Paid data', 'Search external datasets.', 'Requires a configured provider and billing controls.'),
    supported('cardTable', 'Show table cards', 'Show a frozen snapshot of a saved database view in chat. Requires the matching private or shared database permission.', 'card_table'),
    supported('suggestService', 'Suggest apps', 'Suggest catalog apps in chat and wait for the setup card. This does not enable Apps or store a credential.', 'suggest_service'),
    supported('requestSecret', 'Request credentials', 'Ask for credentials in a masked form. Values are encrypted for this coworker and kept out of chat; storage does not grant permission to use them.', 'request_secret'),
    supported('self', 'Improve itself', 'Let this coworker refine its own instructions and how long its answers are over time.', 'soul_update', 'verbosity_set'),
    nested('self', 'selfInstruction', 'Edit own instructions', 'Let this coworker rewrite its own instructions — the identity at the top of its prompt — and have them take effect from the next message.', 'soul_update'),
    nested('self', 'toolInstall', 'Propose package installations', 'Propose exact npm package versions for your review. Approval runs package scripts only inside this coworker’s isolated computer; it does not install anything on your Mac.', 'tool_install'),
    nested('self', 'selfMcpRegister', 'Propose MCP servers', 'Let this coworker suggest tool connections for your review. Approval and tool access use separate permissions; proposing never installs packages or launches programs.', 'mcp_register'),
    nested('self', 'verbositySet', 'Change reply length', 'Let this coworker durably change how long its answers are, from minimal to detailed.', 'verbosity_set'),
    supported('mcp', 'Custom MCP servers', 'Use tools from this coworker’s configured HTTPS MCP servers. Configure connections in MCP servers.'),
    supported('localMcpStdio', 'Local MCP programs', 'Run explicitly configured programs as your Mac user. These programs can access your Mac files and network. Saving a connection does not enable this permission.'),
    supported('nativeWriteback', 'Review temporary file changes', 'Keep proposed text and Markdown changes from native Codex edits for your review. Each file requires approval before it changes this coworker’s Files.'),
    pending('foreman', 'Foreman', 'Build a team and work across coworkers.', 'Requires the board’s Foreman runtime and workspace authorization.'),
]

export const desktopCodexToolCatalog: DesktopToolCatalogEntry[] = [
    supported('workspaceRead', 'Include workspace files', 'Copy bounded, visible workspace text files into this coworker’s temporary folder for native commands or edits.'),
    supported('workspaceWrite', 'Edit temporary files', 'Use native Codex edits in this turn’s temporary folder. With Review temporary file changes enabled, changes wait for your review; otherwise they are discarded.', 'apply_patch'),
    supported('shell', 'Run shell commands', 'Run supported commands in a private temporary folder. Changes are discarded at the end of the turn. Include workspace files to read copies of this coworker’s text files.', 'exec_command'),
    supported('webSearch', 'Search the web', 'Use the Codex provider’s native web search.', 'web_search'),
    supported('codeMode', 'Code mode', 'Run JavaScript calculations in the bundled Codex host and call the Rerun tools granted to this coworker.', 'functions.exec'),
    pending('browser', 'Browser and computer', 'Use a browser or desktop from Codex.', 'Requires an isolated browser or desktop and its permissions.'),
    pending('images', 'Image generation and editing', 'Generate or edit an image in a Codex chat.', 'Requires a scoped image output store and preview.'),
    pending('subagents', 'Delegate to subagents', 'Start or continue child agents.', 'Requires scoped child runs, cancellation and activity history.'),
    pending('voice', 'Voice', 'Use the Codex voice input and output tools.', 'Requires a Mac microphone and playback flow.'),
    pending('connectors', 'External connectors', 'Connect external services and servers.', 'Requires configured accounts and scoped credentials.'),
]
