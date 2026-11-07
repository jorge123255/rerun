import { describe, expect, it } from 'vitest'
import type { EngineMessage } from '@/lib/engine/types'
import { selectDesktopHistoricalCard } from '@/components/desktop/tool-presentations/select'
import { publicDesktopHistory, transformEngineMessages } from './engine-history'

const KEY = `sk-${'a'.repeat(24)}`
const SECRET = 'private-provider-password'
function saved(toolName: string, input: unknown, output: unknown): EngineMessage[] {
    const row = (id: string, role: EngineMessage['role'], content: unknown): EngineMessage => ({
        id, sessionId: 'engine-session-1', role, contentJson: JSON.stringify(content), toolCallsJson: null, createdAt: '2026-11-06T00:00:00Z',
    })
    return [
        row('call', 'assistant', [{ type: 'tool-call', toolName, toolCallId: 'historical-call', input }]),
        row('result', 'tool', [{ type: 'tool-result', toolName, toolCallId: 'historical-call', output }]),
    ]
}
function reopen(rows: EngineMessage[]) {
    const history = publicDesktopHistory(transformEngineMessages(rows, { desktopSummaries: true }))
    return { history, card: selectDesktopHistoricalCard(history[0].parts[0], { ownerId: 'agent-1' }) }
}

describe('real saved-history projection into historical card selection', () => {
    it('retains delivered notification presentation without retaining transport or replay data', () => {
        const rows = saved('mcp__rerun__notify_user', { message: `Ready ${KEY}`, token: SECRET, binding: { run: 'private-run' } }, { type: 'text', value: 'Notification sent to the user.' })
        const unchanged = JSON.stringify(rows)
        const { history, card } = reopen(rows)
        expect(card).toMatchObject({ kind: 'notification', message: 'Ready [redacted]', toolCallId: 'historical-call' })
        expect(JSON.stringify(history)).not.toContain(KEY)
        expect(JSON.stringify(history)).not.toContain(SECRET)
        expect(JSON.stringify(history)).not.toContain('private-run')
        expect(publicDesktopHistory(history)).toEqual(history)
        expect(JSON.stringify(rows)).toBe(unchanged)
    })

    it.each(['mcp_register', 'mcp_login'])('reopens a confirmed %s with only a name, host and recorded outcome', toolName => {
        const rows = saved(toolName, { name: 'linear', url: `https://user:password@mcp.example.com/rpc?token=${SECRET}`, headers: { authorization: `Bearer ${SECRET}` } }, 'Saved linear.')
        const { history, card } = reopen(rows)
        expect(card).toMatchObject({ kind: 'mcp', name: 'Linear', outcome: 'saved' })
        const text = JSON.stringify(history)
        expect(text).not.toContain(SECRET)
        expect(text).not.toContain('user:password')
        expect(text).not.toContain('headers')
        expect(text).not.toContain('/rpc')
        expect(publicDesktopHistory(history)).toEqual(history)
    })

    it('retains an explicit MCP refusal as Not added rather than promoting it to saved', () => {
        const { history, card } = reopen(saved('mcp_register', { name: 'linear' }, `Nothing was proposed or saved: password=${SECRET}`))
        expect(card).toMatchObject({ kind: 'mcp', outcome: 'failed' })
        expect(JSON.stringify(history)).not.toContain(SECRET)
    })

    it.each([
        JSON.stringify({ status: 'proposed', proposalId: 'proposal-only' }),
        'The server needs human review before it is saved.',
        'Open this authorization URL to finish sign-in.',
        'Server unavailable; no change was made.',
    ])('does not restore a proposal or unknown MCP result as Added: %s', output => {
        const { card } = reopen(saved('mcp_register', { name: 'linear' }, output))
        expect(!card || card.kind !== 'mcp' || card.outcome !== 'saved').toBe(true)
    })

    it.each(['brain_write', 'brain_delete', 'brain_decide'])('reopens %s using only safe change fields', toolName => {
        const status = toolName === 'brain_delete' ? 'deleted' : toolName === 'brain_decide' ? 'accepted' : 'saved'
        const { history, card } = reopen(saved(toolName, { content: SECRET }, { type: 'json', value: { status, slug: 'pricing', title: `Pricing ${KEY}`, mode: 'edit', agentName: 'Researcher', undoRevisionId: SECRET, hash: SECRET, content: SECRET, token: SECRET } }))
        expect(card).toMatchObject({ kind: 'brain-change', brainStatus: status })
        expect(JSON.stringify(history)).not.toContain(KEY)
        expect(JSON.stringify(history)).not.toContain(SECRET)
        expect(JSON.stringify(history)).not.toMatch(/undoRevisionId|"hash"|"content"|"token"/)
        expect(publicDesktopHistory(history)).toEqual(history)
    })

    it.each([
        { tool: 'notify_user', input: { message: 'Ready' }, output: 'Notification not delivered' },
        { tool: 'notify_user', input: { message: 'Ready' }, output: { type: 'error-text', value: 'Notification sent to the user.' } },
        { tool: 'brain_write', input: {}, output: { status: 'conflict', slug: 'pricing', title: 'Pricing' } },
        { tool: 'brain_write', input: {}, output: { status: 'saved', slug: '../private', title: 'Pricing' } },
    ])('does not turn unsupported $tool output into a successful restored card', ({ tool, input, output }) => {
        expect(reopen(saved(tool, input, output)).card).toBeNull()
    })
})
