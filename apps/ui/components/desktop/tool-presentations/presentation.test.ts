import { expect, test } from 'vitest'
import { planDesktopToolPresentation } from './plan'
import { redactHistoricalText } from './redact'
import { selectDesktopHistoricalCard } from './select'
import { projectDesktopToolStatus, type DesktopHistoricalToolSource } from './status'

const KEY = `sk-${'a'.repeat(24)}`
const GH = `ghp_${'b'.repeat(24)}`
const SLACK = `xoxb-${'c'.repeat(24)}`
const BEARER = 'super-secret-token'
const PASSWORD = 'hunter2secret'
const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nABCDEFGHIJKLMNOP\n-----END PRIVATE KEY-----'
const context = { ownerId: 'agent-1', workspaceId: 'ws-1', runId: 'run-1' }

function part(extra: DesktopHistoricalToolSource): DesktopHistoricalToolSource {
    return { toolCallId: 'call-1', state: 'output-available', ...extra }
}

test('projects pending, running, succeeded, failed, cancelled, and unknown without promoting a lost acknowledgement', () => {
    expect(projectDesktopToolStatus(part({ state: 'approval-requested' }))).toBe('pending')
    expect(projectDesktopToolStatus(part({ state: 'approval-responded' }))).toBe('pending')
    expect(projectDesktopToolStatus(part({ state: 'input-streaming' }))).toBe('running')
    expect(projectDesktopToolStatus(part({ state: 'input-available' }))).toBe('running')
    expect(projectDesktopToolStatus(part({ state: 'output-available', preliminary: true }))).toBe('running')
    expect(projectDesktopToolStatus(part({ state: 'output-available', output: 'ok' }))).toBe('succeeded')
    expect(projectDesktopToolStatus(part({ state: 'output-error' }))).toBe('failed')
    expect(projectDesktopToolStatus(part({ state: 'output-denied' }))).toBe('failed')
    expect(projectDesktopToolStatus(part({ state: 'output-available', errorText: 'nope' }))).toBe('failed')
    expect(projectDesktopToolStatus(part({ state: 'output-available', output: { type: 'error-text', value: 'nope' } }))).toBe('failed')
    expect(projectDesktopToolStatus(part({ state: 'cancelled', output: 'Notification sent to the user.' }))).toBe('cancelled')
    expect(projectDesktopToolStatus(part({ state: 'output-available', acknowledgement: 'cancelled' }))).toBe('cancelled')
    expect(projectDesktopToolStatus({ toolCallId: 'call-1' })).toBe('unknown')
    expect(projectDesktopToolStatus(part({ state: 'mystery' }))).toBe('unknown')
    expect(projectDesktopToolStatus(part({ state: 'output-available', acknowledgement: 'lost' }))).toBe('unknown')
    expect(projectDesktopToolStatus(part({ state: 'output-available', acknowledgement: 'unknown' }))).toBe('unknown')
    expect(projectDesktopToolStatus(part({ state: 'output-available', acknowledgement: null }))).toBe('unknown')
    expect(projectDesktopToolStatus(part({ state: 'output-available', providerMetadata: { desktop: { acknowledgement: false } } }))).toBe('unknown')
    expect(projectDesktopToolStatus(part({ state: 'output-available', restarted: true }))).toBe('unknown')
    expect(projectDesktopToolStatus(part({ state: 'output-available', restarted: true, acknowledgement: 'recorded' }))).toBe('succeeded')
    expect(projectDesktopToolStatus(part({ state: 'output-available', ownerId: 'agent-2' }), context)).toBe('unknown')
    expect(projectDesktopToolStatus(part({ state: 'output-available', ownerId: 4 }))).toBe('unknown')
    expect(selectDesktopHistoricalCard(part({ type: 'tool-notify_user', state: 'output-available', acknowledgement: 'lost', input: { message: 'Ready' }, output: 'Notification sent to the user.' }))).toBeNull()
})

