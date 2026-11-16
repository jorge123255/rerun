import { z } from 'zod'

// Connector actions a coworker asks the person about before it runs them on the Mac: deleting,
// sending to other people, sharing, posting, paying, and changing credentials. They are recognized
// by what the tool is called, never by what a call carries. The kinds and the recognition rules
// follow CopilotKit/OpenBot's docs/approvals.md (MIT).
// `repository` is a change to a GitHub repository (desktop-github-tools.ts): it is never read off a
// tool's name here, only set by the GitHub check, which runs before this one.
export const DESKTOP_CONNECTOR_ACTION_KINDS = ['delete', 'send', 'share', 'post', 'pay', 'credential', 'repository'] as const
export type DesktopConnectorActionKind = (typeof DESKTOP_CONNECTOR_ACTION_KINDS)[number]

const VERBS: Record<string, DesktopConnectorActionKind> = {
    delete: 'delete', trash: 'delete', destroy: 'delete', erase: 'delete', purge: 'delete', wipe: 'delete', discard: 'delete', remove: 'delete', archive: 'delete',
    send: 'send', reply: 'send', forward: 'send', respond: 'send', notify: 'send', broadcast: 'send', invite: 'send', comment: 'send',
    share: 'share', grant: 'share',
    publish: 'post', tweet: 'post', repost: 'post', post: 'post',
    pay: 'pay', charge: 'pay', refund: 'pay', transfer: 'pay', payout: 'pay', withdraw: 'pay', purchase: 'pay', buy: 'pay', checkout: 'pay', subscribe: 'pay', upgrade: 'pay', downgrade: 'pay',
}
// What a making verb makes decides its kind: a new message is sent, a new post is posted.
const MADE: Record<string, DesktopConnectorActionKind> = {
    message: 'send', reply: 'send', comment: 'send', email: 'send', invitation: 'send', invite: 'send',
    post: 'post', tweet: 'post', release: 'post',
    share: 'share', permission: 'share', permissions: 'share', collaborator: 'share', collaborators: 'share',
    payment: 'pay', charge: 'pay', refund: 'pay', transfer: 'pay', payout: 'pay', order: 'pay', subscription: 'pay', checkout: 'pay',
}
const MAKING = new Set(['create', 'add', 'new', 'insert', 'schedule', 'place', 'make'])
const CHANGING = new Set(['set', 'change', 'update', 'reset', 'rotate', 'regenerate', 'revoke', 'enable', 'disable', ...MAKING])
const CREDENTIAL = new Set(['password', 'passcode', 'passkey', 'credential', 'credentials', 'mfa', '2fa', 'totp', 'apikey', 'secret'])
// The first verb is the action. These end the search: what follows them only names what they act on.
const ORDINARY = new Set([
    'get', 'list', 'read', 'search', 'find', 'fetch', 'query', 'lookup', 'view', 'show', 'check', 'count', 'describe', 'retrieve', 'export', 'download',
    'edit', 'mark', 'cancel', 'unarchive', 'restore', 'draft', 'save', 'label', 'move', 'copy', 'rename', 'upload', 'open', 'close', 'start', 'stop', 'run',
    'like', 'unlike', 'bookmark', 'star', 'follow', 'unfollow', 'pin', 'unpin', 'mute', 'watch', 'unsend', 'unshare', 'unpublish', 'unsubscribe',
])

function wordsOf(name: string): string[] {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
}

/**
 * The kind of action a connector tool performs, or null for an ordinary read or change.
 * `destructive` is the tool's own MCP `destructiveHint`: such a tool asks as deleting does,
 * whatever it is called.
 */
export function desktopConnectorActionKind(toolName: string, destructive = false): DesktopConnectorActionKind | null {
    const words = wordsOf(toolName)
    for (let index = 0; index < words.length; index++) {
        const word = words[index]!
        const rest = words.slice(index + 1)
        if (CHANGING.has(word) && rest.some(next => CREDENTIAL.has(next))) return 'credential'
        if (CHANGING.has(word) && rest.join('').includes('apikey')) return 'credential'
        if (MAKING.has(word)) {
            // A draft is made for the person to look at; nothing leaves until it is sent.
            if (rest.includes('draft')) break
            const made = rest.map(next => MADE[next]).find(Boolean)
            if (made) return made
            break
        }
        // Moving something to the trash is deleting it, whatever the verb.
        if (word === 'move' && rest.includes('trash')) return 'delete'
        if (ORDINARY.has(word) || CHANGING.has(word)) break
        // The web's POST method is not posting: STRIPE_POST_V1_PLANS reads a request path.
        if (word === 'post' && /^(v\d+|api|request)$/.test(rest[0] ?? '')) break
        const kind = VERBS[word]
        if (kind) return kind
    }
    return destructive ? 'delete' : null
}

