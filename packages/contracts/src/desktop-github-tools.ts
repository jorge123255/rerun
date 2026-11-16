import { desktopConnectorActionKind, desktopConnectorCodeCalls, desktopConnectorInnerCalls } from './desktop-connector-approvals.js'

// What a GitHub connector tool does to a repository: read it or change it. A coworker with a GitHub
// account attached can always read; changing a repository needs the "Change GitHub repositories"
// permission, which is off by default, and then asks the person first. A tool is recognised by
// its name alone, never by what a call carries, and a name that is not recognised as reading is
// treated as changing.

/** The permission that lets a coworker change a repository at all. Off by default. */
export const DESKTOP_GITHUB_WRITE_GRANT = 'githubWrite' as const
export const DESKTOP_GITHUB_WRITE_LABEL = 'Change GitHub repositories'

export type DesktopGithubToolAccess = 'read' | 'write'

/**
 * The one table. A tool reads when its first word is a reading verb ("get_file_contents",
 * "GITHUB_LIST_COMMITS") or when it is a GitHub noun followed by read, get or list ("issue_read",
 * "projects_list"), and no changing verb appears anywhere in its name ("get_or_create_label"
 * changes). Everything else changes.
 */
export const DESKTOP_GITHUB_TOOL_TABLE = {
    readVerbs: ['get', 'list', 'search', 'read', 'fetch', 'find', 'view', 'show', 'check', 'compare', 'download', 'count', 'describe', 'query', 'lookup', 'retrieve', 'export'],
    readSuffixes: ['read', 'get', 'list'],
    nouns: [
        'issue', 'issues', 'sub', 'pull', 'request', 'requests', 'pr', 'review', 'reviews', 'project', 'projects', 'action', 'actions', 'workflow', 'workflows',
        'label', 'labels', 'discussion', 'discussions', 'gist', 'gists', 'repository', 'repositories', 'repo', 'repos', 'release', 'releases', 'commit', 'commits',
        'branch', 'branches', 'tag', 'tags', 'notification', 'notifications', 'security', 'advisory', 'advisories', 'code', 'scanning', 'secret', 'dependabot', 'alert', 'alerts',
        'team', 'teams', 'user', 'users', 'org', 'orgs', 'organization', 'file', 'files', 'content', 'contents',
    ],
    writeVerbs: ['create', 'update', 'delete', 'remove', 'merge', 'push', 'write'],
    /** Merging, and deleting one of these, asks every time: no standing answer covers it. */
    alwaysAskDeleted: ['branch', 'branches', 'ref', 'refs', 'reference', 'references', 'file', 'files', 'content', 'contents', 'repository', 'repo'],
} as const

const READ_VERBS: ReadonlySet<string> = new Set(DESKTOP_GITHUB_TOOL_TABLE.readVerbs)
const READ_SUFFIXES: ReadonlySet<string> = new Set(DESKTOP_GITHUB_TOOL_TABLE.readSuffixes)
const NOUNS: ReadonlySet<string> = new Set(DESKTOP_GITHUB_TOOL_TABLE.nouns)
const WRITE_VERBS: ReadonlySet<string> = new Set(DESKTOP_GITHUB_TOOL_TABLE.writeVerbs)
const ALWAYS_ASK_DELETED: ReadonlySet<string> = new Set(DESKTOP_GITHUB_TOOL_TABLE.alwaysAskDeleted)
// GitHub's own MCP server and API hosts. A connector on one of these is GitHub whatever it is called.
const GITHUB_HOST = /(?:^|\.)(?:github\.com|githubcopilot\.com)$/i

function wordsOf(name: string): string[] {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
}

/** Where a tool comes from, as the bridge that offers it knows it. All optional: the name alone often says enough. */
export type DesktopGithubToolServer = { /** The connector's host, for an HTTP connector. */ host?: string; /** The connector's name on this Mac. */ name?: string; /** The tool's own name, without the connector's prefix. */ tool?: string }

/**
 * The words of what a GitHub tool does, or null for a tool that is not GitHub's. A tool is GitHub's
 * when its name says so ("github_create_branch" from a connector named github, Composio's
 * "GITHUB_CREATE_A_REFERENCE", with or without one connector prefix in front), or when the
 * connector it comes from is on a GitHub host or is named github.
 */
function githubAction(toolName: string, server?: DesktopGithubToolServer): string[] | null {
    const words = wordsOf(toolName)
    if (words[0] === 'github') return words.slice(words[1] === 'github' ? 2 : 1)
    // One connector prefix in front of a Composio name: "composio_GITHUB_CREATE_AN_ISSUE".
    if (words[1] === 'github' && /^[A-Za-z0-9-]+_GITHUB_[A-Z0-9_]+$/.test(toolName)) return words.slice(2)
    const named = wordsOf(server?.name ?? '')[0] === 'github'
    if (named || (server?.host && GITHUB_HOST.test(server.host))) return wordsOf(server?.tool ?? toolName)
    return null
}

