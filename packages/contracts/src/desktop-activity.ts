import { z } from 'zod'
import { DESKTOP_CONNECTOR_ACTION_KINDS, desktopConnectorActionKind, type DesktopConnectorActionKind } from './desktop-connector-approvals.js'
import { redactHistoricalText } from './desktop-redact.js'
import { desktopRerunToolCatalog } from './desktop-tool-grants.js'

// The Mac's activity trail: one record for every action a coworker took, written where the action
// was decided. The idea of one trail that says who did what, how it ended and which rule decided
// it, and of saying each row in a person's words rather than as a stored tool name, follows
// CopilotKit/OpenBot's shared/audit-words.ts and shared/audit-filters.ts (MIT). The storage, the
// record shape and every phrase here are Rerun's own.

const ACTION_DECISIONS = [
    'allowed-by-permission', 'allowed-once-by-person', 'declined-by-person', 'asked-person',
    'refused-no-permission', 'refused-policy', 'failed', 'completed',
] as const
export const DESKTOP_ACTIVITY_OUTCOMES = [...ACTION_DECISIONS, 'started', 'cancelled'] as const
export type DesktopActivityOutcome = (typeof DESKTOP_ACTIVITY_OUTCOMES)[number]

export const DESKTOP_ACTIVITY_SOURCES = ['chat', 'routine', 'trigger', 'delegated', 'call'] as const
export type DesktopActivitySource = (typeof DESKTOP_ACTIVITY_SOURCES)[number]

export const DESKTOP_ACTIVITY_RETENTION_DAYS = 90
export const DESKTOP_ACTIVITY_MAX_RECORDS = 50_000
export const DESKTOP_ACTIVITY_SUMMARY_LIMIT = 200
export const DESKTOP_ACTIVITY_PAGE = 100

const kind = z.enum(DESKTOP_CONNECTOR_ACTION_KINDS)

export const desktopActivityRecordSchema = z.object({
    id: z.string().min(1).max(64),
    at: z.string().min(1).max(40),
    agentId: z.string().min(1).max(200),
    sessionId: z.string().max(200).nullable(),
    runId: z.string().max(200).nullable(),
    source: z.enum(DESKTOP_ACTIVITY_SOURCES),
    sourceSlug: z.string().max(200).nullable(),
    tool: z.string().min(1).max(200),
    /** The tool a call ran by name, when a connector tool runs others (Composio's multi-execute). */
    action: z.string().max(200).nullable(),
    app: z.string().max(80).nullable(),
    kind: kind.nullable(),
    outcome: z.enum(DESKTOP_ACTIVITY_OUTCOMES),
    rule: z.string().max(120).nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    summary: z.string().max(DESKTOP_ACTIVITY_SUMMARY_LIMIT).nullable(),
})
export type DesktopActivityRecord = z.infer<typeof desktopActivityRecordSchema>

/**
 * What a decision point says about the call in progress. The app's connector bridges return one
 * beside a tool result; the engine's own grant check writes one directly. A browser-action
 * approval fits the same three fields: how it ended, the rule that decided, and the kind.
 */
export const desktopActivityDecisionSchema = z.object({
    outcome: z.enum(ACTION_DECISIONS).optional(),
    rule: z.string().max(120).optional(),
    kind: kind.optional(),
    app: z.string().max(80).optional(),
    action: z.string().max(200).optional(),
}).strict()
export type DesktopActivityDecision = z.infer<typeof desktopActivityDecisionSchema>

export const desktopActivityPageSchema = z.object({
    records: z.array(desktopActivityRecordSchema.extend({ seq: z.number().int() })).max(500),
    next: z.number().int().nullable(),
    total: z.number().int().nonnegative(),
    dropped: z.number().int().nonnegative(),
})
export type DesktopActivityPage = z.infer<typeof desktopActivityPageSchema>

export type DesktopActivityFilters = {
    agentIds?: string[]
    /** Everything except these coworkers: how the view asks for deleted coworkers' rows. */
    excludeAgentIds?: string[]
    outcomes?: DesktopActivityOutcome[]
    risky?: boolean
    sources?: DesktopActivitySource[]
    from?: string
    to?: string
    search?: string
}

// ---- What is kept of a call's input ----

const CREDENTIAL_TOOL = /secret|password|passcode|passkey|credential|vault|token|api[_-]?key|sign[_-]?in|log[_-]?in|oauth|2fa|mfa|totp/i
/** A tool whose input is a credential or a sign-in. Nothing of what it was given is kept. */
export function desktopActivityCredentialTool(tool: string, actionKind?: DesktopConnectorActionKind | null): boolean {
    return actionKind === 'credential' || CREDENTIAL_TOOL.test(tool) || desktopConnectorActionKind(tool) === 'credential'
}

