import { describe, expect, it } from 'vitest'
import {
    DESKTOP_ACTIVITY_CSV_COLUMNS, desktopActivityActionWords, desktopActivityAppOf, desktopActivityCredentialTool, desktopActivityCsv, desktopActivityDecisionSchema,
    desktopActivityInputSummary, desktopActivityPermissionRuleOf, desktopActivityRuleWords, desktopActivitySentence, type DesktopActivityRecord,
} from '@rerun/contracts'

const record = (overrides: Partial<DesktopActivityRecord> = {}): DesktopActivityRecord => ({
    id: 'r1', at: '2026-11-16T09:00:00.000Z', agentId: 'scout', sessionId: 's1', runId: 'run1', source: 'chat', sourceSlug: null, tool: 'GMAIL_SEND_EMAIL', action: null, app: 'Gmail', kind: 'send',
    outcome: 'allowed-once-by-person', rule: 'ask-first:send', durationMs: 420, summary: 'to: pat@example.test', ...overrides,
})

describe('a row in plain words', () => {
    it('says what was done and how it was allowed', () => {
        expect(desktopActivitySentence('Scout', record())).toBe('Scout sent email with Gmail: allowed once by you')
        expect(desktopActivitySentence('Scout', record({ outcome: 'allowed-by-permission', rule: 'standing-answer:always' }))).toBe('Scout sent email with Gmail: always allowed by you')
        expect(desktopActivitySentence('Scout', record({ outcome: 'allowed-by-permission', rule: 'standing-answer:conversation' }))).toBe('Scout sent email with Gmail: allowed by you for this conversation')
        expect(desktopActivitySentence('Ledger', record({ tool: 'shared_edit', app: null, kind: null, outcome: 'allowed-by-permission', rule: 'permission:sharedFilesWrite' }))).toBe('Ledger edited a shared file: allowed by Edit shared files')
        expect(desktopActivitySentence('Ledger', record({ tool: 'helper_tool', app: null, kind: null, outcome: 'completed', rule: null }))).toBe('Ledger used helper tool: done')
    })

    it('never says an action that did not run as done', () => {
        expect(desktopActivitySentence('Ledger', record({ tool: 'shared_edit', app: null, kind: null, outcome: 'refused-no-permission', rule: 'permission:sharedFilesWrite' }))).toBe('Ledger was refused: Edit shared files is off')
        expect(desktopActivitySentence('Scout', record({ outcome: 'declined-by-person' }))).toBe('Scout asked to send email with Gmail: declined by you')
        expect(desktopActivitySentence('Scout', record({ outcome: 'asked-person' }))).toBe('Scout asked to send email with Gmail: waiting for your answer')
        expect(desktopActivitySentence('Scout', record({ outcome: 'failed' }))).toBe('Scout tried to send email with Gmail: it failed')
        expect(desktopActivitySentence('Scout', record({ outcome: 'refused-policy', rule: 'policy:too-many-waiting' }))).toBe('Scout was refused: too many actions were already waiting for your answer')
        expect(desktopActivitySentence('Deleted coworker', record({ outcome: 'refused-no-permission', rule: null }))).toBe('Deleted coworker was refused: the permission is off')
    })

    it('reads the inner tool a connector ran, and names rules as their switches', () => {
        expect(desktopActivitySentence('Scout', record({ tool: 'COMPOSIO_MULTI_EXECUTE_TOOL', action: 'SLACK_DELETE_MESSAGE', app: 'Slack', kind: 'delete' }))).toBe('Scout deleted message with Slack: allowed once by you')
        expect(desktopActivityActionWords('driveListFiles', 'Drive')).toEqual({ ask: 'list files', did: 'listed files' })
        expect(desktopActivityAppOf('GMAIL_SEND_EMAIL')).toBe('Gmail')
        expect(desktopActivityAppOf('fetch')).toBeNull()
        expect(desktopActivityRuleWords('permission:sharedFilesWrite')).toBe('Permission: Edit shared files')
        expect(desktopActivityRuleWords('ask-first:send')).toBe('Ask first: sending to other people')
        expect(desktopActivityRuleWords('standing-answer:always')).toBe('Your standing answer: always allow')
        expect(desktopActivityRuleWords('provider')).toContain('outside Rerun’s permissions')
        expect(desktopActivityRuleWords(null)).toBe('')
        expect(desktopActivityPermissionRuleOf('fs_write')).toBe('permission:privateFileWrite')
        expect(desktopActivityPermissionRuleOf('GMAIL_SEND_EMAIL')).toBeNull()
    })
})