function accessOf(action: readonly string[]): DesktopGithubToolAccess {
    if (!action.length || action.some(word => WRITE_VERBS.has(word))) return 'write'
    if (READ_VERBS.has(action[0]!)) return 'read'
    if (action.length > 1 && READ_SUFFIXES.has(action.at(-1)!) && action.slice(0, -1).every(word => NOUNS.has(word))) return 'read'
    return 'write'
}

const alwaysAsksAction = (action: readonly string[]) =>
    action.includes('merge') || ((action.includes('delete') || action.includes('remove')) && action.some(word => ALWAYS_ASK_DELETED.has(word)))

/** Whether a GitHub connector tool reads or changes a repository; null for a tool that is not GitHub's. */
export function desktopGithubToolAccess(toolName: string, server?: DesktopGithubToolServer): DesktopGithubToolAccess | null {
    const action = githubAction(toolName, server)
    return action ? accessOf(action) : null
}

/**
 * Whether a held call asks every time, whatever standing answer exists: merging a pull request, or
 * deleting a branch, a file or a repository. Read from the name the call is held under, which may
 * join several inner tools with "+".
 */
export function desktopGithubAlwaysAsks(heldTool: string): boolean {
    return heldTool.split('+').some(name => { const action = githubAction(name); return !!action && accessOf(action) === 'write' && alwaysAsksAction(action) })
}

export type DesktopGithubCall = {
    /** The name the call is held under and asked about: the changing GitHub tools, and any other inner tool that asks. */
    tool: string
    alwaysAsk: boolean
    /** What an "allow once" covers: the inner calls or the code alone, as for any connector call. */
    subject?: Record<string, unknown>
}

// A name the check can read back as GitHub's, for a connector that is GitHub's by its host only.
const heldName = (toolName: string, server?: DesktopGithubToolServer) => githubAction(toolName) ? toolName : `github_${server?.tool ?? toolName}`.slice(0, 200)

/**
 * The repository change a connector call would make, or null when it makes none (a read, or a tool
 * that is not GitHub's). Covers a GitHub tool called directly, GitHub tools run by name through a
 * tool that runs others (Composio's COMPOSIO_MULTI_EXECUTE_TOOL), and GitHub tools named in the
 * code of a remote sandbox call.
 */
export function desktopGithubCall(toolName: string, args: unknown, server?: DesktopGithubToolServer): DesktopGithubCall | null {
    const own = githubAction(toolName, server)
    if (own) {
        if (accessOf(own) === 'read') return null
        const tool = heldName(toolName, server)
        return { tool, alwaysAsk: alwaysAsksAction(own) }
    }
    const changes = (tool: string) => desktopGithubToolAccess(tool) === 'write'
    const held = (tools: readonly string[], subject: Record<string, unknown>): DesktopGithubCall | null => {
        if (!tools.some(changes)) return null
        // One card names everything in the call that asks, so the person answers once.
        const asking = [...new Set(tools.filter(tool => changes(tool) || (desktopGithubToolAccess(tool) === null && desktopConnectorActionKind(tool))))].sort()
        // The ones that ask every time come first, so cutting a long name never drops them.
        const ordered = [...asking.filter(desktopGithubAlwaysAsks), ...asking.filter(tool => !desktopGithubAlwaysAsks(tool))]
        let tool = ''
        for (const name of ordered) { const next = tool ? `${tool}+${name}` : name; if (next.length > 200) break; tool = next }
        return { tool: tool || ordered[0]!.slice(0, 200), alwaysAsk: asking.some(desktopGithubAlwaysAsks), subject }
    }
    const inner = desktopConnectorInnerCalls(toolName, args)
    if (inner.tools.length) return held(inner.tools, { tools: inner.entries })
    const code = desktopConnectorCodeCalls(toolName, args)
    if (code.tools.length) return held(code.tools, { code: code.code })
    return null
}

/** What the coworker is told when the permission is off. The call did not run. */
export const DESKTOP_GITHUB_WRITE_OFF_MESSAGE =
    `“${DESKTOP_GITHUB_WRITE_LABEL}” is off for this coworker, so this call did not run and nothing in the repository changed. Reading the repository still works. `
    + `Tell the person in one short sentence what you wanted to change, and that they can turn on ${DESKTOP_GITHUB_WRITE_LABEL} in this coworker's Tools settings. Do not try to make the change another way.`