const SECRET_KEY = /password|passcode|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key|session/i
// Message bodies, file contents and code: the trail says how long they were, never what they said.
const LONG_KEY = /^(?:body|message|text|content|contents|html_?body|html|markdown|description|comment|note|data|file|code|script|patch|diff|prompt|instructions?|old_?(?:text|string)|new_?(?:text|string)|expected_?text|replacement|value|values|rows|records)$/i
const VALUE = 80

/**
 * A short, redacted line saying what a call was given: field names with short values, the length
 * of anything long, and nothing at all for a credential tool. Never more than 200 characters.
 */
export function desktopActivityInputSummary(tool: string, input: unknown, actionKind?: DesktopConnectorActionKind | null): string | null {
    if (desktopActivityCredentialTool(tool, actionKind)) return null
    if (input === null || input === undefined) return null
    let text: string
    if (typeof input === 'string') text = `[${input.length} characters]`
    else if (typeof input !== 'object') text = redactHistoricalText(String(input), VALUE)
    else if (Array.isArray(input)) text = `[${input.length} items]`
    else {
        const parts: string[] = []
        for (const [key, value] of Object.entries(input).slice(0, 12)) {
            if (value === null || value === undefined || value === '') continue
            const name = key.slice(0, 40)
            if (SECRET_KEY.test(key)) continue
            if (typeof value === 'string') {
                const flat = value.replace(/\s+/g, ' ').trim()
                // Each value is redacted by itself, so a header-shaped value cannot swallow the fields after it.
                parts.push(LONG_KEY.test(key) || flat.length > VALUE * 3 ? `${name}: [${value.length} characters]` : `${name}: ${redactHistoricalText(flat, VALUE)}`)
            } else if (typeof value === 'number' || typeof value === 'boolean') parts.push(`${name}: ${value}`)
            else if (Array.isArray(value)) parts.push(`${name}: [${value.length} items]`)
            else parts.push(`${name}: {…}`)
        }
        text = parts.join(', ')
    }
    // Already redacted above; the cut comes last, so it cannot leave part of a secret behind.
    return text ? (text.length > DESKTOP_ACTIVITY_SUMMARY_LIMIT ? `${text.slice(0, DESKTOP_ACTIVITY_SUMMARY_LIMIT - 1)}…` : text) : null
}

// ---- Words ----