describe('the input summary', () => {
    it('is capped at 200 characters and redacted value by value', () => {
        const summary = desktopActivityInputSummary('http_request', { url: 'https://user:hunter2@example.test/x', header: 'Authorization: Bearer abcdefghijklmnop', after: 'still here', big: 'z'.repeat(300), list: [1, 2, 3], nested: { a: 1 }, on: true, n: 7 })!
        expect(summary).toBe('url: https://[redacted]@example.test/x, header: Authorization: [redacted], after: still here, big: [300 characters], list: [3 items], nested: {…}, on: true, n: 7')
        const long = desktopActivityInputSummary('search', Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`field${index}`, 'v'.repeat(60)])))!
        expect(long).toHaveLength(200)
        expect(long.endsWith('…')).toBe(true)
    })

    it('keeps no message body, file content, token or password field', () => {
        const summary = desktopActivityInputSummary('gmail_send_email', { to: 'pat@example.test', subject: 'Hi', body: 'private words', content: 'file text', password: 'hunter2', access_token: 'sk-abcdefghijklmnopqrstuv', note: 'sk-abcdefghijklmnopqrstuv' })!
        expect(summary).toBe('to: pat@example.test, subject: Hi, body: [13 characters], content: [9 characters], note: [25 characters]')
        expect(desktopActivityInputSummary('run', 'echo secret')).toBe('[11 characters]')
        expect(desktopActivityInputSummary('run', {})).toBeNull()
        expect(desktopActivityInputSummary('run', undefined)).toBeNull()
    })

    it('stores nothing for a credential tool', () => {
        for (const tool of ['request_secret', 'request_mcp_sign_in', 'vault_fill', 'okta_reset_password', 'set_api_key', 'github_create_token']) {
            expect(desktopActivityCredentialTool(tool), tool).toBe(true)
            expect(desktopActivityInputSummary(tool, { value: 'hunter2', name: 'visible' }), tool).toBeNull()
        }
        expect(desktopActivityInputSummary('anything', { name: 'x' }, 'credential')).toBeNull()
        expect(desktopActivityCredentialTool('fs_read')).toBe(false)
    })
})

describe('CSV export', () => {
    it('escapes quotes, commas and line breaks, and keeps a formula from running', () => {
        const csv = desktopActivityCsv([
            { ...record({ summary: 'subject: "Q3, final"\nline two', sourceSlug: '=HYPERLINK("https://evil.test")', durationMs: null }), coworker: 'Scout, "the" finder' },
            { ...record({ id: 'r2', tool: '+cmd', app: null, kind: null, outcome: 'failed', rule: null, summary: '@SUM(A1)', sessionId: null }), coworker: '-Ledger' },
        ])
        const lines = csv.split('\r\n')
        expect(lines[0]).toBe(DESKTOP_ACTIVITY_CSV_COLUMNS.join(','))
        expect(csv.endsWith('\r\n')).toBe(true)
        expect(csv).toContain('"Scout, ""the"" finder"')
        expect(csv).toContain('"subject: ""Q3, final""\nline two"')
        expect(csv).toContain(`"'=HYPERLINK(""https://evil.test"")"`)
        expect(csv).toContain(",'+cmd,")
        expect(csv).toContain("'@SUM(A1)")
        expect(csv).toContain("'-Ledger,")
        expect(csv).toContain('Allowed once by you,Ask first: sending to other people,GMAIL_SEND_EMAIL')
        // One header, two records: the quoted line break does not start a new record.
        expect(csv.match(/\r\n/g)).toHaveLength(3)
    })
})

describe('a decision from another part of the app', () => {
    it('fits the same shape a browser-action approval would use, and refuses anything else', () => {
        expect(desktopActivityDecisionSchema.parse({ outcome: 'declined-by-person', rule: 'ask-first:post', kind: 'post' })).toEqual({ outcome: 'declined-by-person', rule: 'ask-first:post', kind: 'post' })
        expect(desktopActivityDecisionSchema.safeParse({ outcome: 'allowed', rule: 'x' }).success).toBe(false)
        expect(desktopActivityDecisionSchema.safeParse({ outcome: 'failed', secret: 'x' }).success).toBe(false)
    })
})
