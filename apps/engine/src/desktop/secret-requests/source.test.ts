import { beforeEach, expect, test, vi } from 'vitest'
import { findDesktopSecretRequest, type DesktopSecretRequestRow } from '@rerun/contracts'
const fixture = vi.hoisted(() => ({ rows: [] as DesktopSecretRequestRow[], execute: vi.fn() }))
vi.mock('../../db/repos/messages.js', () => ({ listMessages: async () => fixture.rows }))
// These provenance fixtures are ordinary chats. Trigger-session Stop filtering is
// exercised against the real journal in triggers/human.test.ts.
vi.mock('../../db/repos/sessions.js', () => ({ getSession: async (agentId: string, id: string) => ({ agentId, id, source: 'dashboard' }) }))
vi.mock('../../db/systemDb.js', () => ({ getSystemDb: async () => ({ client: { execute: fixture.execute } }) }))
import { readDesktopSecretSource } from './source.js'
const input = { secrets: [{ key: 'EXAMPLE_API_KEY', label: 'Example key' }] }
const proof = () => ({ run_id: 'run', agent_id: 'engine-owner', session_id: 'engine-chat', tool_name: 'mcp__rerun__request_secret', input_json: JSON.stringify(input), is_error: 0, status: 'done' })
beforeEach(() => {
    fixture.execute.mockReset().mockResolvedValue({ rows: [proof()] })
    fixture.rows = [
        { id: 'call-row', role: 'assistant', contentJson: JSON.stringify([{ type: 'tool-call', toolCallId: 'call', toolName: 'request_secret', input }]) },
        { id: 'result-row', role: 'tool', contentJson: JSON.stringify([{ type: 'tool-result', toolCallId: 'call', output: { type: 'json', value: { status: 'delivered' } } }]) },
    ]
})
test('ties the delivered transcript to the exact logged source run and owner', async () => {
    expect(await readDesktopSecretSource('engine-owner', 'engine-chat')).toMatchObject({ guard: { runId: 'run', toolCallId: 'call', sourceMessageId: 'call-row' }, status: 'done' })
    expect(fixture.execute).toHaveBeenCalledWith(expect.objectContaining({ args: ['engine-owner', 'engine-chat', 'call'] }))
})
test.each([[], [proof(), { ...proof(), run_id: 'sibling-run' }], [{ ...proof(), is_error: 1 }], [{ ...proof(), input_json: JSON.stringify({ secrets: [{ key: 'ANOTHER_KEY', label: 'Another' }] }) }]].map(rows => ({ rows })))('rejects absent, ambiguous, failed or changed tool provenance', async ({ rows }) => {
    fixture.execute.mockResolvedValue({ rows })
    await expect(readDesktopSecretSource('engine-owner', 'engine-chat')).rejects.toMatchObject({ status: 409 })
})
test('historical recovery verifies the original call after a later user turn without making it pending again', async () => {
    const pending = findDesktopSecretRequest(fixture.rows)!
    const guard = { sourceMessageId: pending.sourceMessageId, toolCallId: pending.toolCallId, fingerprint: pending.fingerprint, runId: 'run' }
    fixture.rows.push({ id: 'followup', role: 'user', contentJson: 'Credential setup result' })
    expect(await readDesktopSecretSource('engine-owner', 'engine-chat')).toBeNull()
    expect(await readDesktopSecretSource('engine-owner', 'engine-chat', guard)).toMatchObject({ guard })
    await expect(readDesktopSecretSource('engine-owner', 'engine-chat', { ...guard, runId: 'other' })).rejects.toMatchObject({ status: 409 })
})