test('redacts credentials and bounds oversized historical text', () => {
    const raw = `key ${KEY} gh ${GH} slack ${SLACK} Bearer ${BEARER} cookie: session=abc password=${PASSWORD} https://user:pass@example.com/a ${PRIVATE_KEY}\n${'x'.repeat(5000)}`
    const clean = redactHistoricalText(raw)
    expect(clean).not.toContain(KEY)
    expect(clean).not.toContain(GH)
    expect(clean).not.toContain(SLACK)
    expect(clean).not.toContain(BEARER)
    expect(clean).not.toContain(PASSWORD)
    expect(clean).not.toContain('user:pass')
    expect(clean).not.toContain('BEGIN PRIVATE KEY')
    expect(clean).not.toContain('session=abc')
    expect(clean.endsWith('…')).toBe(true)
    expect(clean.length).toBe(2001)
    expect(clean.includes('x'.repeat(2001))).toBe(false)
})

test('selects only a recorded delivered notification, frozen MCP outcome, or brain change', () => {
    const delivered = selectDesktopHistoricalCard(part({ type: 'tool-notify_user', input: { message: `Ready ${KEY}` }, output: 'Notification sent to the user.' }), context)
    expect(delivered?.kind).toBe('notification')
    expect(JSON.stringify(delivered)).not.toContain(KEY)
    expect(delivered && 'message' in delivered && delivered.message).toBe('Ready [redacted]')
    expect(delivered && 'identity' in delivered && delivered.identity).toEqual({ ownerId: 'agent-1', workspaceId: 'ws-1', runId: 'run-1' })
    expect(selectDesktopHistoricalCard(part({ type: 'tool-notify_user', input: { message: 'Ready' }, output: 'Notification not delivered (hub unreachable). Continue without it.' }))).toBeNull()
    expect(selectDesktopHistoricalCard(part({ type: 'tool-notify_user', input: { message: 'Ready' }, output: { unexpected: true } }))).toBeNull()
    expect(selectDesktopHistoricalCard(part({ type: 'tool-notify_user', input: { message: '   ' }, output: 'Notification sent to the user.' }))).toBeNull()
    expect(selectDesktopHistoricalCard(part({ type: 'tool-notify_user', input: { message: 'x'.repeat(20_000) }, output: 'Notification sent to the user.' }))).toBeNull()
    const oversized = selectDesktopHistoricalCard(part({ type: 'tool-notify_user', input: { message: 'x'.repeat(5000) }, output: 'Notification sent to the user.' }))
    expect(oversized).toMatchObject({ kind: 'notification' })
    expect(oversized && 'message' in oversized && oversized.message.length).toBe(2001)
    expect(oversized && 'message' in oversized && oversized.message.endsWith('…')).toBe(true)

    const saved = selectDesktopHistoricalCard(part({ type: 'tool-mcp_register', input: { name: 'linear', url: 'https://user:pass@mcp.example.com/rpc' }, output: 'Saved linear.' }))
    expect(saved).toMatchObject({ kind: 'mcp', name: 'Linear', host: 'mcp.example.com', outcome: 'saved' })
    expect(JSON.stringify(saved)).not.toContain('user:pass')
    const failed = selectDesktopHistoricalCard(part({ type: 'tool-mcp_register', input: { name: 'linear', url: 'https://mcp.example.com/rpc' }, output: `Nothing was saved via remote: password=${PASSWORD}` }))
    expect(failed).toMatchObject({ kind: 'mcp', outcome: 'failed' })
    expect(JSON.stringify(failed)).not.toContain(PASSWORD)
    expect(selectDesktopHistoricalCard(part({ type: 'tool-mcp_login', input: { name: 'linear' }, output: 'No MCP server named linear' }))).toBeNull()
    expect(selectDesktopHistoricalCard(part({ type: 'tool-mcp_register', input: { name: 'linear' }, output: { nope: true } }))).toBeNull()

    const brain = selectDesktopHistoricalCard(part({
        type: 'tool-brain_write',
        output: JSON.stringify({ status: 'saved', slug: 'pricing', title: `Pricing ${KEY}`, mode: 'edit', undoRevisionId: 'rev-secret', hash: 'hash-secret' }),
    }))
    expect(brain).toMatchObject({ kind: 'brain-change', brainStatus: 'saved', showOpen: true, note: 'Saved. Every coworker reads it from its next run.' })
    expect(JSON.stringify(brain)).not.toContain(KEY)
    expect(JSON.stringify(brain)).not.toContain('rev-secret')
    expect(JSON.stringify(brain)).not.toContain('hash-secret')
    expect(selectDesktopHistoricalCard(part({ type: 'tool-brain_write', output: JSON.stringify({ status: 'saved', title: 'Pricing' }) }))).toBeNull()
    expect(selectDesktopHistoricalCard(part({ type: 'tool-brain_write', output: JSON.stringify({ status: 'saved', slug: 'pricing', title: 'y'.repeat(9000) }) }))).toBeNull()
    expect(selectDesktopHistoricalCard(part({ type: 'tool-card_file', output: '{"files":[]}' }))).toBeNull()
    expect(selectDesktopHistoricalCard(part({ type: 'tool-rerun_hub_service_install', output: '{"status":"needs_auth","slug":"slack","name":"Slack"}' }))).toBeNull()
    expect(selectDesktopHistoricalCard(part({ type: 'tool-rerun_hub_publish_file', output: '{"status":"published"}' }))).toBeNull()
    expect(selectDesktopHistoricalCard(part({ type: 'tool-paid_data', output: 'purchased' }))).toBeNull()
    expect(selectDesktopHistoricalCard(part({ type: 'tool-ask_user', output: 'waiting' }))).toBeNull()
})