// Some connectors offer one tool that runs other tools named in its arguments (Composio Connect's
// COMPOSIO_MULTI_EXECUTE_TOOL). The action is then what those inner tools do, so they are read out
// of the arguments and the call is held under their names.
const RUNS_OTHER_TOOLS = /(?:^|_)(?:MULTI_)?EXECUTE_TOOLS?$/i
const INNER_TOOL_KEY = /^(?:tool_?slug|tool_?name|tool|slug|action|name)$/i
const INNER_TOOL = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/

function innerTools(value: unknown, depth = 0, found: string[] = [], entries: unknown[] = []): string[] {
    if (depth > 6 || found.length >= 60 || !value || typeof value !== 'object') return found
    for (const [key, child] of Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value)) {
        if (typeof child === 'string') {
            if (!INNER_TOOL_KEY.test(key) || !INNER_TOOL.test(child)) continue
            if (!found.includes(child)) found.push(child)
            // The object naming the tool is the call itself: the tool and what it is given.
            if (!entries.includes(value)) entries.push(value)
        } else innerTools(child, depth + 1, found, entries)
    }
    return found
}

/**
 * The tools a call runs by name, for a connector tool whose job is to run others (Composio's
 * COMPOSIO_MULTI_EXECUTE_TOOL). Empty for any other tool. `entries` are the inner calls themselves.
 */
export function desktopConnectorInnerCalls(toolName: string, args: unknown): { tools: string[]; entries: unknown[] } {
    const entries: unknown[] = []
    if (!RUNS_OTHER_TOOLS.test(toolName)) return { tools: [], entries }
    return { tools: innerTools(args, 0, [], entries), entries }
}

const RUNS_CODE = /(?:^|_)REMOTE_(?:WORKBENCH|BASH_TOOL)$/i
// A sandbox call's own notes ("current_step": "VERIFYING_SEND") are labels, not code: they are not read for tool names.
const NOTE_KEY = /^(?:thought|current_step(?:_metric)?|session_id|step|reason|description)$/i
function strings(value: unknown, depth = 0, found: string[] = []): string[] {
    if (depth > 4 || found.length >= 40) return found
    if (typeof value === 'string') found.push(value.slice(0, 200_000))
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { if (Array.isArray(value) || !NOTE_KEY.test(key)) strings(child, depth + 1, found) }
    return found
}

/**
 * The tool names a remote sandbox call's code mentions (Composio's REMOTE_WORKBENCH and
 * REMOTE_BASH_TOOL run code that can run other tools by name), with the code itself. Empty for
 * any other tool.
 */
export function desktopConnectorCodeCalls(toolName: string, args: unknown): { tools: string[]; code: string[] } {
    if (!RUNS_CODE.test(toolName)) return { tools: [], code: [] }
    const TOOL_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g
    const code = strings(args).filter(text => (text.match(TOOL_NAME) ?? []).length > 0)
    return { tools: [...new Set(code.flatMap(text => text.match(TOOL_NAME) ?? []))].slice(0, 60), code }
}

function namedActions(value: unknown, depth = 0, found: string[] = []): string[] {
    if (depth > 4 || found.length >= 60 || !value || typeof value !== 'object') return found
    for (const [key, child] of Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value)) {
        if (typeof child === 'string') { if (/^(?:action|operation)$/i.test(key) && /^[a-z][a-z_ -]{0,40}$/i.test(child)) found.push(child) }
        else namedActions(child, depth + 1, found)
    }
    return found
}

/**
 * What a connector call is held as: the kind of action and the name it is asked about, or null
 * for a call that needs no answer. A tool that runs other tools is held under the inner tools
 * that ask, so the card names what will really happen and an "always allow" covers only that.
 */