function wordsOf(name: string): string[] {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/** The app a connector tool belongs to, read from the prefix its name carries: GMAIL_SEND_EMAIL is Gmail. */
export function desktopActivityAppOf(tool: string): string | null {
    const first = tool.split(/[_.-]/)[0] ?? ''
    if (!first || first === tool || first.length > 40) return null
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()
}

/** Rerun's own tools: what was asked for, then what was done. */
const TOOLS: Readonly<Record<string, readonly [string, string]>> = {
    fs_read: ['read a file', 'read a file'], fs_list: ['list files', 'listed files'], fs_search: ['search files', 'searched files'],
    fs_write: ['save a file', 'saved a file'], fs_edit: ['edit a file', 'edited a file'],
    shared_read: ['read a shared file', 'read a shared file'], shared_list: ['list shared files', 'listed shared files'], shared_search: ['search shared files', 'searched shared files'],
    shared_write: ['save a shared file', 'saved a shared file'], shared_edit: ['edit a shared file', 'edited a shared file'],
    memory_recall: ['search memories', 'searched memories'], memory_write: ['save a memory', 'saved a memory'], memory_delete: ['delete a memory', 'deleted a memory'],
    ask_user: ['ask you a question', 'asked you a question'], request_approval: ['ask for your approval', 'asked for your approval'],
    request_secret: ['ask you for a secret', 'asked you for a secret'], request_mcp_sign_in: ['ask you to sign in to an app', 'asked you to sign in to an app'],
    web_fetch: ['read a web page', 'read a web page'], web_search: ['search the web', 'searched the web'], download: ['download a file', 'downloaded a file'],
    shell_exec: ['run a command', 'ran a command'], shell_inspect: ['check a command', 'checked a command'],
    native_subagent: ['run a sub-agent', 'ran a sub-agent'],
    call_agent: ['ask another coworker', 'asked another coworker'], delegate: ['hand work to a helper', 'handed work to a helper'],
    notify: ['send you a notification', 'sent you a notification'], card_file: ['show a file', 'showed a file'], card_table: ['show a table', 'showed a table'],
    db_query: ['read its database', 'read its database'], db_execute: ['change its database', 'changed its database'],
    shared_db_query: ['read the shared database', 'read the shared database'], shared_db_execute: ['change the shared database', 'changed the shared database'],
    skill_read: ['read a skill', 'read a skill'], skill_propose: ['propose a skill', 'proposed a skill'],
    brain_read: ['read the Brain', 'read the Brain'], brain_search: ['search the Brain', 'searched the Brain'], brain_propose: ['propose a Brain change', 'proposed a Brain change'],
    computer_open_app: ['open an app on its computer', 'opened an app on its computer'], mcp_register: ['propose a connection', 'proposed a connection'],
}

const PAST: Readonly<Record<string, string>> = {
    send: 'sent', reply: 'replied to', forward: 'forwarded', delete: 'deleted', remove: 'removed', trash: 'trashed', archive: 'archived',
    create: 'created', add: 'added', insert: 'inserted', update: 'updated', edit: 'edited', set: 'set', change: 'changed', write: 'wrote', save: 'saved',
    get: 'read', read: 'read', fetch: 'read', list: 'listed', search: 'searched', find: 'looked up', query: 'queried', lookup: 'looked up', view: 'viewed', check: 'checked', count: 'counted',
    share: 'shared', post: 'posted', publish: 'published', pay: 'paid', charge: 'charged', refund: 'refunded', transfer: 'transferred', invite: 'invited',
    move: 'moved', copy: 'copied', rename: 'renamed', upload: 'uploaded', download: 'downloaded', export: 'exported', run: 'ran', execute: 'ran', open: 'opened', close: 'closed',
    draft: 'drafted', schedule: 'scheduled', cancel: 'cancelled', start: 'started', stop: 'stopped', label: 'labelled', mark: 'marked', comment: 'commented on', navigate: 'opened', click: 'clicked', type: 'typed',
}

/** A tool in words: what was asked for ("send email"), and what was done ("sent email"). */
export function desktopActivityActionWords(tool: string, app?: string | null): { ask: string; did: string } {
    const own = Object.hasOwn(TOOLS, tool) ? TOOLS[tool] : undefined
    if (own) return { ask: own[0], did: own[1] }
    let words = wordsOf(tool)
    if (app && words.length > 1 && words[0] === app.toLowerCase()) words = words.slice(1)
    const verb = words[0]
    if (!verb) return { ask: 'use a tool', did: 'used a tool' }
    const rest = words.slice(1).join(' ')
    const past = Object.hasOwn(PAST, verb) ? PAST[verb] : undefined
    if (past) return { ask: [verb, rest].filter(Boolean).join(' '), did: [past, rest].filter(Boolean).join(' ') }
    return { ask: `use ${words.join(' ')}`, did: `used ${words.join(' ')}` }
}

const GRANT_LABELS = new Map(desktopRerunToolCatalog.map(entry => [entry.id, entry.label]))
const TOOL_GRANTS = new Map(desktopRerunToolCatalog.flatMap(entry => entry.tools.map(tool => [tool, entry.id] as const)))

/** The permission that offers a Rerun tool, as its rule: `permission:sharedFilesWrite`. */
export function desktopActivityPermissionRuleOf(tool: string): string | null {
    const id = TOOL_GRANTS.get(tool)
    return id ? `permission:${id}` : null
}

const ASK_FIRST: Readonly<Record<DesktopConnectorActionKind, string>> = {
    delete: 'deleting', send: 'sending to other people', share: 'sharing with other people', post: 'posting or publishing', pay: 'paying or moving money', credential: 'changing a credential', repository: 'changing a GitHub repository',
}
const POLICIES: Readonly<Record<string, string>> = {
    'too-many-waiting': 'too many actions were already waiting for your answer',
    'delegated-scope': 'a helper may only use the tools it was handed',
    stopped: 'the run was stopped',
}

/** The permission behind a rule, by the name its switch carries in Tools settings. */
function permissionLabel(rule: string | null): string | null {
    if (!rule?.startsWith('permission:')) return null
    const id = rule.slice('permission:'.length)
    if (id === 'claudeSubagents') return 'Use Claude sub-agents'
    return GRANT_LABELS.get(id) ?? (id === 'mcp' ? 'MCP servers' : null)
}

/** The rule that decided a row, in words: the permission, the "Ask first" kind, or the policy. */
export function desktopActivityRuleWords(rule: string | null): string {
    if (!rule) return ''
    const [family, ...tail] = rule.split(':')
    const name = tail.join(':')
    if (family === 'permission') return `Permission: ${permissionLabel(rule) ?? wordsOf(name).join(' ')}`
    if (family === 'ask-first') return `Ask first: ${Object.hasOwn(ASK_FIRST, name) ? ASK_FIRST[name as DesktopConnectorActionKind] : wordsOf(name).join(' ')}`
    if (family === 'standing-answer') return name === 'always' ? 'Your standing answer: always allow' : 'Your standing answer: allow in this conversation'
    if (family === 'policy') return `Policy: ${Object.hasOwn(POLICIES, name) ? POLICIES[name] : wordsOf(name).join(' ')}`
    if (rule === 'provider') return 'The AI provider’s own tool, outside Rerun’s permissions'
    return wordsOf(rule).join(' ')
}

export const DESKTOP_ACTIVITY_OUTCOME_WORDS: Readonly<Record<DesktopActivityOutcome, string>> = {
    'allowed-by-permission': 'Allowed by a permission',
    'allowed-once-by-person': 'Allowed once by you',
    'declined-by-person': 'Declined by you',
    'asked-person': 'Waiting for your answer',
    'refused-no-permission': 'Refused: permission off',
    'refused-policy': 'Refused by a policy',
    failed: 'Failed',
    completed: 'Done',
    started: 'Started',
    cancelled: 'Stopped',
}

export const DESKTOP_ACTIVITY_SOURCE_WORDS: Readonly<Record<DesktopActivitySource, string>> = {
    chat: 'Conversation', routine: 'Routine', trigger: 'Trigger', delegated: 'Helper', call: 'Asked by a coworker',
}

export const DESKTOP_ACTIVITY_DELETED_COWORKER = 'Deleted coworker'

type Worded = Pick<DesktopActivityRecord, 'tool' | 'action' | 'app' | 'kind' | 'outcome' | 'rule'>

/**
 * One row as a sentence: "Scout sent email with Gmail: allowed once by you", "Ledger was refused:
 * Edit shared files is off". An action that did not run is never said as done.
 */
export function desktopActivitySentence(coworker: string, record: Worded): string {
    const { ask, did } = desktopActivityActionWords(record.action ?? record.tool, record.app)
    const using = record.app ? ` with ${record.app}` : ''
    const permission = permissionLabel(record.rule)
    switch (record.outcome) {
        case 'refused-no-permission': return `${coworker} was refused: ${permission ?? 'the permission'} is off`
        case 'refused-policy': {
            const policy = record.rule?.startsWith('policy:') ? record.rule.slice('policy:'.length) : ''
            return `${coworker} was refused: ${Object.hasOwn(POLICIES, policy) ? POLICIES[policy] : 'a Rerun policy does not allow it'}`
        }
        case 'declined-by-person': return `${coworker} asked to ${ask}${using}: declined by you`
        case 'asked-person': return `${coworker} asked to ${ask}${using}: waiting for your answer`
        case 'failed': return `${coworker} tried to ${ask}${using}: it failed`
        case 'allowed-once-by-person': return `${coworker} ${did}${using}: allowed once by you`
        case 'allowed-by-permission':
            if (record.rule === 'standing-answer:always') return `${coworker} ${did}${using}: always allowed by you`
            if (record.rule === 'standing-answer:conversation') return `${coworker} ${did}${using}: allowed by you for this conversation`
            return `${coworker} ${did}${using}: allowed by ${permission ?? 'a permission'}`
        case 'started': return `${coworker} asked to ${ask}`
        case 'cancelled': return `${coworker} stopped the action: ${ask}`
        case 'completed': return `${coworker} ${did}${using}: done`
    }
}

// ---- Export ----

function cell(value: string | number | null): string {
    if (value === null) return ''
    let text = String(value)
    // A spreadsheet runs a cell that starts like a formula. A leading quote keeps it text.
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export const DESKTOP_ACTIVITY_CSV_COLUMNS = ['time', 'coworker', 'coworker_id', 'what', 'outcome', 'rule', 'tool', 'action', 'app', 'kind', 'source', 'routine_or_trigger', 'conversation_id', 'run_id', 'duration_ms', 'input_summary'] as const

/** The rows of the current filter as CSV: the same redacted fields the view shows, stored names included. */
export function desktopActivityCsv(rows: readonly (DesktopActivityRecord & { coworker: string })[]): string {
    const lines = [DESKTOP_ACTIVITY_CSV_COLUMNS.join(',')]
    for (const row of rows) lines.push([
        row.at, row.coworker, row.agentId, desktopActivitySentence(row.coworker, row), DESKTOP_ACTIVITY_OUTCOME_WORDS[row.outcome], desktopActivityRuleWords(row.rule),
        row.tool, row.action, row.app, row.kind, row.source, row.sourceSlug, row.sessionId, row.runId, row.durationMs, row.summary,
    ].map(cell).join(','))
    return `${lines.join('\r\n')}\r\n`
}