test('groups generic steps, keeps existing presenters passthrough, and drops secrets from generic detail', () => {
    const blocks = planDesktopToolPresentation([
        part({ type: 'tool-exec', toolCallId: 'a', output: `Bearer ${BEARER}` }),
        part({ type: 'tool-read_secret', toolCallId: 'b', output: KEY }),
        part({ type: 'tool-card_file', toolCallId: 'file-1', output: '{"files":[]}' }),
        part({ type: 'tool-notify_user', toolCallId: 'note', input: { message: 'Ready' }, output: 'Notification sent to the user.' }),
        part({ type: 'tool-exec', toolCallId: 'c', workspaceId: 'ws-2', output: 'later' }),
        part({ type: 'tool-rerun_hub_service_install', toolCallId: 'hub', output: { status: 'needs_auth', slug: 'slack', name: 'Slack' } }),
        part({ type: 'tool-ask_user', toolCallId: 'question' }),
    ], context)
    expect(blocks.map(block => block.kind)).toEqual(['group', 'passthrough', 'card', 'group', 'group', 'passthrough'])
    expect(JSON.stringify(blocks)).not.toContain(BEARER)
    expect(JSON.stringify(blocks)).not.toContain(KEY)
    const first = blocks[0]
    expect(first.kind).toBe('group')
    if (first.kind === 'group') {
        expect(first.items[0].detail).toBe('Bearer [redacted]')
        expect(first.items[1].detail).toBeNull()
        expect(first.items[0].status).toBe('succeeded')
    }
    expect(blocks[2]).toMatchObject({ kind: 'card', card: { kind: 'notification' } })
    expect(blocks[3]).toMatchObject({ kind: 'group', items: [{ status: 'unknown', detail: null, identity: { ownerId: null, workspaceId: null, runId: null } }] })
    const hub = blocks.find(block => block.kind === 'group' && block.items.some(item => item.toolName === 'rerun_hub_service_install'))
    expect(hub?.kind).toBe('group')
    if (hub?.kind === 'group') expect(hub.items[0].status).toBe('succeeded')
})