// `subject` is what the person is asked about and what an "allow once" covers: the inner calls or the code alone.
// A wrapper's own notes (its "thought", its step counters) change from one attempt to the next and are left out.
export function desktopConnectorCall(toolName: string, destructive: boolean, args: unknown): { kind: DesktopConnectorActionKind; tool: string; subject?: Record<string, unknown> } | null {
    const own = desktopConnectorActionKind(toolName, destructive)
    // A tool marked destructive only because one of its actions is (Composio's MANAGE_CONNECTIONS lists, adds and
    // removes) is held for the action a call names: listing or adding asks nothing, removing asks as deleting does.
    if (own && !desktopConnectorActionKind(toolName) && wordsOf(toolName).includes('manage')) {
        const named = namedActions(args)
        if (named.length && !named.some(action => desktopConnectorActionKind(action))) return null
    }
    // A tool that runs other tools is marked destructive because some of them are. The tools a call names decide:
    // the mark alone holds it only when none can be read out of the call.
    const hinted = !!own && !desktopConnectorActionKind(toolName)
    // A remote sandbox runs code the coworker wrote, and that code can run other tools by name. It is held
    // under the asking tools its code names; code that names none runs like any other read.
    if (RUNS_CODE.test(toolName) && (!own || hinted)) {
        const TOOL_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g
        const code = strings(args).filter(text => (text.match(TOOL_NAME) ?? []).some(tool => desktopConnectorActionKind(tool)))
        const named = [...new Set(code.flatMap(text => text.match(TOOL_NAME) ?? []))].slice(0, 60)
        const asking = named.flatMap(tool => { const kind = desktopConnectorActionKind(tool); return kind ? [{ tool, kind }] : [] })
        return asking.length ? { kind: asking[0]!.kind, tool: asking.map(item => item.tool).sort().join('+').slice(0, 200), subject: { code } } : null
    }
    if (own && !(hinted && RUNS_OTHER_TOOLS.test(toolName))) return { kind: own, tool: toolName }
    if (!RUNS_OTHER_TOOLS.test(toolName)) return null
    const entries: unknown[] = []
    const inner = innerTools(args, 0, [], entries)
    if (own && !inner.length) return { kind: own, tool: toolName }
    const asking = inner.flatMap(tool => { const kind = desktopConnectorActionKind(tool); return kind ? [{ tool, kind }] : [] })
    if (!asking.length) return null
    return { kind: asking[0]!.kind, tool: asking.map(item => item.tool).sort().join('+').slice(0, 200), subject: { tools: entries } }
}

/**
 * What a held call's card shows, kept as the request's preview: each inner call with its fields in
 * the order given, or the code a sandbox would run. Older requests kept the raw arguments as text.
 */
export const desktopConnectorPreviewSchema = z.object({
    v: z.literal(1),
    items: z.array(z.object({
        tool: z.string().max(200).optional(),
        fields: z.array(z.tuple([z.string().max(80), z.string().max(1400)])).max(14).optional(),
        code: z.string().max(2000).optional(),
    }).strict()).max(6),
    // A press in the coworker's browser (desktop-browser-approvals.ts): the control's own label and the page's host.
    press: z.object({ label: z.string().max(80), host: z.string().max(260), via: z.enum(['click', 'key']) }).strict().optional(),
}).strict()
export type DesktopConnectorPreview = z.infer<typeof desktopConnectorPreviewSchema>

export const desktopConnectorApprovalDecisionSchema = z.enum(['once', 'conversation', 'always', 'deny'])
export type DesktopConnectorApprovalDecision = z.infer<typeof desktopConnectorApprovalDecisionSchema>

// `press` is a browser button held only because Extra vigilant is on.
const kind = z.enum([...DESKTOP_CONNECTOR_ACTION_KINDS, 'press'])
export const desktopConnectorApprovalViewSchema = z.object({
    pending: z.array(z.object({ id: z.string().uuid(), tool: z.string().max(200), kind, preview: z.string().max(4000), createdAt: z.string() }).strict()).max(20),
    rules: z.array(z.object({ id: z.string().uuid(), tool: z.string().max(200), scope: z.enum(['conversation', 'always']) }).strict()).max(200),
}).strict()
export type DesktopConnectorApprovalView = z.infer<typeof desktopConnectorApprovalViewSchema>

export const desktopConnectorApprovalActionSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('decide'), id: z.string().uuid(), decision: desktopConnectorApprovalDecisionSchema }).strict(),
    z.object({ action: z.literal('forget'), ruleId: z.string().uuid() }).strict(),
])
export type DesktopConnectorApprovalAction = z.infer<typeof desktopConnectorApprovalActionSchema>
export const desktopConnectorApprovalResultSchema = z.object({ tool: z.string().max(200), kind, decision: desktopConnectorApprovalDecisionSchema }).strict()
